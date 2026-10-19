import { CONFIG } from './config'
import type {
  ElbowState,
  ForearmState,
  HandsState,
  LeanState,
  LegsState,
  Pt,
  PoseSpec,
  ShoulderState,
  SupportState,
} from './types'

/**
 * Схематичная фигура позы: окружность головы и звенья скелета.
 *
 * Координаты нормированы в `0..1` и лежат в КВАДРАТНОЙ области: масштаб по
 * обеим осям один, иначе фигура растягивалась бы вместе с рамкой. `y` растёт
 * вниз — как у кадра MediaPipe и у холста. Куда положить этот квадрат, решает
 * тот, кто рисует (превью или маска выреза).
 *
 * Порядок `bones` — часть контракта: торс, плечи, бёдра, левая рука (плечо,
 * предплечье), правая рука, левая нога (бедро, голень, стопа), правая нога,
 * шея. Первые тринадцать выражены теми же точками, что MediaPipe, — на этом
 * стоит сверка с синтетическим скелетом; шея упирается в окружность головы.
 */
export type Figure = {
  head: { c: Pt; r: number }
  bones: Array<[Pt, Pt]>
}

const F = CONFIG.figure
const D2R = Math.PI / 180

/**
 * Куда смотрит профильная фигура: в `+x`, то есть вправо по кадру.
 *
 * Сторона выбрана, а не выведена: зеркала у профильной позы нет, потому что
 * `near`/`far` отсчитываются ОТ КАМЕРЫ, и повёрнутая в другую сторону поза
 * даёт судейству те же показания осей. Следствие принято сознательно —
 * профильная поза РИСУЕТСЯ в одну сторону, а ПРИНИМАЕТСЯ в любую.
 */
const PROFILE_FACING = 1

/**
 * Опорные углы от вертикали, растущие наружу своей стороны. Те же, по которым
 * судит `axes()` и строит синтетический скелет: `up` — вдоль тела вверх,
 * `side` — наружу, `down` — вниз, `in` — к средней линии. Состояние `front`
 * углом в кадре не выражается и считается отдельно.
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
const CROUCH_KNEE = CONFIG.knee.crouchDeep
const LEAN_ANGLE: Record<LeanState, number> = {
  upright: 0,
  'lean-left': (CONFIG.lean.tolerance + CONFIG.lean.horizontal) / 2,
  'lean-right': -(CONFIG.lean.tolerance + CONFIG.lean.horizontal) / 2,
  horizontal: CONFIG.lean.horizontal + 20,
}
const LEG_SPREAD: Record<LegsState, number> = {
  together: CONFIG.legs.ankle.together / 2,
  shoulder: (CONFIG.legs.ankle.shoulderMin + CONFIG.legs.ankle.shoulderMax) / 2,
  wide: (CONFIG.legs.ankle.wideMin + CONFIG.legs.ankle.wideMax) / 2,
  max: CONFIG.legs.ankle.max + 0.2,
}
/** Расстояние между сведёнными кистями — середина полосы, в которой их судят. */
const HAND_GAP = Math.min(CONFIG.hands.overHead, CONFIG.hands.inFront) / 2
/**
 * Свободная нога. Подъём колена над опорным взят от порога, которым опору
 * судят, а при «Цифре 4» он ниже: стопа у колена опорной ноги и высоко
 * поднятое колено тянут в разные стороны. Числа — те же, что у синтетического
 * скелета: фигура и скелет обязаны разводить ноги одинаково.
 */
const RAISED_KNEE = CONFIG.support.kneeHeightDiff * 2
const RAISED_KNEE_AT_FOUR = CONFIG.support.kneeHeightDiff + 0.15
/** Наклон свободной голени, когда стопа не приведена к колену опорной. */
const FREE_SHIN_OUT = 0.35

type Side = 'left' | 'right'

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

/**
 * Фигура позы прямой кинематикой из требуемых состояний осей.
 *
 * **Единственный источник формы — и для превью, и для маски выреза.** Две
 * копии геометрии разъехались бы, и ребёнок не попадал бы в вырез, который
 * видит; у препятствия ровно тот же инвариант — число, по которому судят, и
 * форма, которую рисуют, берутся из одного места.
 *
 * Тот же инвариант связывает фигуру с синтетическим скелетом `fake/stick.ts`:
 * из его планарной кинематики выведены полосы `CONFIG.legs.knee`, по которым
 * судится разнос ног при невидимых стопах. Поэтому соглашения о длинах
 * звеньев, о направлении сгиба колена и о сведении кистей здесь ровно те же;
 * импортировать скелет ядру нельзя (он снаружи границы слоёв), поэтому
 * совпадение сторожит тест, сверяющий фигуру со скелетом звено в звено.
 *
 * Ось, которую поза не требует, берётся в нейтральном состоянии: ноги вместе,
 * опора на двух, корпус прямо, колени прямые, плечи вниз, локти прямые.
 */
export function figure(spec: PoseSpec): Figure {
  const r = spec.requires
  const profile = spec.orientation === 'profile'
  const facing = PROFILE_FACING
  const near: Side = facing === 1 ? 'right' : 'left'
  const latScale = profile ? F.profileLateral : 1

  /** Знак бокового смещения точки стороны `side` по `x` кадра. Камера не зеркалит. */
  const lat = (side: Side): number => {
    if (!profile) return side === 'left' ? 1 : -1
    return side === near ? facing : -facing
  }
  /** Знак, в который растут углы конечностей этой стороны. */
  const limbSign = (side: Side): number => (profile ? facing : lat(side))

  /** Требование стороны: во фронт оно левое/правое, в профиль — ближнее/дальнее. */
  const shoulderOf = (side: Side): ShoulderState | undefined =>
    profile
      ? side === near
        ? r.nearShoulder
        : r.farShoulder
      : side === 'left'
        ? r.leftShoulder
        : r.rightShoulder
  const elbowOf = (side: Side): ElbowState =>
    (profile
      ? side === near
        ? r.nearElbow
        : r.farElbow
      : side === 'left'
        ? r.leftElbow
        : r.rightElbow) ?? 'straight'
  const forearmOf = (side: Side): ForearmState | undefined =>
    profile
      ? side === near
        ? r.nearForearm
        : r.farForearm
      : side === 'left'
        ? r.leftForearm
        : r.rightForearm

  /** Направление звена: длина ≤ 1, укороченная у состояний «на камеру». */
  function limbDir(state: ShoulderState | ForearmState, side: Side): Pt {
    const sign = limbSign(side)
    if (state === 'front') {
      return profile ? v(facing, 0) : v(-sign * FRONT_FORESHORTEN.lat, FRONT_FORESHORTEN.down)
    }
    if ((state === 'side' || state === 'in') && profile) {
      throw new Error(`figure: состояние ${state} направлено на камеру и в профиль не рисуется`)
    }
    return fromVertical(LIMB_ANGLE[state], sign)
  }

  const leanState: LeanState = r.lean ?? 'upright'
  if (profile && leanState.startsWith('lean-')) {
    throw new Error(`figure: наклон ${leanState} направлен на камеру и в профиль не рисуется`)
  }
  const leanDeg = LEAN_ANGLE[leanState] * (profile ? facing : 1)

  // --- корпус -------------------------------------------------------------
  const hipMid = v(0, 0)
  /** Направление «вверх по торсу». */
  const up = fromVertical(leanDeg, 1)
  /** Перпендикуляр торса: в него откладываются боковые размеры тела. */
  const across = v(-up.y, up.x)
  const shoulderMid = add(hipMid, up)

  const hip = (side: Side): Pt => v(lat(side) * F.hipHalf * latScale, 0)
  const shoulder = (side: Side): Pt =>
    add(shoulderMid, mul(across, lat(side) * F.shoulderHalf * latScale))

  // --- ноги ---------------------------------------------------------------
  const crouch = r.crouch ?? 'no'
  const kneeDeg =
    crouch === 'yes' ? CROUCH_KNEE : (r.knees ?? 'straight') === 'bent' ? BENT_ANGLE : 180
  const reach = 2 * F.thigh * Math.sin((kneeDeg / 2) * D2R)
  const spread = LEG_SPREAD[r.legs ?? 'together']
  const kneeBend = (side: Side): Pt => (profile ? v(facing, 0) : v(lat(side), 0))
  const support: SupportState = r.support ?? 'both'

  const ankle: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const knee: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }

  /** Прямая (или подогнутая по `reach`) нога с заданным `x` стопы. */
  const standLeg = (side: Side, ankleX: number): void => {
    const root = hip(side)
    const dx = ankleX - root.x
    ankle[side] = v(ankleX, Math.sqrt(Math.max(reach * reach - dx * dx, 0.01)))
    knee[side] = joint(root, ankle[side], F.thigh, F.shin, kneeBend(side))
  }

  if (support === 'both') {
    standLeg('left', lat('left') * (spread / 2))
    standLeg('right', lat('right') * (spread / 2))
  } else {
    const stand: Side = support
    const raised: Side = stand === 'left' ? 'right' : 'left'
    standLeg(stand, 0)
    const atKnee = r.footAtKnee === true
    const kneeY = knee[stand].y - (atKnee ? RAISED_KNEE_AT_FOUR : RAISED_KNEE)
    const root = hip(raised)
    const out = profile ? facing : lat(raised)
    const dy = kneeY - root.y
    knee[raised] = v(root.x + out * Math.sqrt(Math.max(F.thigh * F.thigh - dy * dy, 0)), kneeY)
    ankle[raised] = atKnee
      ? add(knee[raised], mul(unit(sub(knee[stand], knee[raised])), F.shin))
      : add(knee[raised], mul(unit(v(out * FREE_SHIN_OUT, 1)), F.shin))
  }

  // --- руки ---------------------------------------------------------------
  const hands: HandsState = r.hands ?? 'no'
  const elbow: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const wrist: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }

  /** Угол звена `a→b` от вертикали — та же мера, в которой его судит ядро. */
  const limbAngleOf = (a: Pt, b: Pt, side: Side): number =>
    Math.atan2((b.x - a.x) * limbSign(side), -(b.y - a.y)) / D2R
  /** Отклонение точки от средней линии корпуса: им ядро опознаёт «на камеру». */
  const devFromMid = (p: Pt): number => Math.abs(p.x * across.x + p.y * across.y)
  /** Расхождение углов по кругу: 180° и −180° — один угол. */
  const angleDev = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

  /**
   * Уцелело ли ОПИСАННОЕ состояние звена после доворота руки под кисти.
   * Нейтральное состояние (плечо `down`, незаданное предплечье) описанием не
   * считается — его доворот вправе менять, и именно на нём держится
   * «Космическая ракета»: прямые руки вверх при сведённых кистях физически
   * наклонены внутрь.
   */
  const keptLimb = (
    desc: ShoulderState | ForearmState | undefined,
    angle: number,
    tolerance: number,
    nearMid: boolean,
  ): boolean => {
    if (desc === undefined) return true
    if (desc === 'front') return profile ? angleDev(angle, LIMB_ANGLE.side) < tolerance : nearMid
    return angleDev(angle, LIMB_ANGLE[desc]) < tolerance
  }

  for (const side of ['left', 'right'] as const) {
    const shoulderDesc = shoulderOf(side)
    const forearmDesc = forearmOf(side)
    const bent = elbowOf(side) === 'bent'
    const elbowDeg = bent ? BENT_ANGLE : 180

    const upper = limbDir(shoulderDesc ?? 'down', side)
    const elbowAt = add(shoulder(side), mul(upper, F.upperArm))

    /**
     * Направления предплечья, между которыми выбор ещё есть. Их два и только
     * тогда, когда локоть согнут, а предплечье не описано: сам угол в локте
     * этим выбором не меняется, меняется лишь сторона сгиба.
     */
    let fores: Pt[]
    if (!bent) {
      fores = [upper]
    } else if (forearmDesc !== undefined) {
      fores = [limbDir(forearmDesc, side)]
    } else {
      const turn = 180 - elbowDeg
      const a = rot(unit(upper), turn)
      const b = rot(unit(upper), -turn)
      const outward = limbSign(side)
      const first =
        Math.abs(a.y - b.y) > 1e-9
          ? a.y < b.y
            ? a
            : b
          : a.x * outward >= b.x * outward
            ? a
            : b
      fores = [first, first === a ? b : a]
    }

    const options = fores.map((fore) => ({
      elbow: elbowAt,
      wrist: add(elbowAt, mul(fore, F.forearm)),
    }))

    if (hands === 'no') {
      elbow[side] = options[0].elbow
      wrist[side] = options[0].wrist
      continue
    }

    // Кисти сводятся доворотом руки вокруг плеча — угол в локте при этом цел,
    // а абсолютные углы плеча и предплечья доворот МЕНЯЕТ. Поэтому
    // перебираются остатки свободы (сторона сгиба × два корня доворота) и
    // берётся первый, на котором описанные состояния ещё читаются как заданы.
    const root = shoulder(side)
    /** Куда по поперечнику корпуса обязана встать кисть этой стороны. */
    const wanted = lat(side) * (HAND_GAP / 2) - (root.x * across.x + root.y * across.y)
    let placed: { elbow: Pt; wrist: Pt } | null = null

    for (const arm of options) {
      const span = sub(arm.wrist, root)
      const a = span.x * across.x + span.y * across.y
      const b = span.x * across.y - span.y * across.x
      const radius = Math.hypot(a, b)
      let turns: number[] = [0]
      if (radius > 0) {
        const delta = Math.acos(Math.max(-1, Math.min(1, wanted / radius))) / D2R
        const base = Math.atan2(b, a) / D2R
        const first = base + delta
        const second = base - delta
        turns = Math.abs(first) <= Math.abs(second) ? [first, second] : [second, first]
      }
      for (const turn of turns) {
        const swing = (p: Pt): Pt => add(root, rot(sub(p, root), turn))
        const swung = { elbow: swing(arm.elbow), wrist: swing(arm.wrist) }
        const kept =
          keptLimb(
            shoulderDesc,
            limbAngleOf(root, swung.elbow, side),
            CONFIG.shoulder.tolerance,
            devFromMid(swung.elbow) < CONFIG.shoulder.front &&
              devFromMid(swung.wrist) < CONFIG.shoulder.front,
          ) &&
          keptLimb(
            forearmDesc,
            limbAngleOf(swung.elbow, swung.wrist, side),
            CONFIG.forearm.tolerance,
            devFromMid(swung.wrist) < CONFIG.shoulder.front,
          )
        if (kept) {
          placed = swung
          break
        }
      }
      if (placed !== null) break
    }

    if (placed === null) {
      throw new Error(
        `figure: кисти ${hands} не сводятся, не выведя описанную руку (${side}) из её полос`,
      )
    }
    elbow[side] = placed.elbow
    wrist[side] = placed.wrist
  }

  // --- голова и стопы -----------------------------------------------------
  const headCenter = add(shoulderMid, mul(up, F.headUp))
  /** Низ окружности головы: в него упирается шея. */
  const headBottom = add(headCenter, mul(up, -F.headRadius))
  const toe = (side: Side): Pt =>
    add(
      ankle[side],
      profile
        ? v(facing * F.toeProfile.x, F.toeProfile.y)
        : v(lat(side) * F.toeFront.x, F.toeFront.y),
    )

  const bones: Array<[Pt, Pt]> = [
    [hipMid, shoulderMid],
    [shoulder('left'), shoulder('right')],
    [hip('left'), hip('right')],
    [shoulder('left'), elbow.left],
    [elbow.left, wrist.left],
    [shoulder('right'), elbow.right],
    [elbow.right, wrist.right],
    [hip('left'), knee.left],
    [knee.left, ankle.left],
    [ankle.left, toe('left')],
    [hip('right'), knee.right],
    [knee.right, ankle.right],
    [ankle.right, toe('right')],
    [shoulderMid, headBottom],
  ]

  // --- рамка --------------------------------------------------------------
  // Масштаб ОДИН для всех поз, поэтому рамка только сдвигает фигуру: по
  // горизонтали — центром тела (той же точкой, по которой камера судит
  // центровку игрока) в середину, по вертикали — самой нижней точкой на пол.
  const bodyCenter = mul(add(hipMid, shoulderMid), 0.5)
  const lowest = Math.max(
    headCenter.y + F.headRadius,
    ...bones.flatMap(([a, b]) => [a.y, b.y]),
  )
  const pad = F.stroke / 2
  const place = (p: Pt): Pt => ({
    x: 0.5 + (p.x - bodyCenter.x) * F.scale,
    y: 1 - pad - (lowest - p.y) * F.scale,
  })

  return {
    head: { c: place(headCenter), r: F.headRadius * F.scale },
    bones: bones.map(([a, b]) => [place(a), place(b)]),
  }
}
