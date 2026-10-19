/**
 * Воркер распознавания. **КЛАССИЧЕСКИЙ, не модульный** — и это не вкусовщина.
 *
 * MediaPipe грузит свой wasm-загрузчик так:
 *
 *     if (typeof importScripts != 'function') { ...создать <script>... }
 *     else importScripts(url)
 *
 * В модульном воркере `importScripts` не существует, а `document` — тем более,
 * поэтому загрузчик не выполняется, `ModuleFactory` не выставляется, и
 * `createFromOptions` падает с «ModuleFactory not set.». Это проверено в
 * проекте-предшественнике, а не выведено из документации. Отсюда и устройство
 * файла: MediaPipe подключается через `importScripts` (сборка-IIFE, кладёт
 * глобаль `Vision`), а наш собственный код приезжает сюда сборкой — Vite
 * собирает классический воркер в один IIFE, поэтому статический `import`
 * из `./pack` до рантайма не доживает и запрета не нарушает.
 *
 * Воркер намеренно не считает ничего сверх инференса: ни нормализации, ни
 * осей. Он отдаёт сырые 132 числа, и вся математика живёт в ядре, которое
 * проверяется из node. Десять килобайт в секунду — не та цена, ради которой
 * стоит терять проверяемость.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */

import { POSE, landmarkerOptions, looksLikeCpu, makeClock, packLandmarks, warmup } from './pack'
import type { Delegate, Landmarker } from './pack'
import { ERRORS_BEFORE_NEXT } from './pipelines'
import type { PipelineMode } from './pipelines'

// ───────────────────────── сообщения ─────────────────────────

/** Задание воркеру: что грузить, чем считать и откуда брать кадры. */
export type InitMsg = {
  type: 'init'
  mode: PipelineMode
  delegate: Delegate
  hz: number
  /** `performance.timeOrigin` главного потока — у воркера своё начало отсчёта. */
  mainTimeOrigin: number
  /** Классическая (IIFE) сборка MediaPipe: кладёт глобаль `Vision`. */
  bundleUrl: string
  /** Каталог wasm для `FilesetResolver.forVisionTasks()`. */
  wasmBase: string
  modelUrl: string
  /** Поток кадров для конвейера `stream`; передаётся как transferable. */
  stream?: unknown
}

export type ToWorker =
  | InitMsg
  | { type: 'frame'; bitmap: unknown }
  | { type: 'config'; hz: number }
  | { type: 'stop' }

export type FromWorker =
  | {
      type: 'ready'
      mode: PipelineMode
      delegate: Delegate
      initMs: number
      warmupMs: number | null
      looksLikeCpu: boolean | null
    }
  | { type: 'fail'; stage: string; name?: string; message: string }
  /** Одна ошибка инференса — ещё не отказ конвейера, но в журнал идёт. */
  | { type: 'pose.error'; stage: string; name: string; message: string; seq: number }
  | {
      type: 'pose'
      seq: number
      tCap: number
      tDone: number
      inferMs: number
      /** Сколько кадров отброшено троттлингом с прошлой позы. */
      dropped: number
      lm: Float32Array | null
      w: number | null
      h: number | null
    }
  /** Признак жизни: молчащий воркер иначе неотличим от работающего без поз. */
  | { type: 'beat'; busyFrac: number; dropped: number; p50: number; p95: number }
  | { type: 'stopped' }

// ───────────────────────── окружение воркера ─────────────────────────

declare function importScripts(...urls: string[]): void

/** `self` в воркере. Типы DOM и WebWorker несовместимы, поэтому — минимум. */
type WorkerScope = {
  postMessage(message: unknown, transfer?: unknown[]): void
  onmessage: ((e: { data: unknown }) => void) | null
  Vision?: {
    FilesetResolver: {
      isSimdSupported(): Promise<boolean>
      forVisionTasks(base: string): Promise<unknown>
    }
    PoseLandmarker: {
      createFromOptions(fileset: unknown, options: unknown): Promise<Landmarker>
    }
  }
}

const scope = self as unknown as WorkerScope

/**
 * Кадр в том виде, в каком он нам нужен: его можно закрыть и спросить размер.
 * `VideoFrame` держит размер в `display*`, `ImageBitmap` — в обычных полях.
 */
type Frameish = {
  close?: () => void
  displayWidth?: number
  displayHeight?: number
  width?: number
  height?: number
  /** Микросекунды у `VideoFrame`; у `ImageBitmap` поля нет. */
  timestamp?: number
}

/** Минимум от `ReadableStream`, который нужен конвейеру `stream`. */
type FrameReadable = {
  getReader(): { read(): Promise<{ value?: Frameish; done: boolean }> }
}

// ───────────────────────── состояние ─────────────────────────

let landmarker: Landmarker | null = null
let clock: ((ms: number) => number) | null = null
let hz = POSE.hz
let timeOffset = 0
let seq = 0

/** Ровно один кадр в полёте: больше одного здесь не лежит никогда. */
let pending: Frameish | null = null
let busy = false
let dropped = 0
let lastRun = 0
let errors = 0
let busyMs = 0
let beat: ReturnType<typeof setInterval> | null = null
const inferTimes: number[] = []

const now = (): number => performance.now() + timeOffset
const post = (msg: FromWorker, transfer?: unknown[]): void => scope.postMessage(msg, transfer ?? [])

/**
 * Закрывать кадр обязан КАЖДЫЙ путь выхода. Утёкшие кадры заставляют Chrome
 * вообще перестать отдавать кадры с дорожки, и выглядит это как «игра
 * зависла, а предпросмотр живой» — поломка, которую долго искать.
 */
function release(frame: Frameish | null | undefined): void {
  if (!frame) return
  try {
    frame.close?.()
  } catch {
    // уже закрыт — не беда
  }
}

/** Новый кадр вытесняет непосчитанный старый: свежесть важнее полноты. */
function offer(frame: Frameish | null | undefined): void {
  if (!frame) return
  if (pending) {
    release(pending)
    dropped++
  }
  pending = frame
  kick()
}

function kick(): void {
  if (busy || !pending || !landmarker || !clock) return

  const frame = pending
  pending = null

  // Ограничение частоты — ОТБРОСОМ, а не очередью. Очередь означала бы
  // задержку, растущую без предела: кадры приходят каждые 33 мс, инференс
  // занимает 80, и разница копится. Отброс даёт честную пониженную частоту.
  if (lastRun && performance.now() - lastRun < 1000 / hz) {
    release(frame)
    dropped++
    return
  }

  busy = true
  lastRun = performance.now()

  /*
   * Размер кадра едет вместе с позой, и это единственное место, где он
   * достоверен: MediaPipe нормирует `x` по ширине ИМЕННО ЭТОГО кадра, а
   * `track.getSettings()` умеет врать — в `run-game` он отдал портрет вместо
   * ландшафта, и игра встала на «повернись к телевизору» навсегда.
   */
  const w = frame.displayWidth ?? frame.width ?? null
  const h = frame.displayHeight ?? frame.height ?? null
  const tCap = typeof frame.timestamp === 'number' ? frame.timestamp / 1000 : now()

  const t0 = performance.now()
  let lm: Float32Array | null = null
  try {
    lm = packLandmarks(landmarker.detectForVideo(frame, clock(now())))
    errors = 0
  } catch (e) {
    errors++
    const err = e as { name?: string; message?: string }
    post({
      type: 'pose.error',
      stage: 'infer',
      name: err?.name ?? 'Error',
      message: String(err?.message ?? e),
      seq,
    })
  } finally {
    // Кадр освобождается здесь, а не на каждом из путей выше: `finally`
    // накрывает и успех, и исключение, и уже брошенную ошибку в `post`.
    release(frame)
    const dt = performance.now() - t0
    busyMs += dt
    inferTimes.push(dt)
    if (inferTimes.length > 100) inferTimes.shift()
    busy = false
  }

  post(
    {
      type: 'pose',
      seq: seq++,
      tCap,
      tDone: now(),
      inferMs: Math.round(performance.now() - t0),
      dropped,
      lm,
      w,
      h,
    },
    lm ? [lm.buffer] : [],
  )
  dropped = 0

  if (errors >= ERRORS_BEFORE_NEXT) {
    post({ type: 'fail', stage: 'infer', message: `${ERRORS_BEFORE_NEXT} ошибок инференса подряд` })
    errors = 0
  }

  // Пока считали, мог прийти следующий кадр — он и посчитается, один.
  kick()
}

async function pump(readable: FrameReadable): Promise<void> {
  const reader = readable.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    offer(value)
  }
  post({ type: 'fail', stage: 'stream', message: 'поток кадров закончился' })
}

function stopEverything(): void {
  if (beat !== null) {
    clearInterval(beat)
    beat = null
  }
  release(pending)
  pending = null
  try {
    landmarker?.close()
  } catch {
    // закрыть не вышло — воркер всё равно сейчас терминируют
  }
  landmarker = null
}

async function init(msg: InitMsg): Promise<void> {
  hz = msg.hz || hz
  /*
   * У воркера своё начало отсчёта — момент его создания. Без поправки каждая
   * межпоточная метка смещена на задержку запуска воркера, и это смещение
   * выглядит в точности как задержка инференса.
   */
  timeOffset = (msg.mainTimeOrigin ?? performance.timeOrigin) - performance.timeOrigin

  importScripts(msg.bundleUrl) // кладёт глобаль Vision
  const vision = scope.Vision
  if (!vision) {
    post({ type: 'fail', stage: 'bundle', message: 'сборка MediaPipe не положила глобаль Vision' })
    return
  }
  const { FilesetResolver, PoseLandmarker } = vision

  /*
   * Спрашиваем предикатом самой библиотеки: по нему она и решает, какой файл
   * попросить. Своя проверка могла бы с ним разойтись, и мы сказали бы «всё
   * хорошо», а она ушла бы за файлом без SIMD, которого мы не кладём.
   */
  if (!(await FilesetResolver.isSimdSupported())) {
    post({ type: 'fail', stage: 'wasm', message: 'устройство не поддерживает WASM SIMD' })
    return
  }

  const t0 = performance.now()
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase)
  landmarker = await PoseLandmarker.createFromOptions(
    fileset,
    landmarkerOptions(msg.modelUrl, msg.delegate),
  )
  const initMs = Math.round(performance.now() - t0)

  clock = makeClock()
  const warmupMs = warmup(landmarker, clock)

  post({
    type: 'ready',
    mode: msg.mode,
    delegate: msg.delegate,
    initMs,
    warmupMs,
    looksLikeCpu: looksLikeCpu(warmupMs),
  })

  beat = setInterval(() => {
    if (!landmarker) return
    const sorted = [...inferTimes].sort((a, b) => a - b)
    post({
      type: 'beat',
      busyFrac: Math.min(1, busyMs / 1000),
      dropped,
      p50: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0,
      p95: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]) : 0,
    })
    busyMs = 0
  }, 1000)

  if (msg.stream) await pump(msg.stream as FrameReadable)
}

scope.onmessage = async (e: { data: unknown }): Promise<void> => {
  const msg = e.data as ToWorker

  if (msg.type === 'init') {
    try {
      await init(msg)
    } catch (err) {
      const x = err as { stage?: string; name?: string; message?: string }
      post({
        type: 'fail',
        stage: x?.stage ?? 'model',
        name: x?.name ?? 'Error',
        message: String(x?.message ?? err),
      })
    }
    return
  }

  if (msg.type === 'frame') {
    offer(msg.bitmap as Frameish)
    return
  }

  if (msg.type === 'config') {
    hz = msg.hz || hz
    return
  }

  if (msg.type === 'stop') {
    stopEverything()
    post({ type: 'stopped' })
  }
}
