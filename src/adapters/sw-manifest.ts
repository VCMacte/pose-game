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
export const CODE_VERSION = '20261020-0915'

/**
 * Версия вендора. Поднимается ОТДЕЛЬНО (`node tools/make-sw.mjs --vendor`):
 * новое имя кэша вендора означает перекачку 17 МБ, и платить её при каждой
 * правке строки кода незачем.
 */
export const VENDOR_VERSION = '1'

/** Файлы кода для офлайн-кэша — ровно то, что сделала сборка. */
export const CODE_FILES = Object.freeze([
  '/pose-game/',
  '/pose-game/assets/index-ConU_Sbe.js',
  '/pose-game/assets/latency-ULF0EuNO.js',
  '/pose-game/assets/mic-Cq8UD9bY.js',
  '/pose-game/assets/source-M4YMTerg.js',
  '/pose-game/assets/sw-BNlQGIJD.js',
  '/pose-game/assets/worker-GqN618hL.js',
  '/pose-game/icon.svg',
  '/pose-game/manifest.webmanifest',
] as const)
