/**
 * Камера: открытие по лестнице ограничений, отношение сторон кадра и оценка
 * кадрирования.
 *
 * `getUserMedia` приходит ЗАВИСИМОСТЬЮ, а не берётся из `navigator` намертво:
 * иначе ни одна ступень лестницы не проверяема вне телефона, а лестница — это
 * как раз мой код, а не чужой драйвер.
 *
 * **Слежения за `ended`/`mute` дорожки здесь НЕТ, и это решение.** Его ведёт
 * источник позы (`./pose/source.ts`), у которого есть единственный путь наружу
 * (`onStatus`) и который пишет `cam.ended`. Второй наблюдатель писал бы то же
 * событие второй раз, и разбор журнала считал бы одну потерю камеры за две.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */

import type { Calibration } from '../core/types'
import type { Geometry } from '../core/geometry'
import { camFail, camStart } from './log/events'
import { write } from './log/store'
import type { CameraHandle } from './pose/source'

/**
 * Числа камеры. Живут ЗДЕСЬ, а не в `CONFIG`, по той же причине, что и `POSE`:
 * ядро судит по кадрам и о том, откуда кадры берутся, знать не вправе.
 */
export const CAMERA = Object.freeze({
  /**
   * Потолок ожидания ОДНОЙ ступени лестницы. Свой у каждой, а не общий на всё
   * открытие: общий потолок первая же зависшая ступень съела бы целиком, и до
   * `video: true` — той, что открывается почти всегда, — очередь не дошла бы.
   */
  openTimeoutMs: 20000,

  /**
   * Сколько длин торса в целом человеке. Торс мерится в единицах `y`, то есть
   * уже в долях высоты кадра, так что заполнение — это торс, домноженный на
   * это число.
   *
   * Число анатомическое и грубое: у ребёнка 7 лет голова относительно крупнее,
   * чем у взрослого, и доли расходятся. Точность здесь и не нужна — им
   * подсказывают «отойди/подойди», а не судят позу.
   */
  bodyPerTorso: 3.2,

  /**
   * Полоса годного заполнения кадра, когда калибровки ЕЩЁ НЕТ. Снизу — игрок
   * так далеко, что трекер начинает терять точки; сверху — не влезает в кадр
   * целиком, и ось опоры по коленям считать уже не из чего.
   */
  fillMin: 0.45,
  fillMax: 0.95,

  /**
   * Допуск по торсу относительно снятого при калибровке (`S0`), в долях.
   * Калиброванного игрока судят ОТ НЕГО, а не абсолютной полосой: калибровка и
   * есть та дистанция, под которую посчитаны пороги.
   */
  calibratedTolerance: 0.35,
})

/**
 * Лестница ограничений: от дешёвого кадра к «любому, какой есть».
 *
 * **Камера игры — фронтальная, и спрашивается она ЯВНО.** Прежде `facingMode`
 * здесь не стоял вовсе, и камеру выбирал браузер: в первом живом прогоне он
 * угадал (`facing: "user"` в журнале), но угадывание — не решение, и на другом
 * телефоне оно даст заднюю камеру. Верхние ступени просят фронтальную через
 * `exact`, то есть отказом, а не пожеланием: подменённая камера хуже отказа,
 * потому что отказ виден, а подмена выглядит как «игра не узнаёт ребёнка».
 *
 * Снизу намеренно стоит `true`. Отказаться от камеры совсем хуже, чем взять
 * кадр не того размера: отношение сторон игра всё равно меряет сама
 * (`frameAspect`), а 1280×720 на Snapdragon 695 — это просто меньше кадров в
 * секунду, тогда как отсутствие кадров — это отсутствие игры.
 */
export const CONSTRAINTS = Object.freeze([
  {
    facingMode: { exact: 'user' },
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 30 },
  },
  {
    facingMode: { exact: 'user' },
    width: { ideal: 480 },
    height: { ideal: 270 },
    frameRate: { ideal: 30 },
  },
  { facingMode: { exact: 'user' } },
  // Телефон без фронтальной камеры: `exact` на нём отказывает целиком, а
  // пожелание хотя бы сохраняет предпочтение.
  { facingMode: { ideal: 'user' } },
  true,
] as const)

export type GetUserMedia = ((c: MediaStreamConstraints) => Promise<MediaStream>) | null | undefined

export type OpenCameraOpts = {
  /** Подменяется в тестах; по умолчанию — `navigator.mediaDevices`. */
  getUserMedia?: GetUserMedia
  /** Потолок ОДНОЙ ступени. По умолчанию `CAMERA.openTimeoutMs`. */
  timeoutMs?: number
}

const says = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Гасит все дорожки потока. Звать можно повторно. */
function stopStream(s: MediaStream): void {
  for (const t of s.getTracks()) {
    try {
      t.stop()
    } catch {
      // дорожка уже мертва — не беда
    }
  }
}

function defaultGetUserMedia(): GetUserMedia {
  const md = (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices
  if (!md?.getUserMedia) return null
  return (c) => md.getUserMedia(c)
}

/**
 * Открывает камеру, перебирая `CONSTRAINTS` сверху вниз. Первая удавшаяся
 * ступень и выигрывает.
 *
 * Бросает, если не открылась НИ ОДНА: наверху это единственный способ отличить
 * «нет разрешения на камеру» от мёртвого распознавателя, а молчаливый отказ
 * выглядел бы на штативе как «игра не видит ребёнка».
 */
export async function openCamera(opts: OpenCameraOpts = {}): Promise<CameraHandle> {
  const gum = opts.getUserMedia === undefined ? defaultGetUserMedia() : opts.getUserMedia
  if (!gum) {
    const message = 'getUserMedia недоступен'
    write(camFail({ name: 'Unsupported', message }))
    throw new Error(message)
  }

  const timeoutMs = opts.timeoutMs ?? CAMERA.openTimeoutMs
  const problems: string[] = []

  for (const video of CONSTRAINTS) {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const got = gum({ video, audio: false })

      /*
       * Опоздавшая ступень ГАСИТСЯ. Потолок срабатывает, игра идёт дальше, а
       * поток приезжает позже — и держать его уже некому: индикатор камеры
       * горит, дорожка занята, погасить её не из чего. Поэтому гашение вешается
       * на само обещание, а не делается после `await`, до которого мы в этой
       * ветке уже не дойдём.
       */
      const stream = await new Promise<MediaStream>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`камера молчит дольше ${timeoutMs} мс`)), timeoutMs)
        got.then(resolve, reject)
      }).catch((e: unknown) => {
        void got.then(
          (late) => stopStream(late),
          () => {},
        )
        throw e
      })

      const track = stream.getVideoTracks()[0] ?? null
      const s = track?.getSettings() ?? {}
      write(
        camStart({
          w: s.width ?? 0,
          h: s.height ?? 0,
          ...(s.facingMode ? { facing: s.facingMode } : {}),
          ...(s.deviceId ? { deviceId: s.deviceId } : {}),
        }),
      )

      let stopped = false
      return {
        stream,
        stop: () => {
          if (stopped) return
          stopped = true
          stopStream(stream)
        },
      }
    } catch (e) {
      problems.push(says(e))
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  const message = `камера не открылась ни на одной ступени: ${problems.join('; ')}`
  write(camFail({ name: 'NoCamera', message }))
  throw new Error(message)
}

/**
 * Источники отношения сторон, по убыванию достоверности.
 *
 * Порядок не произволен. `frame` — размер кадра, который реально ушёл в
 * MediaPipe, то есть единственная правда о том, по чему судили. `video` врёт
 * нулями до первого кадра. `getSettings()` отвечает про ПРОСИМОЕ, а не про
 * выданное, и на Android расходится с настоящим кадром.
 */
export type AspectSource = {
  frame?: { w: number | null; h: number | null } | null
  video?: { videoWidth: number; videoHeight: number } | null
  track?: { getSettings(): MediaTrackSettings } | null
}

/** Отношение `w/h`, либо `null`, если пара негодна. */
function ratio(w: number | null | undefined, h: number | null | undefined): number | null {
  if (typeof w !== 'number' || typeof h !== 'number') return null
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  if (w <= 0 || h <= 0) return null
  return w / h
}

/**
 * Отношение сторон кадра, либо `null`, пока ни один источник не ответил.
 *
 * `null` — полноценный ответ, а не прочерк: без `aspect` геометрия ОТКАЗЫВАЕТСЯ
 * считать (`geometry()` вернёт `null`), потому что `x` нормирован по ширине, а
 * `y` по высоте, и без поправки углы врут на десятки градусов. Негодный
 * источник уступает место следующему, а не гасит ответ: воркер может ещё не
 * отдать ни кадра, когда `video` уже отдал.
 */
export function frameAspect(src: AspectSource): number | null {
  // `getSettings()` спрашивается ОДИН раз: это обращение к дорожке, и два
  // вызова в одном выражении могут вернуть разное.
  const settings = src.track?.getSettings()
  return (
    ratio(src.frame?.w, src.frame?.h) ??
    ratio(src.video?.videoWidth, src.video?.videoHeight) ??
    ratio(settings?.width, settings?.height)
  )
}

export type Framing = {
  /** Доля ВЫСОТЫ кадра, занятая игроком целиком. */
  fill: number
  /** Кадрирован ли игрок так, как ждёт судейство. */
  ok: boolean
}

/**
 * Оценка кадрирования для подсказки «отойди/подойди».
 *
 * Смысл `ok` ОДИН в оба случая — «кадрирован так, как ждёт судейство», — но
 * правда, от которой мерить, разная. Без калибровки мерить не от чего, и
 * берётся абсолютная полоса (`fillMin`..`fillMax`). С калибровкой правда —
 * снятый торс `S0`: именно под ту дистанцию посчитаны пороги, и игрок,
 * вставший вдвое дальше, судится неверно, даже если в абсолютную полосу он
 * попал.
 *
 * Нет позы — `ok: false` и нулевое заполнение: иначе «игрока нет в кадре» не
 * отличить от «игрок стоит плохо». Негодный `S0` (ноль, NaN — калибровка,
 * пришедшая из сломанного хранилища) откатывает к абсолютной полосе, а не
 * делит на ноль: это зовётся на каждом кадре экрана калибровки.
 */
export function framing(g: Geometry | null, cal: Calibration | null | undefined): Framing {
  if (!g || !Number.isFinite(g.S) || g.S <= 0) return { fill: 0, ok: false }

  const fill = g.S * CAMERA.bodyPerTorso
  const S0 = cal?.S0
  if (typeof S0 === 'number' && Number.isFinite(S0) && S0 > 0) {
    const d = CAMERA.calibratedTolerance
    return { fill, ok: g.S >= S0 * (1 - d) && g.S <= S0 * (1 + d) }
  }
  return { fill, ok: fill >= CAMERA.fillMin && fill <= CAMERA.fillMax }
}
