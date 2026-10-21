/**
 * Общая часть инференса: часы, упаковка точек, настройки распознавателя и
 * прогрев.
 *
 * Вынесено отдельно от воркера и от пути на главном потоке, потому что этим
 * пользуются ДВА исполнителя (`worker.ts` и ветка `main` в `source.ts`), а две
 * копии разошлись бы — и разошлись бы молча, потому что проверяется на живом
 * железе только один из путей.
 *
 * Здесь же — всё, что в этом файле ВООБЩЕ можно проверить тестом: часы и
 * упаковка чисты и проверяются (`tests/adapters/pose-pack.test.ts`).
 *
 * Разбор: `docs/camera-and-pose.md`.
 */

import { LANDMARK_COUNT, LANDMARK_STRIDE } from '../../core/landmarks'
import type { Landmarks } from '../../core/types'

/**
 * Числа источника позы. В `CONFIG` (ядро) их нет намеренно: ядро судит по
 * кадрам и о том, откуда кадры берутся, знать не вправе.
 */
export const POSE = Object.freeze({
  /**
   * Потолок частоты инференса. **11–12 Гц — это измеренное на целевом
   * телефоне, а не цель:** в `run-game` в конфиге стояло 20 и не достигалось
   * никогда. Поднимать это число бессмысленно — оно только перестанет быть
   * правдой, — а судейство и так исходит из 11 Гц (окно 600 мс держит 7±1
   * кадр), см. `docs/judging.md`.
   */
  hz: 12,
  /** Путь `main` блокирует главный поток синхронно, поэтому частота ниже. */
  hzMainThread: 10,

  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  /** Никогда: маски сегментации — чистая трата того же Adreno 619. */
  outputSegmentationMasks: false,

  /** Сколько ждать ответа `ready` от одной попытки лестницы. */
  initTimeoutMs: 12000,

  /**
   * Потолок ожидания ПРИЗНАКА ЖИЗНИ у уже открытой ступени: столько молчания —
   * и ступень считается сошедшей.
   *
   * Запас выбран так, чтобы медленное устройство нельзя было принять за
   * мёртвое. Признак жизни приходит двумя путями: `beat` раз в секунду (его
   * воркер постит таймером, независимо от кадров) и любое сообщение о кадре.
   * Измеренный инференс — 18 мс на GPU и около 80 мс на процессоре, так что
   * три секунды это три пропущенных `beat` и ~37 измеренных инференсов: ни
   * просадка частоты, ни замолчавшая камера (кадров нет, `beat` идёт) под
   * потолок не попадают, а умерший воркер — попадает.
   *
   * Зачем вообще: воркер умеет умереть НЕ бросив `error` — например, его
   * убивает Android по памяти, и это как раз реалистичный случай на целевом
   * телефоне. Без потолка `bitmap` ждал бы подтверждения вечно, `stream`
   * молчал бы, а лестница не двинулась бы ни на ступень: ровно то «игра
   * перестала видеть ребёнка», ради предотвращения которого этот адаптер и
   * написан.
   */
  aliveTimeoutMs: 3000,

  /** Прогревочных инференсов по серому кадру. */
  warmupRuns: 10,
  /**
   * Медиана прогрева выше этого — считает процессор, что бы ни было написано
   * в ответе про делегат. Заявленный делегат умеет врать, и единственный
   * честный ответ даёт замер.
   */
  warmupCpuMs: 70,
} as const)

/**
 * Метка времени для MediaPipe: строго возрастающее целое число миллисекунд.
 *
 * Это не придирка к стилю и не перестраховка. При нарушении монотонности
 * MediaPipe валится abort'ом внутри wasm, и распознаватель после этого мёртв
 * НАВСЕГДА — до перезагрузки страницы: ни ошибки наружу, ни возможности
 * восстановиться. Два кадра с одинаковой меткой убивают конвейер так же
 * надёжно, как убывающая метка, поэтому счётчик защищён здесь, а не
 * «обычно и так растёт» по месту вызова.
 *
 * Нечисловой вход тоже обязан дать число: метка приходит не только от
 * `performance.now()`, но и от кадра (`frame.timestamp`), где отсутствующее
 * поле даёт NaN, а NaN в wasm — тот же abort.
 */
export function makeClock(): (ms: number) => number {
  let last = -1
  return (ms: number): number => {
    const want = Number.isFinite(ms) ? Math.round(ms) : last + 1
    const t = want > last ? want : last + 1
    last = t
    return t
  }
}

/** Одна точка в ответе MediaPipe. Поля необязательны: версии расходятся. */
export type RawLandmark = {
  x?: number
  y?: number
  z?: number
  visibility?: number
  presence?: number
}

/** Ответ `detectForVideo` в той форме, в какой он нам интересен. */
export type RawResult = { landmarks?: RawLandmark[][] } | null | undefined

/** Берёт число, если оно число; иначе — `undefined`. `null` числом не считает. */
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/**
 * Результат MediaPipe → 132 числа: 33 точки по `x`, `y`, `z` и видимости.
 *
 * Плоский `Float32Array`, а не объекты: он уходит из воркера передачей буфера,
 * без копирования, и разбирается на той стороне обычной арифметикой
 * (`pointAt` в ядре).
 *
 * Неполный скелет — `null`, а не массив с дырами: ядро читает точки по
 * индексам из `LM`, и недостающая опорная точка дала бы не отказ судить, а
 * нули, то есть посчитанную геометрию несуществующего тела.
 */
export function packLandmarks(res: RawResult): Landmarks | null {
  const pts = res?.landmarks?.[0]
  if (!pts || pts.length !== LANDMARK_COUNT) return null

  const out = new Float32Array(LANDMARK_COUNT * LANDMARK_STRIDE)
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = pts[i]
    const base = i * LANDMARK_STRIDE
    out[base] = num(p?.x) ?? 0
    out[base + 1] = num(p?.y) ?? 0
    out[base + 2] = num(p?.z) ?? 0
    // У разных версий признак зовётся по-разному — берём что есть, а не то,
    // что ожидаем. Отсутствие поля даёт единицу, а не ноль: ноль прочитался
    // бы как «ребёнка не видно», то есть молчаливый отказ судить там, где
    // модель точку нашла.
    out[base + 3] = num(p?.visibility) ?? num(p?.presence) ?? 1
  }
  return out
}

/** Делегат инференса: кто считает — видеокарта или процессор. */
export type Delegate = 'GPU' | 'CPU'

/** Настройки распознавателя — одинаковые у воркера и у главного потока. */
export function landmarkerOptions(model: string, delegate: Delegate) {
  return {
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO' as const,
    numPoses: POSE.numPoses,
    minPoseDetectionConfidence: POSE.minPoseDetectionConfidence,
    minPosePresenceConfidence: POSE.minPosePresenceConfidence,
    minTrackingConfidence: POSE.minTrackingConfidence,
    outputSegmentationMasks: POSE.outputSegmentationMasks,
  }
}

/** То немногое, что нам нужно от `PoseLandmarker`. */
export type Landmarker = {
  detectForVideo(frame: unknown, ms: number): RawResult
  close(): void
}

/**
 * Прогрев по серому кадру. Возвращает МЕДИАНУ времени инференса, мс, либо
 * `null`, если прогреть не удалось.
 *
 * Нужен не «чтобы разогрелось», а по двум измеренным причинам. Первая: первый
 * инференс строит граф и занимает секунды (в `run-game` замерено 3.3 с против
 * 18 мс у последующих) — без прогрева игра встала бы колом на старте, уже
 * показав ребёнку позу. Вторая: заявленный делегат врёт, и единственный
 * честный ответ на вопрос «это правда GPU?» — сколько инференс занимает на
 * самом деле. Поэтому медиана уходит в журнал (`pose.ready`): по ней взрослый
 * видит подлог, а не догадывается о нём по тормозам.
 *
 * Медиана, а не среднее: первый вызов на порядки дольше остальных и среднее
 * испортил бы.
 *
 * **`now` обязателен, а не берётся из `performance.now()` внутри.** Прогрев и
 * живой инференс кормят ОДНИ часы (`clock`), и база времени у них обязана быть
 * одна. У воркера она своя: `performance.now() + timeOffset`, где поправка
 * ПОЛОЖИТЕЛЬНА: своё начало отсчёта у воркера позже главного, и на эту разницу
 * его `performance.now()` отстаёт (вывод и тест — в `track-clock.ts`). Прежде
 * здесь было написано «отрицательна», и ровно это утверждение жило в коде
 * обратным знаком. Когда прогрев
 * кормил часы `performance.now()`, их `last` оставался на тысячи миллисекунд
 * впереди первой живой метки, и страж монотонности выдавал `last + 1` на
 * каждый кадр: первые секунды игры приходили с метками в 1 мс друг от друга
 * при кадрах раз в 83 мс. Монотонность при этом цела, abort'а нет — а
 * `VIDEO`-режим MediaPipe считает по этим разностям трекинг, и «первые секунды
 * трекинг вёл себя странно» по журналу не объяснить ничем. Поэтому источник
 * времени передаётся снаружи: двум путям нечем разойтись молча.
 */
export function warmup(
  landmarker: Landmarker,
  clock: (ms: number) => number,
  now: () => number,
  runs = POSE.warmupRuns,
): number | null {
  try {
    const canvas = new OffscreenCanvas(256, 256)
    const cx = canvas.getContext('2d')
    if (!cx) return null
    cx.fillStyle = '#808080'
    cx.fillRect(0, 0, 256, 256)
    const bmp = canvas.transferToImageBitmap()

    const times: number[] = []
    try {
      for (let i = 0; i < runs; i++) {
        const t0 = now()
        landmarker.detectForVideo(bmp, clock(now()))
        times.push(now() - t0)
      }
    } finally {
      bmp.close()
    }

    if (!times.length) return null
    times.sort((a, b) => a - b)
    return Math.round(times[Math.floor(times.length / 2)])
  } catch {
    // Прогрев — измерение, а не работа игры: его отказ не повод валить
    // попытку конвейера. Отсутствие медианы и есть ответ «не замерили».
    return null
  }
}

/** Медиана прогрева подозрительно велика — делегат заявлен, но не работает. */
export const looksLikeCpu = (warmupMs: number | null): boolean | null =>
  warmupMs == null ? null : warmupMs > POSE.warmupCpuMs
