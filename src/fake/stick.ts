import { CONFIG } from '../core/config'
import { LANDMARK_COUNT, LANDMARK_STRIDE, LM, type LandmarkName } from '../core/landmarks'
import type {
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
} from '../core/types'

/**
 * Синтетический скелет: прямая кинематика из состояний осей в 33 точки
 * MediaPipe. Нужен тестам ядра — настоящих записей камеры в них нет.
 *
 * Это НЕ ядро: `src/fake/` снаружи границы слоёв, импортировать его из
 * `src/core/` нельзя. Единицы те же, в которых судит ядро (см.
 * docs/camera-and-pose.md): доли длины торса `S`, углы в градусах от
 * вертикали. Точки сразу нормированы как у MediaPipe — `x` по ширине кадра,
 * `y` по высоте, — поэтому `geometry(stick({ aspect }), aspect)` возвращает
 * ровно те доли торса, которые были заданы.
 *
 * Соглашения, на которых стоит всё остальное:
 *
 * - Камера НЕ зеркалит: анатомически левая сторона игрока лежит в `+x` кадра.
 * - Угол конечности отсчитывается от вертикали вверх и растёт НАРУЖУ своей
 *   стороны: 0° — вверх, 90° — в сторону, 180° — вниз. Поэтому одно и то же
 *   число даёт симметричную позу на обеих руках.
 * - В профиль угол растёт в сторону взгляда (`facing`), а near/far стороны
 *   разрешаются из него: тело, смотрящее в `+x`, обращено к камере ПРАВЫМ
 *   боком (левая сторона человека при взгляде на него сбоку уходит от
 *   камеры). Значит `facing: 'right'` → near = правая сторона.
 * - Боковые состояния (`side` у плеча, `in` у предплечья, `lean-left` /
 *   `lean-right`) в профиль направлены на камеру и в кадре вырождаются:
 *   описание с ними падает, а не рисует молча неправду.
 * - Тело стоит на полу: опорная стопа всегда на `ground`. Поэтому присед сам
 *   опускает бёдра и плечи в кадре, не меняя длины торса.
 * - `z` всех точек — 0: игра плоская и глубину не судит.
 */
export type StickDesc = {
  /** Отношение сторон кадра, под которое нормируется `x`. */
  aspect: number
  /** Длина торса в долях высоты кадра — ею задаётся дистанция до камеры. */
  torso: number
  /** Середина бёдер по горизонтали, в долях ширины кадра. */
  x: number
  /** Пол: `y` опорной стопы в долях высоты кадра. */
  ground: number
  orientation: Orientation
  /** Куда смотрит тело в профиль: `right` — в сторону `+x` кадра. */
  facing: 'left' | 'right'
  /**
   * Доля боковых размеров тела, остающаяся в кадре: ею задаётся недовёрнутое
   * тело. 1 — строго фронт, `PROFILE_LATERAL` (0.29) — строгий профиль, а
   * числа между дают `shoulderRatio` в полосе «не знаю» между порогами
   * ориентации.
   * Работает и при `orientation: 'front'`: разворот тела — не то же, что выбор
   * того, какие конечности в кадре вырождаются.
   */
  profileLateral?: number
  /** Состояние плеча либо угол вектора плечо→локоть от вертикали. */
  leftShoulder?: ShoulderState | number
  rightShoulder?: ShoulderState | number
  /** То же для профиля: ближняя к камере и дальняя сторона. */
  nearShoulder?: ShoulderState | number
  farShoulder?: ShoulderState | number
  /** Состояние локтя либо угол плечо–локоть–кисть. */
  leftElbow?: ElbowState | number
  rightElbow?: ElbowState | number
  nearElbow?: ElbowState | number
  farElbow?: ElbowState | number
  /** Направление предплечья; задаётся только при согнутом локте. */
  leftForearm?: ForearmState | number
  rightForearm?: ForearmState | number
  nearForearm?: ForearmState | number
  farForearm?: ForearmState | number
  /** Кисти сводятся поворотом руки в плече — локоть и предплечье при этом целы. */
  hands: HandsState
  /** Расстояние между кистями в долях торса — им кисть ставится рядом с порогом. */
  handGap?: number
  /** Состояние разноса стоп либо сам разнос в долях торса. */
  legs: LegsState | number
  /** Опора; при опоре на одну ногу `legs` не участвует — стопа встаёт под центр. */
  support: SupportState
  /** Высота поднятого колена над опорным, в долях торса. */
  raisedKnee?: number
  /** Состояние наклона корпуса либо угол от вертикали (в профиль — к взгляду). */
  lean: LeanState | number
  /**
   * Присед сгибает колени глубже, чем `knees`, и перебивает его. Числом
   * задаётся угол в колене — им присед ставится любой глубины, в том числе
   * рядом с порогом.
   */
  crouch: 'no' | 'yes' | number
  /**
   * Опускает всю фигуру в кадре на столько долей торса, не меняя кинематики
   * (опорная стопа уезжает с `ground` — это сознательное исключение из
   * «тело стоит на полу»). Так голоса приседа по высоте бёдер и плеч
   * отвязываются от угла в колене: присед судится голосованием 2 из 3, и
   * кадр ровно с одним голосом иначе не собрать. Отрицательное — поднимает.
   */
  bodyDrop?: number
  /** Состояние колен либо угол бедро–колено–стопа. */
  knees: 'straight' | 'bent' | number
  /** «Цифра 4»: стопа поднятой ноги у колена опорной. */
  footAtKnee: boolean
  /**
   * То же расстояние стопа–колено опорной ноги числом, в долях торса: им
   * «Цифра 4» ставится рядом с порогом. Перебивает `footAtKnee`.
   */
  footToKnee?: number
  /** `visibility` всех точек. */
  visibility: number
  /** `visibility` отдельных точек — ею проверяются «не знаю» и уход стоп из кадра. */
  visibilityOf: Partial<Record<LandmarkName, number>>
}

type Side = 'left' | 'right'

const D2R = Math.PI / 180

// Пропорции тела в долях длины торса S. Ростовые, не подогнанные под пороги.
/** Ширина плеч 0.86 S — физическое значение из docs/camera-and-pose.md. */
const SHOULDER_HALF = 0.43
const HIP_HALF = 0.22
const UPPER_ARM = 0.6
const FOREARM = 0.5
const HAND = 0.1
const THIGH = 0.83
const SHIN = 0.83
/** Доля боковых размеров тела, остающаяся в кадре при взгляде в профиль. */
const PROFILE_LATERAL = 0.29

// Представители состояний осей. Берутся из середины полос CONFIG, чтобы
// сгенерированное состояние попадало в полосу, а не на её границу.
/**
 * Опорные углы от вертикали. Плечо и предплечье делят и имена, и смысл:
 * `up` — вдоль тела вверх, `side` — наружу, `down` — вниз, `in` — к средней
 * линии. Состояние `front` углом в кадре не выражается и считается отдельно.
 */
const LIMB_ANGLE: Record<Exclude<ShoulderState | ForearmState, 'front'>, number> = {
  up: 0,
  'diag-up': 45,
  side: 90,
  down: 180,
  in: -90,
}
/** Рука на камеру: укорочена и уведена к средней линии корпуса. */
const FRONT_FORESHORTEN = { lat: 0.5, down: 0.1 }
const BENT_ANGLE = (CONFIG.elbow.bentMin + CONFIG.elbow.bentMax) / 2
const CROUCH_KNEE = CONFIG.elbow.bentMin + 5
const LEAN_ANGLE: Record<LeanState, number> = {
  upright: 0,
  'lean-left': (CONFIG.lean.tolerance + CONFIG.lean.horizontal) / 2,
  'lean-right': -(CONFIG.lean.tolerance + CONFIG.lean.horizontal) / 2,
  horizontal: CONFIG.lean.horizontal + 20,
}
const LEG_SPREAD: Record<LegsState, number> = {
  together: CONFIG.legs.together / 2,
  shoulder: (CONFIG.legs.shoulderMin + CONFIG.legs.shoulderMax) / 2,
  wide: (CONFIG.legs.wideMin + CONFIG.legs.wideMax) / 2,
  max: CONFIG.legs.max + 0.2,
}
/** Расстояние между кистями, когда они «вместе» — середина полосы CONFIG. */
const HAND_GAP = Math.min(CONFIG.hands.overHead, CONFIG.hands.inFront) / 2

const DEFAULTS: StickDesc = {
  aspect: 16 / 9,
  torso: 0.22,
  x: 0.5,
  ground: 0.95,
  orientation: 'front',
  facing: 'right',
  hands: 'no',
  legs: 'together',
  support: 'both',
  lean: 'upright',
  crouch: 'no',
  knees: 'straight',
  footAtKnee: false,
  visibility: 1,
  visibilityOf: {},
}

const v = (x: number, y: number): Pt => ({ x, y })
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const mul = (p: Pt, k: number): Pt => ({ x: p.x * k, y: p.y * k })
const len = (p: Pt): number => Math.hypot(p.x, p.y)
const unit = (p: Pt): Pt => {
  const l = len(p)
  return l === 0 ? v(0, 0) : mul(p, 1 / l)
}
const rot = (p: Pt, deg: number): Pt => {
  const c = Math.cos(deg * D2R)
  const s = Math.sin(deg * D2R)
  return v(p.x * c - p.y * s, p.x * s + p.y * c)
}
/** Единичный вектор под углом `deg` от вертикали вверх, растущим в сторону `sign`. */
const fromVertical = (deg: number, sign: number): Pt =>
  v(sign * Math.sin(deg * D2R), -Math.cos(deg * D2R))

/** Колено (или локоть) по двум звеньям: изгиб уводится в сторону `bend`. */
function joint(root: Pt, tip: Pt, first: number, second: number, bend: Pt): Pt {
  const span = sub(tip, root)
  const l = Math.min(len(span), first + second)
  if (l === 0) return add(root, mul(unit(bend), first))
  const dir = unit(span)
  const along = (first * first - second * second + l * l) / (2 * l)
  const out = Math.sqrt(Math.max(0, first * first - along * along))
  const normal = v(-dir.y, dir.x)
  const side = normal.x * bend.x + normal.y * bend.y >= 0 ? normal : mul(normal, -1)
  return add(add(root, mul(dir, along)), mul(side, out))
}

export function stick(desc: Partial<StickDesc> = {}): Landmarks {
  const d: StickDesc = { ...DEFAULTS, ...desc }
  if (!Number.isFinite(d.aspect) || d.aspect <= 0) {
    throw new Error('stick: aspect обязан быть положительным числом')
  }

  const profile = d.orientation === 'profile'
  const facing = d.facing === 'right' ? 1 : -1
  const near: Side = d.facing === 'right' ? 'right' : 'left'

  /** Знак бокового смещения точки стороны `side` по `x` кадра. */
  const lat = (side: Side): number => {
    if (!profile) return side === 'left' ? 1 : -1
    return side === near ? facing : -facing
  }
  /** Знак, в который растут углы конечностей этой стороны. */
  const limbSign = (side: Side): number => (profile ? facing : lat(side))
  const latScale = d.profileLateral ?? (profile ? PROFILE_LATERAL : 1)

  /** Сводит пару `left`/`right` с парой `near`/`far` и падает на двойном задании. */
  function pickSide<T>(
    side: Side,
    own: T | undefined,
    nearValue: T | undefined,
    farValue: T | undefined,
    what: string,
  ): T | undefined {
    const paired = side === near ? nearValue : farValue
    if (own !== undefined && paired !== undefined) {
      throw new Error(`stick: ${what} задан(о) и по сторонам, и через near/far — одна сторона дважды`)
    }
    return own ?? paired
  }

  const shoulderStateOf = (side: Side): ShoulderState | number =>
    pickSide(
      side,
      side === 'left' ? d.leftShoulder : d.rightShoulder,
      d.nearShoulder,
      d.farShoulder,
      'плечо',
    ) ?? 'down'
  const elbowStateOf = (side: Side): ElbowState | number =>
    pickSide(side, side === 'left' ? d.leftElbow : d.rightElbow, d.nearElbow, d.farElbow, 'локоть') ??
    'straight'
  const forearmStateOf = (side: Side): ForearmState | number | undefined =>
    pickSide(
      side,
      side === 'left' ? d.leftForearm : d.rightForearm,
      d.nearForearm,
      d.farForearm,
      'предплечье',
    )

  /** Направление звена: длина ≤ 1, укороченная у состояний «на камеру». */
  function limbDir(state: ShoulderState | ForearmState | number, side: Side): Pt {
    const sign = limbSign(side)
    if (typeof state === 'number') return fromVertical(state, sign)
    if (state === 'front') {
      return profile ? v(facing, 0) : v(-sign * FRONT_FORESHORTEN.lat, FRONT_FORESHORTEN.down)
    }
    if ((state === 'side' || state === 'in') && profile) {
      throw new Error(`stick: состояние ${state} направлено на камеру и в профиль не выражается`)
    }
    return fromVertical(LIMB_ANGLE[state], sign)
  }

  const leanState = d.lean
  if (profile && typeof leanState === 'string' && leanState.startsWith('lean-')) {
    throw new Error(`stick: наклон ${leanState} направлен на камеру и в профиль не выражается`)
  }
  const leanDeg =
    (typeof leanState === 'number' ? leanState : LEAN_ANGLE[leanState]) * (profile ? facing : 1)

  // --- корпус -------------------------------------------------------------
  const hipMid = v(0, 0)
  /** Направление «вверх по торсу». */
  const up = fromVertical(leanDeg, 1)
  /** Перпендикуляр торса: в него откладываются боковые размеры тела. */
  const across = v(-up.y, up.x)
  const shoulderMid = add(hipMid, up)

  const hip = (side: Side): Pt => v(lat(side) * HIP_HALF * latScale, 0)
  const shoulder = (side: Side): Pt =>
    add(shoulderMid, mul(across, lat(side) * SHOULDER_HALF * latScale))

  // --- ноги ---------------------------------------------------------------
  /** Угол в колене: присед перебивает `knees`, число перебивает состояние. */
  const kneeAngle = (): number => {
    if (typeof d.crouch === 'number') return d.crouch
    if (d.crouch === 'yes') return CROUCH_KNEE
    if (typeof d.knees === 'number') return d.knees
    return d.knees === 'bent' ? BENT_ANGLE : 180
  }
  const kneeDeg = kneeAngle()
  const reach = 2 * THIGH * Math.sin((kneeDeg / 2) * D2R)
  const spread = typeof d.legs === 'number' ? d.legs : LEG_SPREAD[d.legs]
  const kneeBend = (side: Side): Pt => (profile ? v(facing, 0) : v(lat(side), 0))

  const ankle: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const knee: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }

  /** Прямая (или подогнутая по `reach`) нога с заданным `x` стопы. */
  const standLeg = (side: Side, ankleX: number): void => {
    const root = hip(side)
    const dx = ankleX - root.x
    ankle[side] = v(ankleX, Math.sqrt(Math.max(reach * reach - dx * dx, 0.01)))
    knee[side] = joint(root, ankle[side], THIGH, SHIN, kneeBend(side))
  }

  if (d.support === 'both') {
    standLeg('left', lat('left') * (spread / 2))
    standLeg('right', lat('right') * (spread / 2))
  } else {
    const stand: Side = d.support
    const raised: Side = stand === 'left' ? 'right' : 'left'
    standLeg(stand, 0)
    // Стопа у колена опорной ноги и высоко поднятое колено тянут в разные
    // стороны, поэтому при «Цифре 4» колено по умолчанию ниже.
    const atKnee = d.footToKnee !== undefined || d.footAtKnee
    const lift =
      d.raisedKnee ??
      (atKnee ? CONFIG.support.kneeHeightDiff + 0.15 : CONFIG.support.kneeHeightDiff * 2)
    const kneeY = knee[stand].y - lift
    const root = hip(raised)
    const out = profile ? facing : lat(raised)
    const dy = kneeY - root.y
    knee[raised] = v(root.x + out * Math.sqrt(Math.max(THIGH * THIGH - dy * dy, 0)), kneeY)
    if (d.footToKnee !== undefined) {
      // Стопа на голени от поднятого колена и на заданном расстоянии от
      // опорного — та же засечка двух звеньев, что и у самого колена.
      ankle[raised] = joint(knee[raised], knee[stand], SHIN, d.footToKnee, v(-out, 1))
      const got = len(sub(ankle[raised], knee[stand]))
      if (Math.abs(got - d.footToKnee) > 0.01) {
        throw new Error(
          `stick: стопа не достаёт до ${d.footToKnee} S от колена опорной ноги (вышло ${got.toFixed(2)}) — подвиньте raisedKnee`,
        )
      }
    } else if (d.footAtKnee) {
      ankle[raised] = add(knee[raised], mul(unit(sub(knee[stand], knee[raised])), SHIN))
    } else {
      ankle[raised] = add(knee[raised], mul(unit(v(out * 0.35, 1)), SHIN))
    }
  }

  // --- руки ---------------------------------------------------------------
  const elbow: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const wrist: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const palm: Record<Side, Pt[]> = { left: [], right: [] }

  for (const side of ['left', 'right'] as const) {
    const shoulderState = shoulderStateOf(side)
    const elbowState = elbowStateOf(side)
    const forearmState = forearmStateOf(side)
    const elbowDeg =
      typeof elbowState === 'number' ? elbowState : elbowState === 'straight' ? 180 : BENT_ANGLE
    const bent = elbowDeg < CONFIG.elbow.straightMin
    if (forearmState !== undefined && !bent) {
      throw new Error('stick: предплечье задано при прямом локте — судить его тогда не на чем')
    }

    const upper = limbDir(shoulderState, side)
    elbow[side] = add(shoulder(side), mul(upper, UPPER_ARM))

    let fore: Pt
    if (!bent) {
      fore = upper
    } else if (forearmState !== undefined) {
      fore = limbDir(forearmState, side)
    } else {
      // Локоть согнут, а предплечье не задано: сгибаем так, чтобы угол в
      // локте вышел ровно заданным, а кисть ушла вверх.
      const turn = 180 - elbowDeg
      const a = rot(unit(upper), turn)
      const b = rot(unit(upper), -turn)
      const outward = limbSign(side)
      fore =
        Math.abs(a.y - b.y) > 1e-9
          ? a.y < b.y
            ? a
            : b
          : a.x * outward >= b.x * outward
            ? a
            : b
    }
    wrist[side] = add(elbow[side], mul(fore, FOREARM))

    const along = unit(fore)
    const sideways = v(-along.y, along.x)
    palm[side] = [
      add(wrist[side], mul(along, HAND * 0.9)), // pinky
      add(wrist[side], mul(along, HAND)), // index
      add(add(wrist[side], mul(along, HAND * 0.6)), mul(sideways, 0.04)), // thumb
    ]
  }

  if (d.hands !== 'no') {
    const gap = d.handGap ?? HAND_GAP
    for (const side of ['left', 'right'] as const) {
      const root = shoulder(side)
      // Насколько надо довернуть руку, чтобы кисть встала на свою половину зазора.
      const wanted = lat(side) * (gap / 2) - (root.x * across.x + root.y * across.y)
      const arm = sub(wrist[side], root)
      const a = arm.x * across.x + arm.y * across.y
      const b = arm.x * across.y - arm.y * across.x
      const radius = Math.hypot(a, b)
      let turn = 0
      if (radius > 0) {
        const delta = Math.acos(Math.max(-1, Math.min(1, wanted / radius))) / D2R
        const base = Math.atan2(b, a) / D2R
        const first = base + delta
        const second = base - delta
        turn = Math.abs(first) <= Math.abs(second) ? first : second
      }
      const swing = (p: Pt): Pt => add(root, rot(sub(p, root), turn))
      elbow[side] = swing(elbow[side])
      wrist[side] = swing(wrist[side])
      palm[side] = palm[side].map(swing)
    }
  }

  // --- голова -------------------------------------------------------------
  const head = (upward: number, sideways: number, forward: number): Pt => {
    const base = add(add(shoulderMid, mul(up, upward)), mul(across, sideways * latScale))
    return profile ? add(base, v(facing * forward, 0)) : base
  }

  if (d.hands === 'over-head') {
    const eyeY = head(0.45, 0, 0).y
    if (wrist.left.y > eyeY || wrist.right.y > eyeY) {
      throw new Error('stick: кисти over-head требуют поднятых рук — так они ниже головы')
    }
  }
  if (d.hands === 'in-front') {
    for (const side of ['left', 'right'] as const) {
      if (wrist[side].y < shoulderMid.y || wrist[side].y > hipMid.y + 0.1) {
        throw new Error('stick: кисти in-front требуют рук на высоте груди')
      }
    }
  }

  // --- стопы --------------------------------------------------------------
  const heel = (side: Side): Pt =>
    add(ankle[side], profile ? v(-facing * 0.12, 0.05) : v(-lat(side) * 0.03, 0.05))
  const toe = (side: Side): Pt =>
    add(ankle[side], profile ? v(facing * 0.25, 0.08) : v(lat(side) * 0.05, 0.1))

  // --- проекция в кадр ----------------------------------------------------
  const floor = d.support === 'both' ? Math.max(ankle.left.y, ankle.right.y) : ankle[d.support].y
  const y0 = d.ground - (floor - (d.bodyDrop ?? 0)) * d.torso
  const out = new Float32Array(LANDMARK_COUNT * LANDMARK_STRIDE)
  const put = (i: number, p: Pt): void => {
    const base = i * LANDMARK_STRIDE
    out[base] = d.x + (p.x * d.torso) / d.aspect
    out[base + 1] = y0 + p.y * d.torso
    out[base + 2] = 0
    out[base + 3] = d.visibility
  }

  put(LM.nose, head(0.37, 0, 0.22))
  put(LM.leftEyeInner, head(0.45, 0.03, 0.16))
  put(LM.leftEye, head(0.45, 0.06, 0.14))
  put(LM.leftEyeOuter, head(0.45, 0.09, 0.1))
  put(LM.rightEyeInner, head(0.45, -0.03, 0.16))
  put(LM.rightEye, head(0.45, -0.06, 0.14))
  put(LM.rightEyeOuter, head(0.45, -0.09, 0.1))
  put(LM.leftEar, head(0.43, 0.12, -0.05))
  put(LM.rightEar, head(0.43, -0.12, -0.05))
  put(LM.mouthLeft, head(0.3, 0.05, 0.18))
  put(LM.mouthRight, head(0.3, -0.05, 0.18))

  put(LM.leftShoulder, shoulder('left'))
  put(LM.rightShoulder, shoulder('right'))
  put(LM.leftElbow, elbow.left)
  put(LM.rightElbow, elbow.right)
  put(LM.leftWrist, wrist.left)
  put(LM.rightWrist, wrist.right)
  put(LM.leftPinky, palm.left[0])
  put(LM.rightPinky, palm.right[0])
  put(LM.leftIndex, palm.left[1])
  put(LM.rightIndex, palm.right[1])
  put(LM.leftThumb, palm.left[2])
  put(LM.rightThumb, palm.right[2])

  put(LM.leftHip, hip('left'))
  put(LM.rightHip, hip('right'))
  put(LM.leftKnee, knee.left)
  put(LM.rightKnee, knee.right)
  put(LM.leftAnkle, ankle.left)
  put(LM.rightAnkle, ankle.right)
  put(LM.leftHeel, heel('left'))
  put(LM.rightHeel, heel('right'))
  put(LM.leftFootIndex, toe('left'))
  put(LM.rightFootIndex, toe('right'))

  for (const [name, value] of Object.entries(d.visibilityOf)) {
    if (value !== undefined) out[LM[name as LandmarkName] * LANDMARK_STRIDE + 3] = value
  }

  return out
}
