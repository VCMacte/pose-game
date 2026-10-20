/**
 * Наполнение офлайн-кэшей — ТОЛЬКО для service worker.
 *
 * **Отдельный модуль, потому что только он импортирует генерируемый список.**
 * Пока список импортировал `./sw.ts`, от списка зависел бандл ПРИЛОЖЕНИЯ, а
 * список — от имён чанков этого бандла: двухпроходная сборка переставала
 * сходиться, первый проход называл одни имена, второй делал другие, и прекэш
 * указывал на файлы, которых в сборке нет. Здесь эта зависимость обрывается:
 * список попадает только в `sw.js`, а `sw.js` в список не входит.
 *
 * **Два отдельных наполнения, а не одно.** Атомарность должна работать по
 * отдельности: иначе правка одной строки кода заставляет перекачивать 17 МБ
 * вендора, а сбой на вендоре отменяет обновление кода. Отказ одного кэша не
 * рушит второй — и это свойство стоит под тестом.
 *
 * Разбор: `docs/offline-and-build.md`.
 */

import { VENDOR_FILES } from './sw'
import { CODE_FILES, CODE_VERSION, VENDOR_VERSION } from './sw-manifest'

/**
 * Имена кэшей НЕСУТ версию. Иначе обновление кода читало бы старый кэш, и
 * офлайн показывал бы прошлую сборку при свежем коде — дефект, который на
 * машине разработчика не воспроизводится вовсе.
 *
 * Версия вендора отдельная: иначе каждая правка строки кода меняла бы имя
 * вендорного кэша, то есть ровно ту перекачку 17 МБ, от которой раздельность
 * и спасает.
 */
export const CACHE = `pose-game-code-${CODE_VERSION}`
export const VENDOR_CACHE = `pose-game-vendor-${VENDOR_VERSION}`

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
