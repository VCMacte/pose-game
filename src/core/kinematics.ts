import { CONFIG } from './config'
import type {
  ElbowState,
  ForearmState,
  HandsState,
  LeanState,
  LegsState,
  Orientation,
  Pt,
  ShoulderState,
  SupportState,
} from './types'

/** Сторона тела. Анатомическая: `left` — левая у игрока, а не на картинке. */
export type Side = 'left' | 'right'

/**
 * Описание позы для кинематики: состояния осей плюс выбор стороны поворота.
 *
 * Каждое состояние можно задать ЧИСЛОМ — тем самым углом или расстоянием, —
 * и тогда представитель состояния не используется. Это нужно тестам ядра:
 * только числом поза ставится вплотную к порогу. Незаданная ось берётся в
 * нейтральном состоянии: ноги вместе, опора на двух, корпус прямо, колени
 * прямые, плечи вниз, локти прямые, кисти врозь.
 */
export type KinematicDesc = {
  orientation?: Orientation
  /** Куда смотрит тело в профиль: `right` — в сторону `+x` кадра. */
  facing?: 'left' | 'right'
  /**
   * Доля боковых размеров тела, остающаяся в кадре: ею задаётся недовёрнутое
   * тело. 1 — строго фронт, `CONFIG.figure.profileLateral` — профиль, числа
   * между дают `shoulderRatio` в полосе «не знаю» между порогами ориентации.
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
  /**
   * Кисти сводятся доворотом руки вокруг плеча: угол в локте при этом цел, а
   * ОПИСАННЫЕ состояния плеча и предплечья доворот перебивать не вправе — он
   * перебирает остатки свободы (сторону сгиба и второй корень доворота) и
   * падает, если ни на одном описанная рука не осталась в своих полосах.
   */
  hands?: HandsState
  /** Расстояние между кистями в долях торса — им кисть ставится рядом с порогом. */
  handGap?: number
  /** Состояние разноса стоп либо сам разнос в долях торса. */
  legs?: LegsState | number
  /** Опора; при опоре на одну ногу `legs` не участвует — стопа встаёт под центр. */
  support?: SupportState
  /** Высота поднятого колена над опорным, в долях торса. */
  raisedKnee?: number
  /** Состояние наклона корпуса либо угол от вертикали (в профиль — к взгляду). */
  lean?: LeanState | number
  /**
   * Присед сгибает колени глубже, чем `knees`, и перебивает его. Числом
   * задаётся угол в колене — им присед ставится любой глубины, в том числе
   * рядом с порогом.
   */
  crouch?: 'no' | 'yes' | number
  /** Состояние колен либо угол бедро–колено–стопа. */
  knees?: 'straight' | 'bent' | number
  /** «Цифра 4»: стопа поднятой ноги у колена опорной. */
  footAtKnee?: boolean
  /**
   * То же расстояние стопа–колено опорной ноги числом, в долях торса: им
   * «Цифра 4» ставится рядом с порогом. Перебивает `footAtKnee`.
   */
  footToKnee?: number
}

/**
 * Суставы позы в долях торса. Всё, из чего обоим потребителям собрать свою
 * картинку: сами точки, оси корпуса и разрешённые стороны.
 */
export type Joints = {
  /** Профильная проекция: боковые размеры тела сжаты, боковые состояния запрещены. */
  profile: boolean
  /** Знак направления взгляда по `x`: `+1` — вправо по кадру. */
  facing: number
  /** Сторона тела, обращённая к камере в профиль. */
  near: Side
  /** Разрешённая опора: ею потребитель находит пол. */
  support: SupportState
  /** Единичное направление «вверх по торсу». */
  up: Pt
  /** Перпендикуляр торса: в него отложены боковые размеры тела. */
  across: Pt
  hipMid: Pt
  shoulderMid: Pt
  hip: Record<Side, Pt>
  shoulder: Record<Side, Pt>
  elbow: Record<Side, Pt>
  wrist: Record<Side, Pt>
  /** Три точки ладони — мизинец, указательный, большой, в порядке MediaPipe. */
  palm: Record<Side, Pt[]>
  knee: Record<Side, Pt>
  ankle: Record<Side, Pt>
  heel: Record<Side, Pt>
  toe: Record<Side, Pt>
  /**
   * Точка головы: `upward` — вдоль торса вверх от середины плеч, `sideways` —
   * по поперечнику тела (сжимается вместе с ним), `forward` — в сторону
   * взгляда и только в профиль.
   */
  head: (upward: number, sideways: number, forward: number) => Pt
}

/**
 * Геометрия тела. Единственный дом этих чисел — `CONFIG.figure`: они не
 * выведены из порогов судейства и обязаны совпадать у рисунка и у скелета,
 * потому что полосы `CONFIG.legs.knee` выведены из этой самой кинематики.
 */
const F = CONFIG.figure
const D2R = Math.PI / 180

// --- представители состояний ----------------------------------------------
// Числа, ВЫВЕДЕННЫЕ из порогов судейства: середины полос `CONFIG`, чтобы
// сгенерированная поза попадала в полосу, а не на её границу. В `CONFIG` им
// места нет — там они были бы вторыми копиями самих порогов.

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
/**
 * Угол в колене глубокого приседа — берётся из независимого порога
 * `CONFIG.knee.crouchDeep`, а не вычисляется из `CONFIG.knee.crouchVoteMax`:
 * из этого же числа выведены полосы разноса КОЛЕН (`CONFIG.legs.knee`), и
 * связь `crouchDeep < crouchVoteMax` проверяется тестом, а не арифметикой.
 */
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
 * Подъём свободного колена над опорным. Взят от порога, которым опору судят, а
 * при «Цифре 4» он ниже: стопа у колена опорной ноги и высоко поднятое колено
 * тянут в разные стороны.
 */
const RAISED_KNEE = CONFIG.support.kneeHeightDiff * 2
const RAISED_KNEE_AT_FOUR = CONFIG.support.kneeHeightDiff + 0.15
/** Наклон свободной голени, когда стопа не приведена к колену опорной. */
const FREE_SHIN_OUT = 0.35

// --- векторная мелочь ------------------------------------------------------

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

/**
 * Запас на счётный шум там, где звенья вытянуты в прямую: засечка двух звеньев
 * длиной `a + b` до точки на расстоянии ровно `a + b` даёт `l`, отличающийся
 * от суммы на единицы последнего разряда. Настоящая недостижимость — порядка
 * 0.1 S, то есть в сто миллионов раз грубее.
 */
const SLACK = 1e-9

/**
 * Колено (или локоть) по двум звеньям: изгиб уводится в сторону `bend`.
 *
 * Недостающий пролёт — НЕ зажим: точка `tip` осталась бы там, где запрошена, а
 * сочленение решилось бы по укороченному пролёту, и звено `[сочленение, tip]`
 * перестало бы быть длиной второго звена. Молча выдать фигуру с голенью не той
 * длины нельзя: ровно это ребёнок и копирует.
 */
function joint(root: Pt, tip: Pt, first: number, second: number, bend: Pt): Pt {
  const span = sub(tip, root)
  const l = len(span)
  if (l > first + second + SLACK) {
    throw new Error(
      `kinematics: звенья ${first} и ${second} не достают до точки на ${l.toFixed(3)} S — ` +
        `сочленение решилось бы по укороченному пролёту`,
    )
  }
  if (l === 0) return add(root, mul(unit(bend), first))
  const dir = unit(span)
  const along = (first * first - second * second + l * l) / (2 * l)
  const out = Math.sqrt(Math.max(0, first * first - along * along))
  const normal = v(-dir.y, dir.x)
  const side = normal.x * bend.x + normal.y * bend.y >= 0 ? normal : mul(normal, -1)
  return add(add(root, mul(dir, along)), mul(side, out))
}

/** Расхождение углов по кругу: 180° и −180° — один угол. */
const angleDev = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

/** Поза руки целиком: одна из тех, между которыми ещё остался выбор. */
type Arm = { elbow: Pt; wrist: Pt; palm: Pt[] }

/** Что доворот руки под кисти обязан сохранить, и чем это проверяется. */
type SwingCheck = {
  /** Плечо: корень доворота. */
  root: Pt
  /** Куда по поперечнику корпуса обязана встать кисть этой стороны. */
  wanted: number
  across: Pt
  /** Уцелело ли описание звена после доворота. */
  kept: (arm: Arm) => boolean
}

/**
 * Доворот руки вокруг плеча, сводящий кисть на нужный поперечник корпуса.
 *
 * Самая густая геометрия в игре, поэтому отдельной функцией. Угол в локте
 * доворот не меняет, а абсолютные углы плеча и предплечья — МЕНЯЕТ. Поэтому
 * перебираются остатки свободы (сторона сгиба × два корня доворота) и берётся
 * первый вариант, на котором описанные состояния ещё читаются как заданы.
 * Молча пересобрать руку, затерев описание, нельзя: тогда поза, судящая и
 * кисти, и плечо, невыразима вовсе — и об этом надо знать, а не получать
 * другую позу.
 *
 * Возвращает `null`, если не подошёл ни один вариант; перебранное — в `tried`,
 * им объясняется отказ.
 */
function swingUnderHands(options: Arm[], check: SwingCheck, tried: string[]): Arm | null {
  const { root, wanted, across } = check
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
      const swung: Arm = {
        elbow: swing(arm.elbow),
        wrist: swing(arm.wrist),
        palm: arm.palm.map(swing),
      }
      if (check.kept(swung)) return swung
      tried.push(`доворот ${turn.toFixed(0)}°`)
    }
  }
  return null
}

/**
 * Кинематика позы: **описание → положения суставов в долях торса**.
 *
 * Единственное место в игре, где записана форма тела. Из неё выведены оба
 * потребителя: `figure()` переводит эти суставы в координаты рисования `0..1`
 * (превью и маска выреза), а `fake/stick()` — в кадровые координаты MediaPipe
 * со своим `aspect` и `visibility` (скелет для тестов ядра). Направление
 * импорта законное: стенд импортирует ядро, ядро про стенд не знает.
 *
 * Две копии этой кинематики здесь уже были — `figure()` дословно повторяла
 * `stick()`, потому что ядру нельзя импортировать `src/fake/`. Согласие копий
 * держал только тест, а их расхождение — ровно тот дефект, из-за которого
 * ребёнок, в точности скопировавший НАРИСОВАННЫЙ вырез, получает промах за
 * верную позу. Это самый тяжёлый класс дефекта в игре: ребёнку он непонятен.
 *
 * Единицы — доли длины торса `S` (торс ровно 1), углы — в градусах от
 * вертикали. `y` растёт ВНИЗ, как у кадра MediaPipe и у холста. Середина бёдер
 * — начало координат.
 *
 * Соглашения, на которых стоит всё остальное (см. docs/camera-and-pose.md и
 * docs/poses-and-figure.md):
 *
 * - **Камера НЕ зеркалит:** анатомически левая сторона игрока лежит в `+x`.
 * - **Угол конечности** отсчитывается от вертикали вверх и растёт НАРУЖУ своей
 *   стороны: 0° — вверх, 90° — в сторону, 180° — вниз. Поэтому одно и то же
 *   число даёт симметричную позу на обеих руках.
 * - **В профиль** угол растёт в сторону взгляда (`facing`), а near/far
 *   разрешаются из него так же, как их разрешает `axes()` по выносу носа:
 *   тело, смотрящее в `+x`, обращено к камере ПРАВЫМ боком.
 * - **Боковые состояния** (`side` у плеча, `in` у предплечья, `lean-left` /
 *   `lean-right`) в профиль направлены на камеру и в кадре вырождаются:
 *   описание с ними ПАДАЕТ, а не рисует молча неправду. Так же падает всё
 *   остальное невыразимое — в этом файле нет ни одного молчаливого зажима.
 * - **Тело стоит на полу:** опорная стопа ниже всех. Куда положить пол, решает
 *   потребитель — здесь координаты отсчитаны от середины бёдер.
 *
 * Где живут числа — ровно два дома, и это разные сорта чисел:
 *
 * 1. `CONFIG.figure` — **измеримая геометрия тела** (длины звеньев, ширины,
 *    смещения стопы и кисти) плюс рамка рисунка. Ростовые пропорции, не
 *    подогнанные под пороги.
 * 2. Этот файл, блок «представители состояний» ниже, — **всё, что выведено из
 *    порогов судейства** (угол согнутого локтя, глубина приседа, разносы ног,
 *    зазор между кистями, подъём колена). В `CONFIG` их переносить нельзя: это
 *    были бы вторые копии самих порогов.
 *
 * Падает, а не возвращает искажённое: невыразимое описание — находка, и
 * ребёнку она досталась бы промахом за верную позу.
 */
export function kinematics(desc: KinematicDesc = {}): Joints {
  const profile = (desc.orientation ?? 'front') === 'profile'
  const facingSide = desc.facing ?? 'right'
  const facing = facingSide === 'right' ? 1 : -1
  /**
   * Тело, смотрящее в `+x`, обращено к камере ПРАВЫМ боком — то же
   * разрешение, что делает `axes()` по выносу носа.
   */
  const near: Side = facingSide === 'right' ? 'right' : 'left'
  const latScale = desc.profileLateral ?? (profile ? F.profileLateral : 1)

  /**
   * Знак бокового смещения точки стороны `side` по `x` кадра. Камера не
   * зеркалит, поэтому во фронт левая сторона игрока лежит в `+x`.
   *
   * В профиль ближняя сторона уходит ПРОТИВ взгляда. Это не выбор знака, а
   * геометрия: при экранных осях `x` вправо, `y` вниз, `z` в экран у тела с
   * рысканьем θ (0° — лицом в камеру, 90° — профиль вправо)
   * `forward = (sin θ, 0, −cos θ)`, и анатомически правая сторона лежит по
   * `right = forward × up = (−cos θ, 0, −sin θ)`. Недовёрнутое тело, у которого
   * боковые размеры ещё видны (`latScale = |cos θ| > 0`), повёрнуто К камере при
   * θ < 90°, и тогда `right.x = −cos θ < 0` — ближняя (правая) сторона лежит в
   * ОТРИЦАТЕЛЬНОМ `x` при взгляде в `+x`. Противоположный знак изображал бы
   * тело, довёрнутое ЗА профиль, то есть отвернувшееся от камеры: нарисовано
   * было бы «отвернись», а требуется «повернись боком».
   */
  const lat = (side: Side): number => {
    if (!profile) return side === 'left' ? 1 : -1
    return side === near ? -facing : facing
  }
  /** Знак, в который растут углы конечностей этой стороны. */
  const limbSign = (side: Side): number => (profile ? facing : lat(side))

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
      throw new Error(
        `kinematics: ${what} задан(о) и по сторонам, и через near/far — одна сторона дважды`,
      )
    }
    return own ?? paired
  }

  /** Описанное плечо, либо `undefined`: умолчание `down` — не описание. */
  const shoulderDescOf = (side: Side): ShoulderState | number | undefined =>
    pickSide(
      side,
      side === 'left' ? desc.leftShoulder : desc.rightShoulder,
      desc.nearShoulder,
      desc.farShoulder,
      'плечо',
    )
  const elbowStateOf = (side: Side): ElbowState | number =>
    pickSide(
      side,
      side === 'left' ? desc.leftElbow : desc.rightElbow,
      desc.nearElbow,
      desc.farElbow,
      'локоть',
    ) ?? 'straight'
  const forearmStateOf = (side: Side): ForearmState | number | undefined =>
    pickSide(
      side,
      side === 'left' ? desc.leftForearm : desc.rightForearm,
      desc.nearForearm,
      desc.farForearm,
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
      throw new Error(
        `kinematics: состояние ${state} направлено на камеру и в профиль не выражается`,
      )
    }
    return fromVertical(LIMB_ANGLE[state], sign)
  }

  const leanState = desc.lean ?? 'upright'
  if (profile && typeof leanState === 'string' && leanState.startsWith('lean-')) {
    throw new Error(`kinematics: наклон ${leanState} направлен на камеру и в профиль не выражается`)
  }
  const leanDeg =
    (typeof leanState === 'number' ? leanState : LEAN_ANGLE[leanState]) * (profile ? facing : 1)

  // --- корпус -------------------------------------------------------------
  const hipMid = v(0, 0)
  const up = fromVertical(leanDeg, 1)
  const across = v(-up.y, up.x)
  const shoulderMid = add(hipMid, up)

  const hipAt = (side: Side): Pt => v(lat(side) * F.hipHalf * latScale, 0)
  const shoulderAt = (side: Side): Pt =>
    add(shoulderMid, mul(across, lat(side) * F.shoulderHalf * latScale))

  // --- ноги ---------------------------------------------------------------
  /** Угол в колене: присед перебивает `knees`, число перебивает состояние. */
  const kneeAngle = (): number => {
    const crouch = desc.crouch ?? 'no'
    if (typeof crouch === 'number') return crouch
    if (crouch === 'yes') return CROUCH_KNEE
    const knees = desc.knees ?? 'straight'
    if (typeof knees === 'number') return knees
    return knees === 'bent' ? BENT_ANGLE : 180
  }
  const kneeDeg = kneeAngle()
  const reach = 2 * F.thigh * Math.sin((kneeDeg / 2) * D2R)
  const legs = desc.legs ?? 'together'
  const spread = typeof legs === 'number' ? legs : LEG_SPREAD[legs]
  const kneeBend = (side: Side): Pt => (profile ? v(facing, 0) : v(lat(side), 0))
  const support: SupportState = desc.support ?? 'both'

  const ankle: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const knee: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }

  /**
   * Прямая (или подогнутая по `reach`) нога с заданным `x` стопы.
   *
   * Недостающий пролёт — НЕ зажим к полу: стопа осталась бы на запрошенном
   * `x`, а просадка подменилась бы минимальной, и нога вышла бы не той длины
   * молча. Разнос шире, чем нога достаёт при этом угле в колене, — находка.
   */
  const standLeg = (side: Side, ankleX: number): void => {
    const root = hipAt(side)
    const dx = ankleX - root.x
    const drop = reach * reach - dx * dx
    if (!(drop > 0)) {
      throw new Error(
        `kinematics: нога не достаёт стопой до x=${ankleX.toFixed(3)} S ` +
          `(от бедра ${Math.abs(dx).toFixed(3)} S при пролёте ${reach.toFixed(3)} S, ` +
          `угол в колене ${kneeDeg}°)`,
      )
    }
    ankle[side] = v(ankleX, Math.sqrt(drop))
    knee[side] = joint(root, ankle[side], F.thigh, F.shin, kneeBend(side))
  }

  if (support === 'both') {
    standLeg('left', lat('left') * (spread / 2))
    standLeg('right', lat('right') * (spread / 2))
  } else {
    const stand: Side = support
    const raised: Side = stand === 'left' ? 'right' : 'left'
    standLeg(stand, 0)
    const atKnee = desc.footToKnee !== undefined || desc.footAtKnee === true
    const lift = desc.raisedKnee ?? (atKnee ? RAISED_KNEE_AT_FOUR : RAISED_KNEE)
    const kneeY = knee[stand].y - lift
    const root = hipAt(raised)
    const out = profile ? facing : lat(raised)
    const dy = kneeY - root.y
    // Тот же запрет на молчаливый зажим: бедро, не достающее до запрошенной
    // высоты колена, растянулось бы молча.
    const reachOut = F.thigh * F.thigh - dy * dy
    if (reachOut < -SLACK) {
      throw new Error(
        `kinematics: бедро ${F.thigh} S не достаёт до колена, поднятого на ` +
          `${Math.abs(dy).toFixed(2)} S от бедра (подъём ${lift} S)`,
      )
    }
    knee[raised] = v(root.x + out * Math.sqrt(Math.max(reachOut, 0)), kneeY)
    if (desc.footToKnee !== undefined) {
      // Стопа на голени от поднятого колена и на заданном расстоянии от
      // опорного — та же засечка двух звеньев, что и у самого колена.
      // Недостижимость названа здесь, до засечки: `joint()` сказал бы о ней
      // через длины звеньев, а причина — в запрошенном расстоянии и в подъёме
      // колена, и именно их надо править.
      const between = len(sub(knee[stand], knee[raised]))
      if (between > F.shin + desc.footToKnee + SLACK) {
        throw new Error(
          `kinematics: стопа не достаёт до ${desc.footToKnee} S от колена опорной ноги ` +
            `(голень ${F.shin} S, а колени врозь на ${between.toFixed(2)} S) — ` +
            `подвиньте raisedKnee`,
        )
      }
      ankle[raised] = joint(knee[raised], knee[stand], F.shin, desc.footToKnee, v(-out, 1))
      const got = len(sub(ankle[raised], knee[stand]))
      if (Math.abs(got - desc.footToKnee) > 0.01) {
        throw new Error(
          `kinematics: стопа не достаёт до ${desc.footToKnee} S от колена опорной ноги ` +
            `(вышло ${got.toFixed(2)}) — подвиньте raisedKnee`,
        )
      }
    } else if (desc.footAtKnee === true) {
      ankle[raised] = add(knee[raised], mul(unit(sub(knee[stand], knee[raised])), F.shin))
    } else {
      ankle[raised] = add(knee[raised], mul(unit(v(out * FREE_SHIN_OUT, 1)), F.shin))
    }
  }

  // --- руки ---------------------------------------------------------------
  const hands: HandsState = desc.hands ?? 'no'
  const elbow: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const wrist: Record<Side, Pt> = { left: v(0, 0), right: v(0, 0) }
  const palm: Record<Side, Pt[]> = { left: [], right: [] }

  /** Угол звена `a→b` от вертикали — та же мера, в которой его судит ядро. */
  const limbAngleOf = (a: Pt, b: Pt, side: Side): number =>
    Math.atan2((b.x - a.x) * limbSign(side), -(b.y - a.y)) / D2R
  /** Отклонение точки от средней линии корпуса: им ядро опознаёт «на камеру». */
  const devFromMid = (p: Pt): number => Math.abs(p.x * across.x + p.y * across.y)

  /**
   * Уцелело ли ОПИСАННОЕ состояние звена после доворота руки под кисти.
   * Умолчание (плечо `down`, незаданное предплечье) описанием не считается —
   * его доворот вправе менять, и именно на нём держится «Космическая ракета»:
   * прямые руки вверх при сведённых кистях физически наклонены внутрь.
   * Числом задан ровно тот угол, поэтому доворота он не терпит вовсе.
   */
  const keptLimb = (
    description: ShoulderState | ForearmState | number | undefined,
    angle: number,
    tolerance: number,
    nearMid: boolean,
  ): boolean => {
    if (description === undefined) return true
    if (typeof description === 'number') return angleDev(angle, description) < 1e-6
    // «На камеру» фронт и профиль судят по-разному: во фронте — отклонением от
    // средней линии корпуса, в профиль — тем же углом 90°, что и `side`, ведь
    // там рука по линии взгляда лежит в кадре поперёк.
    if (description === 'front') {
      return profile ? angleDev(angle, LIMB_ANGLE.side) < tolerance : nearMid
    }
    return angleDev(angle, LIMB_ANGLE[description]) < tolerance
  }

  for (const side of ['left', 'right'] as const) {
    const shoulderDesc = shoulderDescOf(side)
    const elbowState = elbowStateOf(side)
    const forearmState = forearmStateOf(side)
    const elbowDeg =
      typeof elbowState === 'number' ? elbowState : elbowState === 'straight' ? 180 : BENT_ANGLE
    const bent = elbowDeg < CONFIG.elbow.straightMin
    if (forearmState !== undefined && !bent) {
      throw new Error('kinematics: предплечье задано при прямом локте — судить его тогда не на чем')
    }

    const upper = limbDir(shoulderDesc ?? 'down', side)
    const elbowAt = add(shoulderAt(side), mul(upper, F.upperArm))

    /**
     * Направления предплечья, между которыми выбор ещё есть. Их два и только
     * тогда, когда локоть согнут, а предплечье не описано: сам угол в локте
     * этим выбором не меняется, меняется лишь сторона сгиба.
     */
    let fores: Pt[]
    if (!bent) {
      fores = [upper]
    } else if (forearmState !== undefined) {
      fores = [limbDir(forearmState, side)]
    } else {
      // Локоть согнут, а предплечье не задано: сгибаем так, чтобы угол в
      // локте вышел ровно заданным, а кисть ушла вверх.
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

    const armOf = (fore: Pt): Arm => {
      const at = add(elbowAt, mul(fore, F.forearm))
      const along = unit(fore)
      const sideways = v(-along.y, along.x)
      return {
        elbow: elbowAt,
        wrist: at,
        palm: [
          add(at, mul(along, F.hand * 0.9)), // pinky
          add(at, mul(along, F.hand)), // index
          add(add(at, mul(along, F.hand * 0.6)), mul(sideways, F.thumbOut)), // thumb
        ],
      }
    }
    const options = fores.map(armOf)

    const place = (arm: Arm): void => {
      elbow[side] = arm.elbow
      wrist[side] = arm.wrist
      palm[side] = arm.palm
    }

    if (hands === 'no') {
      place(options[0])
      continue
    }

    const root = shoulderAt(side)
    const gap = desc.handGap ?? HAND_GAP
    const tried: string[] = []
    const placed = swingUnderHands(
      options,
      {
        root,
        across,
        wanted: lat(side) * (gap / 2) - (root.x * across.x + root.y * across.y),
        kept: (arm) =>
          keptLimb(
            shoulderDesc,
            limbAngleOf(root, arm.elbow, side),
            CONFIG.shoulder.tolerance,
            devFromMid(arm.elbow) < CONFIG.shoulder.front &&
              devFromMid(arm.wrist) < CONFIG.shoulder.front,
          ) &&
          keptLimb(
            forearmState,
            limbAngleOf(arm.elbow, arm.wrist, side),
            CONFIG.forearm.tolerance,
            devFromMid(arm.wrist) < CONFIG.shoulder.front,
          ),
      },
      tried,
    )

    if (placed === null) {
      throw new Error(
        `kinematics: кисти ${hands} не сводятся, не выведя описанную руку (${side}) из её полос — ` +
          `перебрано: ${tried.join('; ')}`,
      )
    }
    place(placed)
  }

  // --- голова -------------------------------------------------------------
  const head = (upward: number, sideways: number, forward: number): Pt => {
    const base = add(add(shoulderMid, mul(up, upward)), mul(across, sideways * latScale))
    return profile ? add(base, v(facing * forward, 0)) : base
  }

  // --- стопы --------------------------------------------------------------
  // Носок уходит в сторону тела (в профиль — взгляда), пятка — против него.
  const toeAt = (side: Side): Pt =>
    add(
      ankle[side],
      profile
        ? v(facing * F.toeProfile.x, F.toeProfile.y)
        : v(lat(side) * F.toeFront.x, F.toeFront.y),
    )
  const heelAt = (side: Side): Pt =>
    add(
      ankle[side],
      profile
        ? v(-facing * F.heelProfile.x, F.heelProfile.y)
        : v(-lat(side) * F.heelFront.x, F.heelFront.y),
    )

  return {
    profile,
    facing,
    near,
    support,
    up,
    across,
    hipMid,
    shoulderMid,
    hip: { left: hipAt('left'), right: hipAt('right') },
    shoulder: { left: shoulderAt('left'), right: shoulderAt('right') },
    elbow,
    wrist,
    palm,
    knee,
    ankle,
    heel: { left: heelAt('left'), right: heelAt('right') },
    toe: { left: toeAt('left'), right: toeAt('right') },
    head,
  }
}
