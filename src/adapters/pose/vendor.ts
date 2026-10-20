/**
 * Пути вендора MediaPipe — ОТДЕЛЬНЫМ листовым модулем.
 *
 * Их нужны знать двое: источник позы (он их грузит) и service worker (он их
 * прекэширует). Пока они жили в `source.ts`, импорт из `sw.ts` тянул в бандл
 * воркера весь конвейер позы, а с ним — `log/store.ts`, где на уровне модуля
 * стоит `export const journal = makeJournal()`. То есть при каждом запуске
 * service worker создавался ещё один журнал, в контексте, который не пишет
 * ничего.
 *
 * Список при этом остаётся ОДИН: две копии разъехались бы, и приложение офлайн
 * искало бы файл, которого в кэше нет под этим именем.
 *
 * Разбор: `docs/offline-and-build.md`, `docs/camera-and-pose.md`.
 */

export const VENDOR = Object.freeze({
  /**
   * Каталог wasm для `FilesetResolver.forVisionTasks()`. Загрузчик сам
   * достраивает имя: `vision_wasm_internal.js` при поддержке SIMD и
   * `vision_wasm_nosimd_internal.js` без неё. Вариант без SIMD мы не кладём
   * (ещё 10.5 МБ), поэтому поддержку спрашиваем предикатом самой библиотеки
   * до запуска — см. `worker.ts`.
   */
  wasmBase: 'vendor/mediapipe/wasm',
  /**
   * Две сборки одной библиотеки, и обе нужны. Классическая (IIFE, кладёт
   * глобаль `Vision`) — для воркера: он обязан быть классическим. Модульная —
   * для пути `main`. Версия у них ОДНА: wasm и сборка должны быть из одного
   * набора, иначе падение приходит изнутри wasm и на дефект кода не похоже.
   */
  bundleClassic: 'vendor/mediapipe/vision_bundle.js',
  bundleModule: 'vendor/mediapipe/vision_bundle.mjs',
  model: 'models/pose_landmarker_lite.task',
} as const)
