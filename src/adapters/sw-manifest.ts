/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Править руками нельзя — пересоберите:
 *
 *     npm run build
 *
 * Разбор, почему именно так: `docs/offline-and-build.md`.
 */

/** Базовый путь публикации: с него начинается каждый адрес списка. */
export const BASE = '/pose-game/'

/** Версия кода: меняется каждой сборкой, вместе с именем кэша кода. */
export const CODE_VERSION = '20261020-0942'

/**
 * Версия вендора. Поднимается ОТДЕЛЬНО (`node tools/make-sw.mjs --vendor`):
 * новое имя кэша вендора означает перекачку 17 МБ, и платить её при каждой
 * правке строки кода незачем.
 */
export const VENDOR_VERSION = '1'

/** Файлы кода для офлайн-кэша — ровно то, что сделала сборка. */
export const CODE_FILES = Object.freeze([
  '/pose-game/',
  '/pose-game/assets/index-DW2m48MO.js',
  '/pose-game/assets/latency-4xXXVmhs.js',
  '/pose-game/assets/mic-BQHKidpA.js',
  '/pose-game/assets/source-BSQQV8ln.js',
  '/pose-game/assets/sw-Ddfu22-q.js',
  '/pose-game/assets/worker-GqN618hL.js',
  '/pose-game/icon.svg',
  '/pose-game/manifest.webmanifest',
] as const)
