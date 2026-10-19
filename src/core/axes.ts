import { CONFIG } from './config'
import type { Geometry } from './geometry'
import { LANDMARK_STRIDE, LM } from './landmarks'
import type {
  AxisRequirements,
  AxisValue,
  Calibration,
  ElbowState,
  ForearmState,
  HandsState,
  Landmarks,
  LeanState,
  LegsState,
  Orientation,
  Pt,
  ShoulderState,
  SupportState,
} from './types'

/**
 * Сердце судейства: нормализованная геометрия кадра → состояния осей.
 *
 * Читать вместе с docs/poses-and-figure.md («Девять осей» и «Пороги») и
 * docs/camera-and-pose.md (единицы). Два правила держат весь файл:
 *
 * - **«Не знаю» возвращается в двух разных случаях:** значение попало между
 *   состояниями ЛИБО любая участвующая в оси точка ниже порога `visibility`.
 *   Это не одно и то же, и оба обязаны быть. Промахом «не знаю» не считается.
 * - **Судится проекция.** Вырез в стене — плоский силуэт, поэтому ось читает
 *   угол в кадре, а не домысленную глубину. Состояние «на камеру» (`front`)
 *   поэтому и опознаётся вырождением проекции, а не поворотом в пространстве.
 *
 * Ориентация здесь ось показаний, но НЕ ось совпадения: кадр не с той
 * ориентацией невалиден (причина отказа присутствия), а не промахнулся.
 * Повернув «Букву Т» в профиль, плечи `side` сохранить нельзя — руки в
 * стороны в профиль смотрят в камеру.
 */

/**
 * Канонический список осей — единственный источник полноты `AxisReadings`.
 * Тесты выводят покрытие из него, а не из таблицы в своём файле: забытая в
 * таблице ось иначе не ловится ничем. Типы в рантайме недоступны, поэтому
 * массив, а не `keyof`.
 */
export const AXES = [
  'orientation',
  'leftShoulder',
  'rightShoulder',
  'nearShoulder',
  'farShoulder',
  'leftElbow',
  'rightElbow',
  'nearElbow',
  'farElbow',
  'leftForearm',
  'rightForearm',
  'nearForearm',
  'farForearm',
  'hands',
  'legs',
  'support',
  'lean',
  'crouch',
  'knees',
  'footAtKnee',
] as const

export type Axis = (typeof AXES)[number]

// Сторож полноты на типах: `AXES` и `AxisRequirements` обязаны совпадать поле
// в поле. Ось, забытая в массиве, иначе тихо исчезла бы из показаний, а
// лишняя — требовала бы несуществующего состояния.
type AssertNever<T extends never> = T
type _AxesCoverRequirements = AssertNever<Exclude<keyof AxisRequirements, Axis>>
type _AxesHaveNoExtra = AssertNever<Exclude<Axis, keyof AxisRequirements>>

/**
 * Показание одной оси: состояние и измеренное значение.
 *
 * `measured` — не украшение: оно уходит в журнал полем `perAxis`, и по нему
 * взрослый читает «левое плечо 58° при цели 90±30», не переигрывая раунд с
 * ребёнком. Единицы — свои у каждой оси (градусы либо доли торса `S`), и
 * значение считается даже тогда, когда состояние — «не знаю». `NaN` значит, что
 * мерить было нечем: оси на этом кадре нет (ближняя и дальняя сторона во
 * фронтальном кадре) либо ни одной годной точки не нашлось — ноги, у которых не
 * видно ни стоп, ни колен, и ЛЮБАЯ ось, чья точка не прошла порог
 * `visibility`. В последнем случае координаты у точки есть, но они достроены
 * моделью, а не увидены: число по ним — догадка, и в журнал оно уходить не
 * вправе. Исключение одно и оно не об этом: кисти, сведённые при невидимой
 * голове, дают «не знаю» (без линии головы `over-head` не отличить), но само
 * расстояние между кистями измерено по видимым точкам и остаётся числом.
 */
export type AxisReading<T> = {
  state: AxisValue<T>
  measured: number
  /**
   * Чем измерено `measured`, если ось умеет мерить по-разному. Сейчас такая ось
   * одна — ноги: по стопам, когда они видны, и по коленям, когда нет. Поле
   * обязано дойти до `perAxis`: взрослый, читающий «ноги 2.0», иначе не
   * отличит разнос стоп от разноса колен, а это разные числа. Там, где
   * измерить не удалось вовсе, источника нет — и поля нет.
   */
  measuredBy?: MeasuredBy
}

/** Источник измерения оси ног. */
export type MeasuredBy = 'ankle' | 'knee'

export type AxisReadings = { [K in Axis]: AxisReading<AxisRequirements[K]> }

type Side = 'left' | 'right'

const D2R = Math.PI / 180

/** Опорные углы от вертикали. Общие у плеча и предплечья: имена те же. */
const ANGLE = Object.freeze({ up: 0, diagUp: 45, out: 90, down: 180, in: -90 })

const IDX = Object.freeze({
  left: Object.freeze({
    shoulder: LM.leftShoulder,
    elbow: LM.leftElbow,
    wrist: LM.leftWrist,
    hip: LM.leftHip,
    knee: LM.leftKnee,
    ankle: LM.leftAnkle,
  }),
  right: Object.freeze({
    shoulder: LM.rightShoulder,
    elbow: LM.rightElbow,
    wrist: LM.rightWrist,
    hip: LM.rightHip,
    knee: LM.rightKnee,
    ankle: LM.rightAnkle,
  }),
})

/** Точки, по которым восстанавливается линия головы. */
const HEAD = [LM.nose, LM.leftEye, LM.rightEye] as const

const reading = <T>(state: AxisValue<T>, measured: number): AxisReading<T> => ({ state, measured })

/** Оси на этом кадре нет — так читаются ближняя и дальняя сторона во фронте. */
const noReading = <T>(): AxisReading<T> => reading<T>('unknown', Number.NaN)

/**
 * Точка, по которой ось мерит, ниже порога уверенности: мерить было нечем, и
 * `measured` обязан быть `NaN`.
 *
 * Координаты у непройденной точки есть — модель достраивает их по телу, — но
 * число, посчитанное по ним, уехало бы в `perAxis` журнала как настоящее
 * измерение. Журнал — весь диагностический аппарат игры, и уверенное неверное
 * число в нём хуже отсутствующего.
 */
const unseen = <T>(): AxisReading<T> => reading<T>('unknown', Number.NaN)

/**
 * Полоса состояния: опорное значение и допуск вокруг него.
 *
 * Полосы и `pick` вынесены наружу не для удобства: по ним считается
 * ПОДРАЗУМЕВАЕМОЕ состояние локтя (`dependencies.ts`), а второй набор тех же
 * чисел рядом означал бы, что сторож согласованности сторожит свою копию
 * порогов, а не те, по которым судит игра.
 */
export type Band<T> = { state: T; ref: number; tol: number }

/** Расстояние по прямой и по кругу. `NaN` ни в одну полосу не попадает. */
export const linear = (a: number, b: number): number => Math.abs(a - b)
export const circular = (a: number, b: number): number => {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return Math.abs(d)
}

/**
 * Единственное состояние, в чью полосу попало значение.
 *
 * Полос может оказаться две — допуск ±30° вокруг 45° и 90° перекрывается на
 * 65°, — и тогда ответ «не знаю»: различить их на этом кадре нечем. Ни одной
 * полосы — тоже «не знаю»: значение в зазоре между состояниями.
 */
export function pick<T>(
  value: number,
  bands: readonly Band<T>[],
  distance: (a: number, b: number) => number,
): AxisValue<T> {
  let found: T | null = null
  for (const band of bands) {
    if (distance(value, band.ref) <= band.tol) {
      if (found !== null) return 'unknown'
      found = band.state
    }
  }
  return found ?? 'unknown'
}

/** Угол вектора `root`→`tip` от вертикали вверх, растущий в сторону `sign`. */
function limbAngle(root: Pt, tip: Pt, sign: number): number {
  return Math.atan2(sign * (tip.x - root.x), -(tip.y - root.y)) / D2R
}

/** Угол в сочленении `b` между звеньями `b`→`a` и `b`→`c`, в `[0, 180]`. */
function jointAngle(a: Pt, b: Pt, c: Pt): number {
  const ux = a.x - b.x
  const uy = a.y - b.y
  const wx = c.x - b.x
  const wy = c.y - b.y
  const cos = (ux * wx + uy * wy) / (Math.hypot(ux, uy) * Math.hypot(wx, wy))
  return Math.acos(Math.max(-1, Math.min(1, cos))) / D2R
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Всё, что нужно одной оси: кадр, нормализация, строгость и разрешение сторон. */
type Ctx = {
  g: Geometry
  cal: Calibration
  strict: number
  profile: boolean
  /** Точка кадра в единицах `y`: `x` уже домножен на отношение сторон. */
  p: (i: number) => Pt
  /** Видны ли все перечисленные точки достаточно уверенно. */
  seen: (...idx: number[]) => boolean
  /**
   * Знак, в который растут углы конечностей этой стороны, либо `null`, если
   * разрешить его нечем. В профиль обе руки отсчитываются в сторону взгляда:
   * «наружу» там направлено на камеру и в кадре не выражается.
   */
  sign: (side: Side) => number | null
  /** Отклонение точки от средней линии корпуса, в долях торса. */
  dev: (q: Pt) => number
}

/** Ориентация: отношение ширины плеч к длине торса. Строгостью не масштабируется. */
function orientationAxis(g: Geometry): AxisReading<Orientation> {
  const ratio = g.shoulderRatio
  if (ratio > CONFIG.orientation.front) return reading<Orientation>('front', ratio)
  if (ratio < CONFIG.orientation.profile) return reading<Orientation>('profile', ratio)
  return reading<Orientation>('unknown', ratio)
}

export function shoulderBands(profile: boolean, strict: number): Band<ShoulderState>[] {
  const tol = CONFIG.shoulder.tolerance * strict
  return [
    { state: 'up', ref: ANGLE.up, tol },
    { state: 'diag-up', ref: ANGLE.diagUp, tol },
    { state: 'down', ref: ANGLE.down, tol },
    // В профиль «в сторону» направлено на камеру, и тот же угол 90° в кадре —
    // это рука по линии взгляда, то есть `front`, а не `side`.
    profile ? { state: 'front', ref: ANGLE.out, tol } : { state: 'side', ref: ANGLE.out, tol },
  ]
}

export function forearmBands(profile: boolean, strict: number): Band<ForearmState>[] {
  const tol = CONFIG.forearm.tolerance * strict
  return [
    { state: 'up', ref: ANGLE.up, tol },
    { state: 'down', ref: ANGLE.down, tol },
    profile ? { state: 'front', ref: ANGLE.out, tol } : { state: 'in', ref: ANGLE.in, tol },
  ]
}

/** Плечо: угол вектора плечо→локоть от вертикали. */
function shoulderAxis(c: Ctx, side: Side): AxisReading<ShoulderState> {
  const i = IDX[side]
  const sign = c.sign(side)
  const angle = sign === null ? Number.NaN : limbAngle(c.p(i.shoulder), c.p(i.elbow), sign)
  if (sign === null || !c.seen(i.shoulder, i.elbow)) return unseen<ShoulderState>()

  const state = pick(angle, shoulderBands(c.profile, c.strict), circular)
  if (state !== 'unknown') return reading(state, angle)

  // Рука на камеру: в кадре она вырождается в короткое звено у средней линии
  // корпуса. Во фронтальном кадре углом это не выражается, поэтому `front`
  // опознаётся отклонением локтя и кисти — и только там, где угол не прочёлся.
  if (!c.profile && c.seen(i.wrist)) {
    const near = CONFIG.shoulder.front * c.strict
    if (c.dev(c.p(i.elbow)) < near && c.dev(c.p(i.wrist)) < near) {
      return reading<ShoulderState>('front', angle)
    }
  }
  return reading<ShoulderState>('unknown', angle)
}

export function elbowBands(strict: number): Band<ElbowState>[] {
  const straight = ANGLE.down - (ANGLE.down - CONFIG.elbow.straightMin) * strict
  const mid = (CONFIG.elbow.bentMin + CONFIG.elbow.bentMax) / 2
  const half = ((CONFIG.elbow.bentMax - CONFIG.elbow.bentMin) / 2) * strict
  return [
    { state: 'straight', ref: ANGLE.down, tol: ANGLE.down - straight },
    { state: 'bent', ref: mid, tol: half },
  ]
}

/** Локоть: угол плечо–локоть–кисть. */
function elbowAxis(c: Ctx, side: Side): AxisReading<ElbowState> {
  const i = IDX[side]
  const angle = jointAngle(c.p(i.shoulder), c.p(i.elbow), c.p(i.wrist))
  if (!c.seen(i.shoulder, i.elbow, i.wrist)) return unseen<ElbowState>()

  return reading(pick(angle, elbowBands(c.strict), linear), angle)
}

/**
 * Предплечье: угол вектора локоть→кисть. Ось существует потому, что при
 * согнутом локте вектор плечо→кисть вырождается и не отличает предплечье
 * вверх от предплечья вниз, то есть «Плоского Робота» от «Низкого барьера».
 */
function forearmAxis(c: Ctx, side: Side): AxisReading<ForearmState> {
  const i = IDX[side]
  const sign = c.sign(side)
  const angle = sign === null ? Number.NaN : limbAngle(c.p(i.elbow), c.p(i.wrist), sign)
  if (sign === null || !c.seen(i.elbow, i.wrist)) return unseen<ForearmState>()

  const state = pick(angle, forearmBands(c.profile, c.strict), circular)
  if (state !== 'unknown') return reading(state, angle)
  if (!c.profile && c.dev(c.p(i.wrist)) < CONFIG.shoulder.front * c.strict) {
    return reading<ForearmState>('front', angle)
  }
  return reading<ForearmState>('unknown', angle)
}

/** Кисти вместе: расстояние между кистями и их высота. */
function handsAxis(c: Ctx): AxisReading<HandsState> {
  const lw = c.p(LM.leftWrist)
  const rw = c.p(LM.rightWrist)
  const gap = dist(lw, rw) / c.g.S
  if (!c.seen(LM.leftWrist, LM.rightWrist)) return unseen<HandsState>()

  if (gap < CONFIG.hands.overHead * c.strict) {
    // Линия головы нужна только здесь: при разведённых кистях она ни на что
    // не влияет, и терять из-за неё всю ось было бы неправдой.
    if (!c.seen(...HEAD)) return reading<HandsState>('unknown', gap)
    const line = Math.min(...HEAD.map((i) => c.p(i).y))
    if (lw.y < line && rw.y < line) return reading<HandsState>('over-head', gap)
  }

  if (gap < CONFIG.hands.inFront * c.strict) {
    const near = CONFIG.shoulder.front * c.strict
    const chest = [lw, rw].every((w) => w.y >= c.g.shoulderMid.y && w.y <= c.g.hipMid.y)
    if (chest && c.dev(lw) < near && c.dev(rw) < near) return reading<HandsState>('in-front', gap)
  }

  return reading<HandsState>('no', gap)
}

/** Полоса состояния, заданная границами «от» и «до». */
const span = <T>(state: T, from: number, to: number, strict: number): Band<T> => ({
  state,
  ref: (from + to) / 2,
  tol: ((to - from) / 2) * strict,
})

/**
 * Разнос ног: горизонтальное расстояние между СТОПАМИ, когда обе видны, и
 * между КОЛЕНЯМИ, когда нет.
 *
 * Два источника — тот же урок, что у опоры: в приседе стопы уходят из кадра, и
 * это норма, а не отказ. «Низкий барьер» и «Краб на пляже» требуют присед и
 * ноги `wide` одновременно, так что по стопам они не засчитались бы никогда —
 * ребёнок делал бы позу правильно и не получал ничего. Числа у двух источников
 * свои (`CONFIG.legs.ankle` и `CONFIG.legs.knee`): при одной и той же стойке
 * разносы разные, и один набор на двоих был бы двумя смыслами в одном числе.
 *
 * Чем измерено — в `measuredBy`: без этого «ноги 2.0» в журнале не прочесть.
 * Не видно ни стоп, ни колен — «не знаю», и источника нет.
 */
function legsAxis(c: Ctx): AxisReading<LegsState> {
  const gap = (a: number, b: number): number => Math.abs(c.p(a).x - c.p(b).x) / c.g.S

  if (c.seen(LM.leftAnkle, LM.rightAnkle)) {
    const { together, shoulderMin, shoulderMax, wideMin, wideMax, max } = CONFIG.legs.ankle
    return byBands(
      gap(LM.leftAnkle, LM.rightAnkle),
      'ankle',
      [
        // Стопы вместе — полоса от нуля: сойтись теснее некуда.
        { state: 'together' as const, ref: 0, tol: together * c.strict },
        span('shoulder' as const, shoulderMin, shoulderMax, c.strict),
        span('wide' as const, wideMin, wideMax, c.strict),
      ],
      max,
    )
  }

  if (c.seen(LM.leftKnee, LM.rightKnee)) {
    const k = CONFIG.legs.knee
    // Строгость полосы по коленям НЕ масштабирует — как и `max` ниже. Это не
    // допуск вокруг цели, а порог-доказательство: разнос колен заново выводит
    // ненаблюдаемый разнос стоп, и масштабировать вывод родительской
    // настройкой «насколько точно повторять позу» нечем. Зазоры здесь 0.05 /
    // 0.04 / 0.02 S против 0.10 S по стопам, и мягкий ×1.3 съедал бы их
    // целиком: стойка `wide` на 1.92 читалась бы уверенным `shoulder`, то есть
    // промахом там, где норма отвечает «не знаю». Оба приседа требуют `wide` —
    // промах был бы не по вине ребёнка.
    const exact = 1
    return byBands(
      gap(LM.leftKnee, LM.rightKnee),
      'knee',
      [
        // Снизу полоса закрыта: ниже `togetherMin` колени приседом не
        // разведены, и стойку по ним не восстановить.
        span('together' as const, k.togetherMin, k.togetherMax, exact),
        span('shoulder' as const, k.shoulderMin, k.shoulderMax, exact),
        span('wide' as const, k.wideMin, k.wideMax, exact),
      ],
      k.max,
    )
  }

  return reading<LegsState>('unknown', Number.NaN)
}

/** Общая развязка обоих источников: полосы плюс открытый сверху `max`. */
function byBands(
  spread: number,
  measuredBy: MeasuredBy,
  bands: readonly Band<Exclude<LegsState, 'max'>>[],
  max: number,
): AxisReading<LegsState> {
  const hit: AxisValue<LegsState> = pick(spread, bands, linear)
  // `max` открыт сверху: это не допуск вокруг цели, а порог-доказательство, и
  // строгость его не масштабирует.
  const state: AxisValue<LegsState> = spread >= max ? (hit === 'unknown' ? 'max' : 'unknown') : hit
  return { state, measured: spread, measuredBy }
}

/**
 * Опора считается по КОЛЕНЯМ, а не по стопам. В «Фламинго», «Цифре 4» и
 * приседе стопы уходят из кадра — это норма, а не отказ: колено выше в кадре и
 * видно надёжнее. Стопы — только подтверждение, и только если видны.
 */
function supportAxis(c: Ctx): AxisReading<SupportState> {
  const lk = c.p(LM.leftKnee)
  const rk = c.p(LM.rightKnee)
  const diff = Math.abs(lk.y - rk.y) / c.g.S
  if (!c.seen(LM.leftKnee, LM.rightKnee) || !Number.isFinite(diff)) return unseen<SupportState>()
  if (diff < CONFIG.support.kneeHeightDiff) return reading<SupportState>('both', diff)

  const stand: Side = lk.y > rk.y ? 'left' : 'right'
  if (c.seen(LM.leftAnkle, LM.rightAnkle)) {
    const lower: Side = c.p(LM.leftAnkle).y > c.p(LM.rightAnkle).y ? 'left' : 'right'
    // Колени говорят одно, стопы другое — значит не знаем, а не «похоже на».
    if (lower !== stand) return reading<SupportState>('unknown', diff)
  }
  return reading<SupportState>(stand, diff)
}

/** Наклон корпуса: угол вектора бёдра→плечи от вертикали. */
function leanAxis(c: Ctx): AxisReading<LeanState> {
  const angle = limbAngle(c.g.hipMid, c.g.shoulderMid, 1)
  const bands: Band<LeanState>[] = [
    { state: 'upright', ref: 0, tol: CONFIG.lean.tolerance * c.strict },
  ]
  // Боковой наклон в профиль направлен на камеру и в кадре не выражается.
  if (!c.profile) {
    const ref = (CONFIG.lean.tolerance + CONFIG.lean.horizontal) / 2
    const tol = ((CONFIG.lean.horizontal - CONFIG.lean.tolerance) / 2) * c.strict
    bands.push({ state: 'lean-left', ref, tol }, { state: 'lean-right', ref: -ref, tol })
  }
  const hit = pick(angle, bands, circular)
  // `horizontal` открыт сверху — порог-доказательство, строгостью не масштабируется.
  if (Math.abs(angle) >= CONFIG.lean.horizontal) {
    return reading<LeanState>(hit === 'unknown' ? 'horizontal' : 'unknown', angle)
  }
  return reading(hit, angle)
}

/** Угол в колене той ноги, что согнута сильнее: по ней судятся обе. */
function worstKneeAngle(c: Ctx): number {
  const angle = (side: Side): number =>
    jointAngle(c.p(IDX[side].hip), c.p(IDX[side].knee), c.p(IDX[side].ankle))
  return Math.min(angle('left'), angle('right'))
}

const kneePoints = [
  IDX.left.hip,
  IDX.left.knee,
  IDX.left.ankle,
  IDX.right.hip,
  IDX.right.knee,
  IDX.right.ankle,
] as const

/** Колени: угол бедро–колено–стопа. Полоса 140..150 — «не знаю». */
function kneesAxis(c: Ctx): AxisReading<'straight' | 'bent'> {
  const angle = worstKneeAngle(c)
  if (!c.seen(...kneePoints)) return unseen<'straight' | 'bent'>()
  if (angle > ANGLE.down - (ANGLE.down - CONFIG.knee.straightMin) * c.strict) {
    return reading<'straight' | 'bent'>('straight', angle)
  }
  if (angle < CONFIG.knee.crouchVoteMax) return reading<'straight' | 'bent'>('bent', angle)
  return reading<'straight' | 'bent'>('unknown', angle)
}

/**
 * Присед: голосование 2 из 3 — просадка плеч, просадка бёдер, угол колена.
 *
 * Просадки считаются против нейтральной стойки и в долях `S0`: собственный
 * торс в приседе укорачивается и мерить им нельзя. Голос, который посчитать
 * нечем (стопы вне кадра), не становится «нет»: если он решал исход, ответ —
 * «не знаю». И присед отвергается, когда торс вырос: подошедший к камере
 * ребёнок тоже «опускает» плечи в кадре.
 */
function crouchAxis(c: Ctx): AxisReading<'no' | 'yes'> {
  const limit = CONFIG.crouch.drop
  let yes = 0
  let blind = 0
  if ((c.g.shoulderMid.y - c.cal.neutralShoulderY) / c.cal.S0 > limit) yes += 1
  if ((c.g.hipMid.y - c.cal.neutralHipY) / c.cal.S0 > limit) yes += 1

  const knee = worstKneeAngle(c)
  if (!c.seen(...kneePoints) || !Number.isFinite(knee)) blind += 1
  else if (knee < CONFIG.knee.crouchVoteMax) yes += 1

  if (c.g.S > c.cal.S0 * CONFIG.crouch.torsoGrowth) return reading<'no' | 'yes'>('no', yes)
  if (yes >= CONFIG.crouch.votesRequired) return reading<'no' | 'yes'>('yes', yes)
  if (yes + blind >= CONFIG.crouch.votesRequired) return reading<'no' | 'yes'>('unknown', yes)
  return reading<'no' | 'yes'>('no', yes)
}

/** «Цифра 4»: расстояние стопа–колено опорной ноги. */
function footAtKneeAxis(c: Ctx, support: AxisValue<SupportState>): AxisReading<boolean> {
  const toKnee = (stand: Side): number => {
    const raised: Side = stand === 'left' ? 'right' : 'left'
    return dist(c.p(IDX[raised].ankle), c.p(IDX[stand].knee)) / c.g.S
  }
  const stand = support === 'left' || support === 'right' ? support : null
  const measured = stand === null ? Math.min(toKnee('left'), toKnee('right')) : toKnee(stand)

  // Без разрешённой опоры нет и опорного колена: мерить было нечем, и числа
  // поэтому нет. Чаще всего опора «не знаю» именно из-за невидимых колен —
  // расстояние до них было бы посчитано по достроенным моделью точкам.
  if (support === 'unknown') return unseen<boolean>()
  if (stand === null) return reading<boolean>(false, measured)

  const raised: Side = stand === 'left' ? 'right' : 'left'
  if (!c.seen(IDX[stand].knee, IDX[raised].ankle)) return unseen<boolean>()
  return reading<boolean>(measured < CONFIG.footAtKnee.distance * c.strict, measured)
}

/**
 * Состояния всех осей кадра плюс измеренные значения.
 *
 * `lm` и `g` — один и тот же кадр: `g` уже отказалась от негодного, поэтому
 * здесь она не `null`. `strict` — множитель допусков из `strictness()`.
 */
export function axes(lm: Landmarks, g: Geometry, cal: Calibration, strict: number): AxisReadings {
  const aspect = cal.aspect
  const p = (i: number): Pt => {
    const base = i * LANDMARK_STRIDE
    return { x: lm[base] * aspect, y: lm[base + 1] }
  }
  const seen = (...idx: number[]): boolean =>
    idx.every((i) => {
      const v = lm[i * LANDMARK_STRIDE + 3]
      return Number.isFinite(v) && v >= CONFIG.visibility.min
    })

  const orientation = orientationAxis(g)
  const profile = orientation.state === 'profile'

  // Куда смотрит тело в профиль: нос вынесен вперёд от линии плеч. Отсюда же
  // разрешаются ближняя и дальняя стороны — тело, смотрящее в `+x`, обращено
  // к камере ПРАВЫМ боком.
  const noseOffset = profile && seen(LM.nose) ? p(LM.nose).x - g.shoulderMid.x : Number.NaN
  const facing = Number.isFinite(noseOffset) && noseOffset !== 0 ? Math.sign(noseOffset) : null
  const nearSide: Side | null = facing === null ? null : facing > 0 ? 'right' : 'left'
  const farSide: Side | null = nearSide === null ? null : nearSide === 'left' ? 'right' : 'left'

  const up = {
    x: (g.shoulderMid.x - g.hipMid.x) / g.S,
    y: (g.shoulderMid.y - g.hipMid.y) / g.S,
  }
  const across = { x: -up.y, y: up.x }

  const c: Ctx = {
    g,
    cal,
    strict,
    profile,
    p,
    seen,
    sign: (side) => (profile ? facing : side === 'left' ? 1 : -1),
    dev: (q) => Math.abs((q.x - g.hipMid.x) * across.x + (q.y - g.hipMid.y) * across.y) / g.S,
  }

  const shoulder = { left: shoulderAxis(c, 'left'), right: shoulderAxis(c, 'right') }
  const elbow = { left: elbowAxis(c, 'left'), right: elbowAxis(c, 'right') }
  const forearm = { left: forearmAxis(c, 'left'), right: forearmAxis(c, 'right') }
  const support = supportAxis(c)

  /** Ближняя и дальняя — те же показания, разрешённые по направлению взгляда. */
  const bySide = <T>(side: Side | null, from: Record<Side, AxisReading<T>>): AxisReading<T> =>
    side === null ? noReading<T>() : from[side]

  return {
    orientation,
    leftShoulder: shoulder.left,
    rightShoulder: shoulder.right,
    nearShoulder: bySide(nearSide, shoulder),
    farShoulder: bySide(farSide, shoulder),
    leftElbow: elbow.left,
    rightElbow: elbow.right,
    nearElbow: bySide(nearSide, elbow),
    farElbow: bySide(farSide, elbow),
    leftForearm: forearm.left,
    rightForearm: forearm.right,
    nearForearm: bySide(nearSide, forearm),
    farForearm: bySide(farSide, forearm),
    hands: handsAxis(c),
    legs: legsAxis(c),
    support,
    lean: leanAxis(c),
    crouch: crouchAxis(c),
    knees: kneesAxis(c),
    footAtKnee: footAtKneeAxis(c, support.state),
  }
}

