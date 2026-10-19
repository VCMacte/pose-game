import {
  AXES,
  circular,
  elbowBands,
  forearmBands,
  linear,
  pick,
  shoulderBands,
  type Axis,
  type Band,
} from './axes'
import type { ElbowState, ForearmState, Orientation, PoseSpec, ShoulderState } from './types'

/**
 * Какие оси позы определены другими её осями.
 *
 * Читать вместе с docs/poses-and-figure.md («Правило различимости») и
 * docs/judging.md. Нужен этот файл ровно одному: правилу различимости. Оно
 * требует, чтобы две позы набора расходились минимум одним ЦЕЛЫМ состоянием,
 * а расхождение по оси, которая лишь повторяет две соседние, запасом не
 * является — им две позы, неразличимые для ребёнка, проходили бы за
 * различимые. Это анти-цель проекта, а не придирка.
 *
 * Связь одна и она геометрическая: плечо, локоть и предплечье одной руки
 * сидят на ОДНОМ уравнении
 *
 * ```
 * |плечо − предплечье| = 180° − локоть
 * ```
 *
 * (угол в локте — угол между звеньями плечо→локоть и локоть→кисть, а оси плеча
 * и предплечья — направления этих звеньев от вертикали). Поэтому, задав два
 * звена из трёх, поза могла задать третье впустую.
 *
 * Два правила держат файл:
 *
 * - **Состояния — полосы, а не числа,** и уравнение связывает числа. «Задала
 *   два — определила третье» поэтому неверно буквально: определённым третье
 *   оказывается лишь тогда, когда из ВСЕГО произведения полос достижимо ровно
 *   одно его состояние. Плечо `side` с предплечьем `down` локоть не
 *   определяют: угол 120°/145° — это та же пара состояний при прямом локте.
 * - **Полосы берутся у `axes()`,** а не выписываются рядом: сторож, считающий
 *   по своей копии порогов, сторожит свою копию, а не судейство. Отсюда и
 *   `export` у полос в `axes.ts`.
 *
 * Строгость входит параметром, потому что она сужает полосы: чем строже
 * настройка, тем больше осей оказывается определено, и запас различимости надо
 * считать по самой узкой.
 */

/** Три звена одной руки — те, что связаны уравнением. */
export const JOINTS = ['shoulder', 'elbow', 'forearm'] as const

export type Joint = (typeof JOINTS)[number]

export type LimbState = ShoulderState | ElbowState | ForearmState

/** Требования позы к одной руке: все три звена заданы. */
export type LimbTriple = {
  shoulder: ShoulderState
  elbow: ElbowState
  forearm: ForearmState
}

/**
 * Что два соседних звена говорят о третьем.
 *
 * - `derived` — достижимо ровно одно состояние: ось повторяет соседей и
 *   запасом различимости быть не может.
 * - `open` — достижимо больше одного: ось несёт своё.
 * - `no-angle` — выводить нечем: хотя бы одно звено задано состоянием, которое
 *   в кадре опознаётся не углом, а вырождением проекции (`front` у плеча и
 *   предплечья во фронтальном кадре). Уравнение связывает углы, и к такой руке
 *   оно не применяется вовсе.
 *
 * `reachable` — состояния, достижимые хоть одной выразимой рукой; `nominal` —
 * состояния на ЦЕНТРАХ полос соседей, то есть у позы, сделанной ровно. У
 * плеча и предплечья центров два: уравнение оставляет им решения по обе
 * стороны (`±`).
 */
export type Implication =
  | { kind: 'derived'; state: LimbState; reachable: LimbState[]; nominal: LimbState[] }
  | { kind: 'open'; reachable: LimbState[]; nominal: LimbState[] }
  | { kind: 'no-angle'; why: string }

/** Отрезок значений оси, в её собственных единицах (градусы). */
type Interval = readonly [number, number]

/**
 * Шаг сетки, по которой ищутся полосы, и шаг обхода найденного отрезка.
 *
 * Полосы осей не уже 45°, а все отображения здесь — 1-липшицевы, поэтому ни
 * одна полоса шагом не проскакивается. Цена шага — погрешность края полосы в
 * 0.1°: она сдвигает ответ только у требования, стоящего ровно на краю, а
 * таких в наборе нет (ближайшее — 5° от края, см. docs/poses-and-figure.md про
 * плечи «Низкого барьера»).
 */
const GRID = 0.1
const SCAN = 0.25

const profileOf = (orientation: Orientation): boolean => orientation === 'profile'

function bandsOf(joint: Joint, orientation: Orientation, strict: number): Band<LimbState>[] {
  const profile = profileOf(orientation)
  if (joint === 'shoulder') return shoulderBands(profile, strict)
  if (joint === 'forearm') return forearmBands(profile, strict)
  return elbowBands(strict)
}

/**
 * Метрика оси. Углы звеньев считаются по кругу (180° и −180° — одно
 * направление), угол в сочленении — по прямой: он живёт в [0, 180] и не
 * замыкается.
 */
const metricOf = (joint: Joint): ((a: number, b: number) => number) =>
  joint === 'elbow' ? linear : circular

/** Область значений оси. */
const domainOf = (joint: Joint): Interval => (joint === 'elbow' ? [0, 180] : [-180, 180])

const bandOf = (
  joint: Joint,
  state: LimbState,
  orientation: Orientation,
  strict: number,
): Band<LimbState> | undefined => bandsOf(joint, orientation, strict).find((b) => b.state === state)

/**
 * Углы, которые `axes()` прочтёт этим состоянием, отрезками.
 *
 * Край полосы, попавший в перекрытие с соседней, в ответ не входит: там
 * `axes()` отвечает «не знаю», и такая рука состоянием не читается.
 */
function admissible(
  state: LimbState,
  joint: Joint,
  orientation: Orientation,
  strict: number,
): Interval[] {
  const bands = bandsOf(joint, orientation, strict)
  const distance = metricOf(joint)
  const [lo, hi] = domainOf(joint)

  const points: number[] = []
  for (let v = lo; v <= hi + 1e-9; v += GRID) points.push(v)
  // Края полос — точно, а не ближайшей точкой сетки: ими задаются концы
  // отрезков, по которым потом считается достижимое.
  for (const band of bands) {
    for (const edge of [band.ref - band.tol, band.ref + band.tol]) {
      for (const shift of [-360, 0, 360]) {
        const v = edge + shift
        if (v >= lo && v <= hi) points.push(v)
      }
    }
  }
  points.sort((a, b) => a - b)

  const out: [number, number][] = []
  for (const v of points) {
    if (pick(v, bands, distance) !== state) continue
    const last = out[out.length - 1]
    if (last !== undefined && v - last[1] <= GRID * 1.5) last[1] = v
    else out.push([v, v])
  }
  return out
}

/** Сумма отрезков по Минковскому: `{ x + sign·y }`. */
const combine = (xs: Interval[], ys: Interval[], sign: 1 | -1): Interval[] =>
  xs.flatMap((x) =>
    ys.map((y): Interval =>
      sign === 1 ? [x[0] + y[0], x[1] + y[1]] : [x[0] - y[1], x[1] - y[0]],
    ),
  )

/** Обход отрезка с заходом в оба конца. */
function* walk(intervals: Interval[]): Generator<number> {
  for (const [a, b] of intervals) {
    for (let v = a; v < b; v += SCAN) yield v
    yield b
  }
}

/** Угол в локте по направлениям звеньев: `180° − |плечо − предплечье|`. */
const elbowFrom = (shoulder: number, forearm: number): number => 180 - circular(shoulder, forearm)

/**
 * Все состояния, достижимые третьим звеном при двух заданных. `'unknown'` в
 * ответ не идёт — это не состояние, в которое ребёнок может встать, — но его
 * наличие важно: во фронтальном кадре рука, чей угол попал в зазор между
 * полосами, читается `front` по вырождению проекции, и поэтому `front` у плеча
 * и предплечья во фронте достижим почти всегда.
 */
function reachable(
  joint: Joint,
  triple: LimbTriple,
  orientation: Orientation,
  strict: number,
): LimbState[] {
  const adm = (j: Joint): Interval[] => admissible(triple[j], j, orientation, strict)
  const bands = bandsOf(joint, orientation, strict)
  const distance = metricOf(joint)

  const seen = new Set<LimbState | 'unknown'>()
  if (joint === 'elbow') {
    for (const t of walk(combine(adm('shoulder'), adm('forearm'), -1))) {
      seen.add(pick(elbowFrom(t, 0), bands, distance))
    }
  } else {
    // |плечо − предплечье| = 180° − локоть даёт два решения: соседнее звено
    // плюс и минус эту разницу.
    const spread = adm('elbow').map(([a, b]): Interval => [180 - b, 180 - a])
    const other: Joint = joint === 'shoulder' ? 'forearm' : 'shoulder'
    for (const sign of [1, -1] as const) {
      for (const v of walk(combine(adm(other), spread, sign))) {
        seen.add(pick(v, bands, distance))
      }
    }
  }

  const out = bands.filter((b) => seen.has(b.state)).map((b) => b.state)
  const projected = bandOf(joint, 'front', orientation, strict) === undefined
  if (!profileOf(orientation) && joint !== 'elbow' && projected && seen.has('unknown')) {
    out.push('front')
  }
  return out
}

/** Состояния третьего звена при соседях, стоящих ровно по центрам полос. */
function nominal(
  joint: Joint,
  triple: LimbTriple,
  orientation: Orientation,
  strict: number,
): LimbState[] {
  const ref = (j: Joint): number => bandOf(j, triple[j], orientation, strict)!.ref
  const bands = bandsOf(joint, orientation, strict)
  const distance = metricOf(joint)
  const values =
    joint === 'elbow'
      ? [elbowFrom(ref('shoulder'), ref('forearm'))]
      : [1, -1].map(
          (sign) => ref(joint === 'shoulder' ? 'forearm' : 'shoulder') + sign * (180 - ref('elbow')),
        )
  const out: LimbState[] = []
  for (const v of values) {
    const state = pick(v, bands, distance)
    if (state !== 'unknown' && !out.includes(state)) out.push(state)
  }
  return out
}

/**
 * Что требования к двум звеньям говорят о третьем.
 *
 * `strict` — множитель допусков из `strictness()`: он сужает полосы, а с ними
 * и достижимое.
 */
export function limbImplication(
  joint: Joint,
  triple: LimbTriple,
  orientation: Orientation,
  strict: number,
): Implication {
  const bandless = JOINTS.filter((j) => bandOf(j, triple[j], orientation, strict) === undefined)
  if (bandless.length > 0) {
    return {
      kind: 'no-angle',
      // Единственный такой случай — `front` во фронтальном кадре: он
      // опознаётся отклонением локтя и кисти от средней линии корпуса, а не
      // углом, и уравнение связности к нему не применяется.
      why: `${bandless.join(', ')}: состояние опознаётся не углом (${orientation})`,
    }
  }
  const states = reachable(joint, triple, orientation, strict)
  const nom = nominal(joint, triple, orientation, strict)
  return states.length === 1
    ? { kind: 'derived', state: states[0], reachable: states, nominal: nom }
    : { kind: 'open', reachable: states, nominal: nom }
}

const axisOf = (prefix: string, joint: Joint): Axis =>
  `${prefix}${joint[0].toUpperCase()}${joint.slice(1)}` as Axis

/** Приставки звеньев, выведенные из `AXES`: `left`, `right`, `near`, `far`. */
const PREFIXES: string[] = AXES.filter((a) => a.endsWith('Elbow')).map((a) =>
  a.slice(0, -'Elbow'.length),
)

/**
 * Вывод по каждой оси-звену, у которой поза задала все три звена руки. Ось,
 * у которой соседи не заданы, в ответ не попадает: уравнение неполно, и
 * говорить о её определённости нечем.
 */
export function limbImplications(
  spec: PoseSpec,
  strict: number,
): Partial<Record<Axis, Implication>> {
  const out: Partial<Record<Axis, Implication>> = {}
  for (const prefix of PREFIXES) {
    const triple = Object.fromEntries(
      JOINTS.map((j) => [j, spec.requires[axisOf(prefix, j)]]),
    ) as Partial<LimbTriple>
    if (JOINTS.some((j) => triple[j] === undefined)) continue
    for (const joint of JOINTS) {
      out[axisOf(prefix, joint)] = limbImplication(
        joint,
        triple as LimbTriple,
        spec.orientation,
        strict,
      )
    }
  }
  return out
}

/**
 * Оси позы, чьё состояние определено другими осями той же позы. В порядке
 * `AXES`.
 *
 * Правило различимости считает запас между позами только по осям, которых
 * здесь нет.
 */
export function dependentAxes(spec: PoseSpec, strict: number): Axis[] {
  const implications = limbImplications(spec, strict)
  return AXES.filter((axis) => implications[axis]?.kind === 'derived')
}
