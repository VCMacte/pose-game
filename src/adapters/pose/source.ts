/**
 * Источник позы: единственное место, где решается, откуда берутся 33 точки.
 *
 * Шов для синтетики ровно один — ветка в `startPoseSource()`. Так сделано
 * нарочно: тестовый путь не должен проникать в рабочий дальше одного условия,
 * иначе проверяешь уже не то, что поедет на телефон.
 *
 * Камера и синтетический игрок приходят сюда ЗАВИСИМОСТЯМИ, а не импортом
 * (`openCamera` из задачи 16, `fakeFrames` из задачи 14): оболочка знает, что
 * из них подключать, а источник позы — как ими пользоваться. Попутно это
 * оставляет MediaPipe за динамическим импортом: семнадцать мегабайт вендора не
 * грузятся ради синтетического прогона.
 *
 * Диагностика у этого файла одна — журнал: телефон на штативе, консоли нет.
 * Всё, что здесь не записано, не существует.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */

import type { Frame } from '../../core/types'
import {
  camEnded,
  camFail,
  poseBoot,
  poseError,
  poseFail,
  posePipelineDown,
  poseReady,
  poseSource,
} from '../log/events'
import type { PipelineDownWhy } from '../log/events'
import { write } from '../log/store'
import { withTimeout } from '../promise'
import { POSE, landmarkerOptions, looksLikeCpu, makeClock, packLandmarks, warmup } from './pack'
import type { Delegate, Landmarker } from './pack'
import {
  ERRORS_BEFORE_NEXT,
  PIPELINES,
  makeErrorRun,
  makeLadder,
  parsePipelineFlag,
  pipelineFlagValue,
  pipelineId,
} from './pipelines'
import type { Pipeline } from './pipelines'
import type { FromWorker, InitMsg } from './worker'
import { makeTrackClock } from './track-clock'
import { FAKE_FRAME } from '../../fake/flag'

/** Абсолютный адрес файла вендора: воркер не умеет разрешать относительные. */
const at = (path: string): string =>
  typeof document === 'undefined' ? path : new URL(path, document.baseURI).href

/**
 * Вендор лежит в `public/` и прекэшируется — игра обязана работать офлайн, а
 * модель и wasm вместе весят семнадцать мегабайт.
 * → `docs/offline-and-build.md`
 */
/*
 * Пути вендора живут в ЛИСТОВОМ модуле и переэкспортируются отсюда для
 * совместимости: их нужны знать и источник позы, и service worker, а импорт
 * из этого файла тянул в бандл воркера весь конвейер позы вместе с журналом.
 */
export { VENDOR } from './vendor'
import { VENDOR } from './vendor'

// ───────────────────────── контракт ─────────────────────────

/** Что известно про кадр сверх самих точек. */
export type SampleMeta = {
  seq: number
  /** Когда кадр снят, шкала главного потока. По нему судят. */
  tCap: number
  /** Когда поза посчитана: разница с `tCap` и есть задержка распознавания. */
  tDone: number
  inferMs: number
  /** Кадров отброшено троттлингом с прошлой позы. */
  dropped: number
  /**
   * Размер ТОГО кадра, по которому считали, — единственное достоверное место,
   * откуда берётся отношение сторон: `track.getSettings()` умеет врать.
   */
  w: number | null
  h: number | null
  pipeline: string | null
}

export type SourceStatus =
  | {
      kind: 'ready'
      source: 'camera' | 'fake'
      pipeline: string | null
      delegate: Delegate | null
      initMs: number | null
      warmupMs: number | null
      looksLikeCpu: boolean | null
      /** Предпросмотр для рендера; у синтетики его нет. */
      video: HTMLVideoElement | null
      script?: string
    }
  /**
   * Ступень лестницы сошла — следующая попытка уже идёт. `why` различает три
   * случая ПОЛЕМ (`unsupported` / `open` / `died`), а не прозой в `message`:
   * см. `pose.pipeline.down` в `../log/events`.
   */
  | { kind: 'down'; pipeline: string; why: PipelineDownWhy; message: string }
  /** Лестница кончилась: поз не будет, и об этом надо сказать вслух. */
  | { kind: 'exhausted'; message: string }
  | { kind: 'beat'; busyFrac: number; dropped: number; p50: number; p95: number }
  | { kind: 'camera-lost'; why: 'ended' | 'mute' }

/** Минимум, который источник позы требует от камеры (задача 16). */
export type CameraHandle = {
  stream: MediaStream
  stop?: () => void
}

export type OpenCamera = () => Promise<CameraHandle>

/** Кадры синтетического игрока (задача 14). */
export type FakeFrames = (script: string, hz: number) => AsyncIterable<Frame>

export type PoseSourceOpts = {
  source: 'camera' | 'fake'
  hz?: number
  onSample(f: Frame, meta: SampleMeta): void
  onStatus(s: SourceStatus): void
  /** Принудительный конвейер: строка запроса или само значение `?pipeline=`. */
  pipeline?: string | null
  /** Сценарий синтетического игрока. */
  script?: string
  openCamera?: OpenCamera
  fakeFrames?: FakeFrames
}

/** Остановить источник. Звать можно повторно — второй раз ничего не делает. */
export type Stop = () => Promise<void>

// ───────────────────────── вспомогательное ─────────────────────────

/*
 * Потолок ожидания (`withTimeout`) живёт в `../promise.ts`: тот же сторож
 * нужен привилегированным обещаниям браузера, а две копии однажды разойдутся
 * числами.
 */

const says = (e: unknown): string => {
  const x = e as { message?: string } | null
  return String(x?.message ?? e)
}

/** `MediaStreamTrackProcessor` есть не везде — наличие проверяется, а не ждётся. */
type FrameProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: unknown }

const frameProcessor = (): FrameProcessorCtor | undefined =>
  (globalThis as { MediaStreamTrackProcessor?: FrameProcessorCtor }).MediaStreamTrackProcessor

// ───────────────────────── источник ─────────────────────────

/**
 * Запускает поток поз. `onSample` получает кадр ядра (`{ t, lm }`) и
 * метаданные — одинаковые у камеры и у синтетики, чтобы оболочка не знала,
 * откуда кадр приехал.
 */
export async function startPoseSource(opts: PoseSourceOpts): Promise<Stop> {
  const hz = opts.hz ?? POSE.hz
  if (opts.source === 'fake') return startFake(opts, hz)
  return startCamera(opts, hz)
}

/**
 * Синтетика. Ни воркера, ни лестницы: кадры уже посчитаны, и единственное, что
 * здесь есть, — остановка посреди итерации.
 */
async function startFake(opts: PoseSourceOpts, hz: number): Promise<Stop> {
  const script = opts.script ?? 'still'
  const frames = opts.fakeFrames
  if (!frames) {
    const message = 'синтетический игрок не подключён'
    write(poseFail({ pipeline: 'fake', message }))
    opts.onStatus({ kind: 'exhausted', message })
    return async () => {}
  }

  let stopped = false
  let seq = 0
  /*
   * Синтетические кадры нумеруются от НУЛЯ, а тик экрана приходит из
   * `requestAnimationFrame`, то есть из `performance.now()`. Без поправки
   * кадры оказываются в далёком прошлом относительно тика и не попадают в
   * окно судейства никогда: игра идёт, и ничего не засчитывается. Это та же
   * ловушка часов, что увела первый живой прогон, только зеркальная — и
   * выглядела бы она дефектом игры, а не стенда.
   *
   * Сдвигается НАЧАЛО отсчёта, а не темп: шаг между кадрами сохраняется.
   */
  const clock = makeTrackClock()

  const pump = async (): Promise<void> => {
    for await (const frame of frames(script, hz)) {
      if (stopped) return
      const t = clock.at(frame.t, performance.now())
      opts.onSample(
        { ...frame, t },
        {
          seq: seq++,
          tCap: t,
          tDone: t,
          inferMs: 0,
          dropped: 0,
          // Размер синтетика обязана называть так же, как камера: без него
          // отношения сторон нет, геометрия не считает, и экран остаётся с
          // «Ищу камеру» навсегда — то есть стенд выглядит мёртвой камерой.
          w: FAKE_FRAME.w,
          h: FAKE_FRAME.h,
          pipeline: 'fake',
        },
      )
    }
  }

  void pump().catch((e) => {
    write(poseFail({ pipeline: 'fake', message: says(e) }))
  })

  write(poseSource({ source: 'fake', hz, ladder: ['fake'], script }))
  write(poseReady({ pipeline: 'fake', delegate: 'CPU', warmupMs: null, source: 'fake', script }))
  opts.onStatus({
    kind: 'ready',
    source: 'fake',
    pipeline: 'fake',
    delegate: null,
    initMs: null,
    warmupMs: null,
    looksLikeCpu: null,
    video: null,
    script,
  })

  return async () => {
    stopped = true
  }
}

/** Одна открытая ступень лестницы. */
type Attempt = {
  pipeline: Pipeline
  initMs: number | null
  warmupMs: number | null
  looksLikeCpu: boolean | null
  delegate: Delegate
  stop(): Promise<void>
}

async function startCamera(opts: PoseSourceOpts, hz: number): Promise<Stop> {
  const open = opts.openCamera
  if (!open) {
    const message = 'камера не подключена к источнику позы'
    write(poseFail({ pipeline: 'camera', message }))
    opts.onStatus({ kind: 'exhausted', message })
    return async () => {}
  }

  const cam = await open()
  const track = cam.stream.getVideoTracks()[0] ?? null

  /*
   * Android отбирает камеру на входящем звонке, и приходит это не ошибкой, а
   * событием дорожки. Молча это выглядит как «игра перестала видеть ребёнка».
   */
  const lost = (why: 'ended' | 'mute') => (): void => {
    write(camEnded({ why }))
    opts.onStatus({ kind: 'camera-lost', why })
  }
  const onEnded = lost('ended')
  const onMute = lost('mute')
  track?.addEventListener('ended', onEnded)
  track?.addEventListener('mute', onMute)

  const video = document.createElement('video')
  video.playsInline = true
  video.muted = true
  video.srcObject = cam.stream

  /*
   * Отказ `play()` — отказ камеры, а не исключение наружу: наверху ждёт
   * оболочка, которой нужен СТАТУС, а не брошенная ошибка. Бросить её значило
   * бы вдобавок оставить открытую дорожку и слежение за ней висеть — то есть
   * горящий индикатор камеры при игре, которая камеру не видит.
   */
  try {
    await withTimeout(Promise.resolve(video.play()), 5000, 'video.play')
  } catch (e) {
    const err = e as { name?: string; message?: string }
    write(camFail({ name: err?.name ?? 'Error', message: says(e) }))
    track?.removeEventListener('ended', onEnded)
    track?.removeEventListener('mute', onMute)
    cam.stop?.()
    for (const t of cam.stream.getTracks()) t.stop()
    video.srcObject = null
    opts.onStatus({ kind: 'exhausted', message: `видео не запустилось: ${says(e)}` })
    return async () => {}
  }

  const flag = opts.pipeline ?? (typeof location === 'undefined' ? null : location.search)
  const forced = parsePipelineFlag(flag)
  const asked = pipelineFlagValue(flag)
  const list = forced ?? PIPELINES

  /*
   * Отвергнутое значение `?pipeline=` НАЗЫВАЕТСЯ. Опечатка — и `main/CPU`,
   * которого в лестнице нет намеренно, — дают тот же `null`, что и отсутствие
   * флага, и без этой записи на штативе остаётся «мой принудительный выбор
   * проигнорировали, а почему — непонятно». Пропускать выбор молча нельзя
   * именно там, где его делают руками ради одной проверки.
   */
  write(
    poseSource({
      source: 'camera',
      hz,
      ladder: list.map(pipelineId),
      ...(forced && asked ? { forced: asked } : {}),
      ...(!forced && asked ? { rejected: asked } : {}),
    }),
  )

  const ladder = makeLadder(list)

  let stopped = false
  let seq = 0
  let active: Attempt | null = null
  /** Переход по лестнице уже идёт: второй отказ не вправе начать второй. */
  let switching = false

  /**
   * Имя конвейера приходит сюда аргументом, а не берётся из `active`: кадр,
   * посчитанный гаснущей ступенью, успевает прийти уже после того, как
   * `active` обнулён, и записался бы конвейером `null` — то есть журнал врал
   * бы ровно в том месте, ради которого он и ведётся.
   */
  const emit = (
    id: string,
    lm: Float32Array | null,
    meta: Omit<SampleMeta, 'seq' | 'pipeline'>,
  ): void => {
    if (stopped) return
    opts.onSample({ t: meta.tCap, lm }, { ...meta, seq: seq++, pipeline: id })
  }

  /**
   * Ступень сошла: журнал и статус — одной строкой, чтобы не разошлись.
   *
   * `why` обязателен: «браузер не умеет этот путь», «путь не открылся» и
   * «путь умер уже после `ready`» — три разных события для разбора журнала, и
   * различаться они обязаны полем. Собранные в один `pose.fail` с русской
   * прозой в `message`, они различались бы только грепом по тексту.
   */
  const down = (p: Pipeline, why: PipelineDownWhy, message: string): null => {
    write(posePipelineDown({ pipeline: pipelineId(p), why, message }))
    opts.onStatus({ kind: 'down', pipeline: pipelineId(p), why, message })
    return null
  }

  // ── лестница отказов ──
  // Каждая сошедшая ступень пишется в журнал: иначе «почему-то медленно»
  // невозможно отличить от «GPU не завёлся и всё считается на процессоре».
  const climb = async (): Promise<void> => {
    while (!stopped) {
      const p = ladder.current()
      if (!p) {
        const message = 'лестница конвейеров исчерпана'
        opts.onStatus({ kind: 'exhausted', message })
        return
      }

      write(poseBoot({ pipeline: pipelineId(p), index: ladder.index(), delegate: p.delegate }))

      let attempt: Attempt | null = null
      try {
        attempt = p.mode === 'main' ? await startMain(p) : await startWorker(p)
      } catch (e) {
        attempt = down(p, 'open', says(e))
      }

      if (attempt) {
        active = attempt
        if (stopped) {
          // Пока поднимались, игру успели остановить: ступень не бросаем.
          await attempt.stop()
          return
        }
        write(
          poseReady({
            pipeline: pipelineId(p),
            delegate: attempt.delegate,
            warmupMs: attempt.warmupMs,
            initMs: attempt.initMs,
            looksLikeCpu: attempt.looksLikeCpu,
            source: 'camera',
          }),
        )
        opts.onStatus({
          kind: 'ready',
          source: 'camera',
          pipeline: pipelineId(p),
          delegate: attempt.delegate,
          initMs: attempt.initMs,
          warmupMs: attempt.warmupMs,
          looksLikeCpu: attempt.looksLikeCpu,
          video,
        })
        return
      }

      if (ladder.onDown() === 'exhausted') {
        const message = 'лестница конвейеров исчерпана'
        opts.onStatus({ kind: 'exhausted', message })
        return
      }
    }
  }

  /**
   * Конвейер сошёл уже после `ready` — пять ошибок инференса подряд, конец
   * потока кадров, смерть воркера. Текущая ступень гасится ЦЕЛИКОМ, и только
   * потом поднимается следующая: два живых распознавателя на одном Adreno 619
   * не ускорят ничего.
   */
  const fell = async (message: string): Promise<void> => {
    if (stopped || switching) return
    switching = true
    const p = ladder.current()
    if (p) down(p, 'died', message)
    const dying = active
    active = null
    if (dying) await dying.stop()
    const step = ladder.onDown()
    switching = false
    if (step === 'exhausted') {
      opts.onStatus({ kind: 'exhausted', message: 'лестница конвейеров исчерпана' })
      return
    }
    await climb()
  }

  /** Воркерные конвейеры: `stream` и `bitmap`. */
  async function startWorker(p: Pipeline): Promise<Attempt | null> {
    // Возможности браузера ПРОВЕРЯЮТСЯ, а не предполагаются, и пропущенная по
    // их отсутствию ступень тоже пишется в журнал: иначе «почему-то сразу
    // bitmap» не отличить от «stream пробовали и он упал».
    if (typeof Worker === 'undefined') return down(p, 'unsupported', 'нет Worker')
    if (!track) return down(p, 'unsupported', 'в потоке камеры нет видеодорожки')
    if (p.mode === 'stream' && !frameProcessor()) {
      return down(p, 'unsupported', 'нет MediaStreamTrackProcessor')
    }
    if (p.mode === 'bitmap' && typeof createImageBitmap !== 'function') {
      return down(p, 'unsupported', 'нет createImageBitmap')
    }

    // Воркер КЛАССИЧЕСКИЙ, не модульный: MediaPipe выполняет свой
    // wasm-загрузчик через `importScripts`, которого в модульном воркере нет,
    // и падает с «ModuleFactory not set.».
    const w = new Worker(new URL('./worker.ts', import.meta.url))

    let frameTimer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false
    let killed = false
    /*
     * Сторож признака жизни. Воркер умеет умереть НЕ бросив `error` — на
     * целевом телефоне его убивает Android по памяти, — и тогда `bitmap` ждал
     * бы подтверждения кадра вечно, `stream` молчал бы, а лестница не
     * двинулась бы ни на ступень. Признак жизни — ЛЮБОЕ сообщение воркера:
     * `beat` идёт таймером раз в секунду независимо от кадров, так что
     * замолчавшая камера (кадров нет, `beat` есть) под потолок не попадает,
     * а умерший воркер попадает. Разбор потолка — `POSE.aliveTimeoutMs`.
     */
    let aliveTimer: ReturnType<typeof setTimeout> | null = null
    /** Клон дорожки для `stream`: гаснет вместе со ступенью, иначе камера
        остаётся занятой, а индикатор — горящим при мёртвом конвейере. */
    let clone: MediaStreamTrack | null = null

    const teardown = async (): Promise<void> => {
      if (killed) return
      killed = true
      if (frameTimer !== null) clearTimeout(frameTimer)
      if (aliveTimer !== null) clearTimeout(aliveTimer)
      aliveTimer = null
      w.onmessage = null
      w.onerror = null
      try {
        w.postMessage({ type: 'stop' })
      } catch {
        // воркер уже мёртв — терминируем и идём дальше
      }
      w.terminate()
      clone?.stop()
      clone = null
    }

    const ready = new Promise<FromWorker>((resolve) => {
      w.onmessage = (e: MessageEvent): void => {
        const m = e.data as FromWorker
        if (m.type === 'ready' || m.type === 'fail') {
          resolve(m)
          return
        }
      }
      w.onerror = (e: ErrorEvent): void => {
        resolve({ type: 'fail', stage: 'worker', message: String(e.message || e.type) })
      }
    })

    const init: InitMsg = {
      type: 'init',
      mode: p.mode,
      delegate: p.delegate,
      hz,
      mainTimeOrigin: performance.timeOrigin,
      bundleUrl: at(VENDOR.bundleClassic),
      wasmBase: at(VENDOR.wasmBase),
      modelUrl: at(VENDOR.model),
    }

    if (p.mode === 'stream') {
      const Processor = frameProcessor()!
      /*
       * Дорожка клонируется: оригинал остаётся на `<video>` для предпросмотра
       * и для запасного пути, и вопрос «можно ли одной дорожкой кормить и то и
       * другое» просто не возникает.
       */
      clone = track.clone()
      const readable = new Processor({ track: clone }).readable
      init.stream = readable
      w.postMessage(init, [readable as Transferable])
    } else {
      w.postMessage(init)
    }

    let res: FromWorker
    try {
      res = await withTimeout(ready, POSE.initTimeoutMs, `init ${pipelineId(p)}`)
    } catch (e) {
      await teardown()
      return down(p, 'open', says(e))
    }

    if (res.type !== 'ready') {
      await teardown()
      return down(
        p,
        'open',
        res.type === 'fail' ? `${res.stage}: ${res.message}` : 'воркер не ответил ready',
      )
    }

    /** Сторож взводится заново на каждом сообщении: молчание и есть смерть. */
    const alive = (): void => {
      if (aliveTimer !== null) clearTimeout(aliveTimer)
      if (killed || stopped) return
      aliveTimer = setTimeout(() => {
        aliveTimer = null
        void fell(`воркер молчит дольше ${POSE.aliveTimeoutMs} мс`)
      }, POSE.aliveTimeoutMs)
    }

    // Рабочий обмен сообщениями: `ready` уже получен, дальше идут позы.
    w.onmessage = (e: MessageEvent): void => {
      const m = e.data as FromWorker
      alive()
      if (m.type === 'pose') {
        inFlight = false
        emit(pipelineId(p), m.lm, {
          tCap: m.tCap,
          tDone: m.tDone,
          inferMs: m.inferMs,
          dropped: m.dropped,
          w: m.w,
          h: m.h,
        })
        return
      }
      if (m.type === 'drop') {
        // Позы по кадру не будет, но подтверждение пришло: иначе конвейер
        // `bitmap` ждал бы его вечно и встал бы при живом воркере.
        inFlight = false
        return
      }
      if (m.type === 'beat') {
        opts.onStatus({ kind: 'beat', busyFrac: m.busyFrac, dropped: m.dropped, p50: m.p50, p95: m.p95 })
        return
      }
      if (m.type === 'pose.error') {
        /*
         * Одна ошибка — ещё НЕ отказ: лестницу не двигаем. И событие своё, не
         * `pose.fail`: иначе разбор журнала читал бы одиночный закрытый кадр
         * как сошедшую ступень. Счёт до пяти подряд ведёт воркер, он же и
         * пришлёт `fail`.
         */
        write(
          poseError({
            pipeline: pipelineId(p),
            stage: m.stage,
            name: m.name,
            message: m.message,
            seq: m.seq,
          }),
        )
        return
      }
      if (m.type === 'fail') {
        void fell(`${m.stage}: ${m.message}`)
      }
    }
    w.onerror = (e: ErrorEvent): void => {
      void fell(`worker: ${String(e.message || e.type)}`)
    }

    /*
     * Сторож взводится СРАЗУ, а не с первого сообщения: воркер, умерший сразу
     * после `ready`, не пришлёт ни одного — а это ровно тот случай, ради
     * которого сторож и поставлен.
     */
    alive()

    if (p.mode === 'bitmap') {
      /*
       * Поток управления — ПОДТВЕРЖДЕНИЕ от воркера: новый кадр снимается
       * только после того, как предыдущий посчитан. Иначе главный поток копит
       * битмапы быстрее, чем воркер их считает.
       */
      const grab = async (): Promise<void> => {
        if (killed || stopped) return
        if (!inFlight && video.videoWidth) {
          inFlight = true
          let bmp: ImageBitmap | null = null
          try {
            bmp = await createImageBitmap(video)
          } catch {
            inFlight = false
          }
          if (bmp) {
            if (killed || stopped) {
              // Кадр снят, но ступень уже гасится — закрыть обязаны мы.
              bmp.close()
              return
            }
            try {
              w.postMessage({ type: 'frame', bitmap: bmp }, [bmp])
            } catch {
              bmp.close()
              inFlight = false
            }
          }
        }
        if (killed || stopped) return
        frameTimer = setTimeout(() => void grab(), 1000 / hz)
      }
      void grab()
    }

    return {
      pipeline: p,
      delegate: res.delegate,
      initMs: res.initMs,
      warmupMs: res.warmupMs,
      looksLikeCpu: res.looksLikeCpu,
      stop: teardown,
    }
  }

  /**
   * Последний запасной путь: инференс на главном потоке. ЦЕПОЧКОЙ ТАЙМАУТОВ,
   * а не из `requestAnimationFrame` — синхронный блок внутри кадра превращает
   * потерю одного кадра в потерю двух.
   */
  async function startMain(p: Pipeline): Promise<Attempt | null> {
    const vision = (await import(/* @vite-ignore */ at(VENDOR.bundleModule))) as {
      FilesetResolver: {
        isSimdSupported(): Promise<boolean>
        forVisionTasks(base: string): Promise<unknown>
      }
      PoseLandmarker: { createFromOptions(fileset: unknown, options: unknown): Promise<Landmarker> }
    }

    if (!(await vision.FilesetResolver.isSimdSupported())) {
      throw new Error('устройство не поддерживает WASM SIMD')
    }

    const t0 = performance.now()
    const fileset = await vision.FilesetResolver.forVisionTasks(at(VENDOR.wasmBase))
    const landmarker = await vision.PoseLandmarker.createFromOptions(
      fileset,
      landmarkerOptions(at(VENDOR.model), p.delegate),
    )
    const initMs = Math.round(performance.now() - t0)

    const clock = makeClock()
    /*
     * Прогрев кормит часы ТЕМ ЖЕ источником времени, что и живой инференс.
     * На главном потоке это просто `performance.now()` — поправки нет, в
     * отличие от воркера, — но передаётся он всё равно снаружи: расхождение
     * двух баз времени `VIDEO`-режим MediaPipe не объявляет, оно проявляется
     * странным трекингом в первые секунды. См. `warmup` в `./pack`.
     */
    const nowMain = (): number => performance.now()
    const warmupMs = warmup(landmarker, clock, nowMain)

    let timer: ReturnType<typeof setTimeout> | null = null
    let killed = false
    /*
     * Счётчик ошибок — ТОТ ЖЕ, что у воркера (`makeErrorRun`, один порог
     * `ERRORS_BEFORE_NEXT`). Раньше здесь стояло своё число `5` в коде, а тест
     * проверял третий счётчик, который в бою не вызывал никто: правка порога
     * не меняла ничего, и прогон оставался зелёным.
     */
    const errorRun = makeErrorRun()

    const step = (): void => {
      if (killed || stopped) return
      const tCap = performance.now()
      let lm: Float32Array | null = null
      /** Пятая ошибка подряд: ступень сошла. Переменная живёт один кадр. */
      let fallen = false
      try {
        lm = packLandmarks(landmarker.detectForVideo(video, clock(tCap)))
        errorRun.onSuccess()
      } catch (e) {
        fallen = errorRun.onError()
        // Одиночная ошибка — своё событие, не `pose.fail`: иначе разбор
        // журнала читает закрытый кадр как сошедшую ступень.
        write(poseError({ pipeline: pipelineId(p), stage: 'infer', message: says(e) }))
      }
      const tDone = performance.now()
      emit(pipelineId(p), lm, {
        tCap,
        tDone,
        inferMs: Math.round(tDone - tCap),
        dropped: 0,
        w: video.videoWidth || null,
        h: video.videoHeight || null,
      })
      if (fallen) {
        // Ниже этой ступени лестницы нет, но сказать об этом обязаны.
        void fell(`${ERRORS_BEFORE_NEXT} ошибок инференса подряд на главном потоке`)
        return
      }
      timer = setTimeout(step, 1000 / POSE.hzMainThread)
    }
    step()

    return {
      pipeline: p,
      delegate: p.delegate,
      initMs,
      warmupMs,
      looksLikeCpu: looksLikeCpu(warmupMs),
      stop: async () => {
        if (killed) return
        killed = true
        if (timer !== null) clearTimeout(timer)
        try {
          landmarker.close()
        } catch {
          // закрыли уже — не беда
        }
      },
    }
  }

  await climb()

  return async () => {
    if (stopped) return
    stopped = true
    track?.removeEventListener('ended', onEnded)
    track?.removeEventListener('mute', onMute)
    const dying = active
    active = null
    if (dying) await dying.stop()
    cam.stop?.()
    for (const t of cam.stream.getTracks()) t.stop()
    video.srcObject = null
  }
}
