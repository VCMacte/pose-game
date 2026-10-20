/**
 * Офлайн: два независимых кэша, проверка целостности вендора, сведения о
 * сборке.
 *
 * **Два отдельных наполнения, а не одно.** Атомарность должна работать по
 * отдельности: иначе правка одной строки кода заставляет перекачивать 17 МБ
 * вендора, а сбой на вендоре отменяет обновление кода. Отказ одного кэша не
 * рушит второй — и это свойство стоит под тестом.
 *
 * Логика вынесена в функции, принимающие `CacheStorage` аргументом: сам
 * service worker — десяток строк обвязки внизу файла, который в node не
 * исполняется. Иначе всё поведение офлайна проверялось бы только установкой на
 * телефон, а это как раз та среда, где отладки нет.
 *
 * Разбор: `docs/offline-and-build.md`.
 */

import { CODE_FILES, CODE_VERSION, VENDOR_VERSION } from './sw-manifest'
/*
 * Пути берутся из ЛИСТОВОГО модуля, а не из `pose/source`: оттуда в бандл
 * service worker'а уезжал весь конвейер позы, а с ним `log/store.ts`, где на
 * уровне модуля создаётся журнал. Список остаётся один — см. `./pose/vendor`.
 */
import { VENDOR } from './pose/vendor'

export const BUILD = Object.freeze({
  version: CODE_VERSION,
  vendorVersion: VENDOR_VERSION,
})

/**
 * Имена кэшей НЕСУТ версию. Иначе обновление кода читало бы старый кэш, и
 * офлайн показывал бы прошлую сборку при свежем коде — дефект, который на
 * машине разработчика не воспроизводится вовсе.
 */
export const CACHE = `pose-game-code-${BUILD.version}`
export const VENDOR_CACHE = `pose-game-vendor-${BUILD.vendorVersion}`

/**
 * Файлы вендора. Список известен заранее и из сборки НЕ выводится: это не
 * продукт Vite, а вложенные в репозиторий файлы, и имена у них постоянные.
 *
 * Пути берутся из того же `VENDOR`, которым источник позы их и грузит: две
 * копии списка разъехались бы, и приложение офлайн искало бы файл, которого в
 * кэше нет под этим именем.
 *
 * Варианта wasm без SIMD здесь нет намеренно (ещё 10.5 МБ): поддержка
 * спрашивается предикатом самой библиотеки до запуска.
 */
export const VENDOR_FILES = Object.freeze([
  `/${VENDOR.model}`,
  `/${VENDOR.bundleClassic}`,
  `/${VENDOR.bundleModule}`,
  `/${VENDOR.wasmBase}/vision_wasm_internal.js`,
  `/${VENDOR.wasmBase}/vision_wasm_internal.wasm`,
])

export type InstallResult = {
  /** Наполнился ли кэш кода. */
  code: boolean
  /** Наполнился ли кэш вендора. */
  vendor: boolean
}

/** Наполнить один кэш. Отказ возвращается, а не бросается. */
async function fill(caches: CacheStorage, name: string, urls: readonly string[]): Promise<boolean> {
  try {
    const c = await caches.open(name)
    await c.addAll([...urls])
    return true
  } catch {
    /*
     * Один недоступный файл валит весь `addAll` — так он и устроен. Поэтому
     * отказ ЛОВИТСЯ здесь, на уровне одного кэша: брошенный наружу, он отменил
     * бы установку service worker целиком, и приложение осталось бы вообще без
     * офлайна и без объяснения.
     */
    return false
  }
}

/**
 * Наполнить оба кэша. Независимо: отказ одного не мешает другому.
 *
 * Наружу не бросает НИКОГДА. Брошенное отсюда исключение отменяет установку
 * service worker, то есть превращает частичный офлайн в полное его отсутствие.
 */
export async function install(caches: CacheStorage): Promise<InstallResult> {
  const [code, vendor] = await Promise.all([
    fill(caches, CACHE, CODE_FILES),
    fill(caches, VENDOR_CACHE, VENDOR_FILES),
  ])
  return { code, vendor }
}

export type VendorCheck = { ok: boolean; missing: string[] }

/**
 * Все ли файлы вендора лежат в кэшах.
 *
 * Ищет по ВСЕМ кэшам, а не только в своём: файл мог осесть в кэше кода при
 * ручной правке списков, и «нет файла» и «файл лежит не там» — разные беды,
 * причём вторая офлайн не ломает.
 *
 * Отсутствие файла НАЗЫВАЕТСЯ, а не превращается в «скачаем на ходу»: офлайн —
 * обещание, и молча нарушенное обещание хуже честно названного отсутствия.
 * Служебный экран показывает, лежит ли модель в кэше.
 */
export async function checkVendor(caches: CacheStorage | null | undefined): Promise<VendorCheck> {
  if (!caches) return { ok: false, missing: [...VENDOR_FILES] }

  const missing: string[] = []
  for (const url of VENDOR_FILES) {
    try {
      const hit = await caches.match(url)
      if (!hit) missing.push(url)
    } catch {
      missing.push(url)
    }
  }
  return { ok: missing.length === 0, missing }
}

export type BuildInfo = { version: string; date: string }

/**
 * Номер сборки и дата для служебного экрана и для журнала.
 *
 * Без них невозможно понять, какую версию ребёнок на самом деле запустил:
 * установленное PWA обновляется само и молча, и журнал со «вчерашней» сборки
 * выглядит точно так же, как с сегодняшней.
 */
export function buildInfo(): BuildInfo {
  // Версия и есть отметка времени сборки (`ГГГГММДД-ЧЧММ`) — дата из неё
  // читается, а не хранится вторым полем, которое могло бы разъехаться.
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(BUILD.version)
  const date = m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : BUILD.version
  return { version: BUILD.version, date }
}

/** Старые кэши: всё, что не нынешняя пара. */
export async function dropOldCaches(caches: CacheStorage): Promise<string[]> {
  const dropped: string[] = []
  try {
    for (const name of await caches.keys()) {
      if (name === CACHE || name === VENDOR_CACHE) continue
      if (!name.startsWith('pose-game-')) continue
      await caches.delete(name)
      dropped.push(name)
    }
  } catch {
    // Не вышло убрать старое — не повод не работать на новом.
  }
  return dropped
}
