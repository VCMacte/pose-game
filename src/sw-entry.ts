/// <reference lib="webworker" />
/**
 * Сам service worker — тонкая обвязка над `adapters/sw.ts`.
 *
 * Логика (что в какой кэш, что считать целым, как читать версию) живёт в
 * `adapters/sw.ts` и проверяется тестами. Здесь — только события, которых в
 * node не существует. Разделение именно такое, потому что иначе всё поведение
 * офлайна проверялось бы установкой на телефон, а это ровно та среда, где
 * отладки нет.
 *
 * Разбор: `docs/offline-and-build.md`.
 */

import { CACHE, VENDOR_CACHE, dropOldCaches, install } from './adapters/sw'

const sw = self as unknown as ServiceWorkerGlobalScope

sw.addEventListener('install', (e) => {
  const ev = e as ExtendableEvent
  /*
   * `install` не бросает НИКОГДА — `install()` ловит отказ каждого кэша
   * отдельно. Брошенное отсюда исключение отменило бы установку целиком, то
   * есть превратило бы частичный офлайн в полное его отсутствие.
   */
  ev.waitUntil(
    install(caches).then(() => {
      // Новый worker берёт управление сразу: ждать закрытия всех вкладок на
      // телефоне, где вкладка одна и её не закрывают, значит не обновиться.
      void sw.skipWaiting()
    }),
  )
})

sw.addEventListener('activate', (e) => {
  const ev = e as ExtendableEvent
  ev.waitUntil(
    dropOldCaches(caches).then(() => sw.clients.claim()),
  )
})

sw.addEventListener('fetch', (e) => {
  const ev = e as FetchEvent
  const req = ev.request
  if (req.method !== 'GET') return

  /*
   * Кэш ВПЕРЁД сети, а не наоборот. Игра обязана работать офлайн после
   * установки, и единственный честный способ это обеспечить — отдавать из
   * кэша, не спрашивая сеть: «сначала сеть, потом кэш» на плохом Wi-Fi даёт
   * секунды ожидания там, где файл уже лежит рядом.
   */
  ev.respondWith(
    (async (): Promise<Response> => {
      const hit = await caches.match(req)
      if (hit) return hit

      try {
        const res = await fetch(req)
        /*
         * Доложить в кэш КОДА, а не в вендорный: вендор наполняется только
         * установкой, и попавший в него случайный файл сделал бы его версию
         * ложью о содержимом.
         */
        if (res.ok && new URL(req.url).origin === sw.location.origin) {
          const c = await caches.open(CACHE)
          void c.put(req, res.clone())
        }
        return res
      } catch {
        /*
         * Офлайн и файла нет. Для навигации отдаём корень — приложение
         * одностраничное, и любой его маршрут это тот же корень. Для
         * остального — честная ошибка, а не пустой ответ, который выглядел бы
         * как успешно загруженный пустой файл.
         */
        if (req.mode === 'navigate') {
          const root = await caches.match('/')
          if (root) return root
        }
        return new Response('офлайн и в кэше нет', { status: 504 })
      }
    })(),
  )
})

// Имя вендорного кэша упомянуто, чтобы сборщик не вычистил импорт: он нужен
// `dropOldCaches`, который щадит именно нынешнюю пару.
void VENDOR_CACHE
