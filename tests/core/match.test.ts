import { describe, expect, test } from 'vitest'
import { AXES, axes, type Axis, type AxisReadings } from '../../src/core/axes'
import { geometry } from '../../src/core/geometry'
import { matchFrame, type FrameMatch } from '../../src/core/match'
import { POSES } from '../../src/core/poses'
import type { Calibration, Frame, Landmarks, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Совпадение одного кадра с позой. Голосование по окну кадров — не здесь.
 *
 * Четыре правила держат этот файл:
 *
 * - **Полнота выводится из `AXES`** — канонического списка осей ядра, а не из
 *   таблицы в этом файле: забытая в таблице ось иначе не ловится ничем.
 * - **Утверждается ОПИСАНИЕ, а не различие скелетов.** Этот тест однажды уже
 *   оказался пустым: он утверждал лишь, что два скелета разные, то есть не мог
 *   упасть по той причине, ради которой написан. Поэтому у каждого
 *   испорченного кадра проверяется, что упала ровно та ось, которую портили.
 * - **Испорченный кадр ищется, а не берётся из таблицы ожиданий.** Утверждение
 *   — «существует кадр, где промахнулась ровно эта ось»: именно оно падает и
 *   когда `matchFrame` ось не проверяет (ни один кадр её не уронит), и когда
 *   роняет лишнее (упавших осей больше одной). Проверено подменой реализации:
 *   пропущенная ось, «не знаю» как совпадение и оправдание перекрытием вне
 *   профиля роняют этот файл, а порча, ничего не меняющая, — тоже.
 * - **Где промах ровно по одной оси невыразим телом, это сказано вслух** —
 *   см. `entangled()`: правила выводятся из `requires`, у каждого названа
 *   геометрическая причина, и тест требует, чтобы ось действительно не
 *   сбивалась порознь. Изоляцию КАЖДОЙ оси тогда проверяет подмена самого
 *   показания: вход `matchFrame` — показания, а не кадр.
 */

const ASPECT = 16 / 9

const frame = (desc: Partial<StickDesc>): Landmarks => stick({ aspect: ASPECT, ...desc })

function calibrate(): Calibration {
  const g = geometry(frame({}), ASPECT)!
  return {
    S0: g.S,
    shoulderWidth: g.shoulderRatio * g.S,
    neutralX: g.cx,
    neutralShoulderY: g.shoulderMid.y,
    neutralHipY: g.hipMid.y,
    aspect: ASPECT,
    at: 0,
  }
}

const CAL = calibrate()

/** Показания кадра, собранного по описанию. */
function read(desc: Partial<StickDesc>): AxisReadings {
  const lm = frame(desc)
  return axes(lm, geometry(lm, ASPECT)!, CAL, 1)
}

/** Кадр самой позы: требования уходят в фикстуру как есть. */
const poseDesc = (p: PoseSpec): Partial<StickDesc> => ({
  orientation: p.orientation,
  ...p.requires,
})

const readPose = (p: PoseSpec): AxisReadings => read(poseDesc(p))

const required = (p: PoseSpec): Axis[] => AXES.filter((axis) => p.requires[axis] !== undefined)

/** Оси, которые приговор не засчитал. Исключённые перекрытием сюда не входят. */
const failing = (m: FrameMatch): Axis[] =>
  (Object.keys(m.perAxis) as Axis[]).filter((axis) => {
    const v = m.perAxis[axis]!
    return !v.ok && v.outcome !== 'excused'
  })

// --- испорченные кадры ------------------------------------------------------

/** Состояния каждой оси — домены выводятся из имени оси, не из таблицы поз. */
const SHOULDER = ['up', 'diag-up', 'side', 'down', 'front'] as const
const ELBOW = ['straight', 'bent'] as const
const FOREARM = ['up', 'down', 'in', 'front'] as const
const HANDS = ['no', 'over-head', 'in-front'] as const
const LEGS = ['together', 'shoulder', 'wide', 'max'] as const
const SUPPORT = ['both', 'left', 'right'] as const
const LEAN = ['upright', 'lean-left', 'lean-right', 'horizontal'] as const

/** Домен оси — по её имени, а не по таблице поз. */
function domain(axis: Axis): readonly unknown[] {
  if (axis.endsWith('Shoulder')) return SHOULDER
  if (axis.endsWith('Elbow')) return ELBOW
  if (axis.endsWith('Forearm')) return FOREARM
  switch (axis) {
    case 'hands':
      return HANDS
    case 'legs':
      return LEGS
    case 'support':
      return SUPPORT
    case 'lean':
      return LEAN
    case 'crouch':
      return ['no', 'yes']
    case 'knees':
      return ['straight', 'bent']
    case 'footAtKnee':
      return [true, false]
    default:
      return []
  }
}

/** Любое состояние этой оси, кроме требуемого. */
function otherState(axis: Axis, want: unknown): unknown {
  const other = domain(axis).find((s) => s !== want)
  if (other === undefined) throw new Error(`у оси ${axis} нет второго состояния`)
  return other
}

/** Углы для числовых ручек: ими конечность ставится и в полосу, и в зазор. */
const LIMB_ANGLES = [
  -135, -120, -105, -90, -75, -60, -45, -30, 0, 30, 45, 60, 70, 75, 90, 105, 110, 115, 120, 135,
  150, 165, 180,
]
const ELBOW_ANGLES = [60, 70, 80, 92, 105, 115, 125, 135, 145, 155, 165, 180]
const KNEE_ANGLES = [90, 100, 110, 120, 130, 140, 145, 155, 165, 180]
const LEAN_ANGLES = [0, 10, 25, 30, 35, 40, 50, 55, 65, 75, 90, -25, -35, -40, -55, -75]
const LEG_SPREADS = [0.05, 0.15, 0.3, 0.5, 0.6, 0.7, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.7]
const HAND_GAPS = [0.05, 0.15, 0.25, 0.45, 0.55, 0.7, 0.9]
const BODY_DROPS = [-0.6, -0.5, -0.4, -0.3, 0.3, 0.4, 0.5, 0.6]
const FOOT_TO_KNEE = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
const RAISED_KNEES = [0.36, 0.4, 0.5, 0.6, 0.7, 0.9]

/**
 * Значения, которыми ось сбивается с требуемого: все ОСТАЛЬНЫЕ её состояния,
 * числовые ручки той же оси и — где она есть — своя ручка этой оси.
 * Перебираются по порядку, пока не найдётся кадр, роняющий ровно её.
 */
function spoilers(axis: Axis, want: unknown): Partial<StickDesc>[] {
  const others = domain(axis).filter((s) => s !== want)
  const states = others.map((s) => ({ [axis]: s }) as Partial<StickDesc>)
  const numbers = (values: readonly number[]): Partial<StickDesc>[] =>
    values.map((n) => ({ [axis]: n }) as Partial<StickDesc>)

  if (axis.endsWith('Shoulder') || axis.endsWith('Forearm')) {
    return [...states, ...numbers(LIMB_ANGLES)]
  }
  if (axis.endsWith('Elbow')) return [...states, ...numbers(ELBOW_ANGLES)]
  switch (axis) {
    case 'hands':
      // Своя ручка оси кистей — зазор между ними: то самое расстояние, по
      // которому ось и судится. Состояние при этом остаётся требуемым.
      return [
        ...states,
        ...HAND_GAPS.map((handGap) => ({ handGap })),
        ...others.flatMap((hands) =>
          HAND_GAPS.map((handGap) => ({ hands, handGap }) as Partial<StickDesc>),
        ),
      ]
    case 'legs':
      return [...states, ...numbers(LEG_SPREADS)]
    case 'support':
      // `raisedKnee` — подъём свободного колена: почти прямая поднятая нога
      // сбивает опору, трогая угол в колене и разнос стоп как можно меньше.
      return [
        ...states,
        ...others.flatMap((support) =>
          RAISED_KNEES.map((raisedKnee) => ({ support, raisedKnee }) as Partial<StickDesc>),
        ),
      ]
    case 'lean':
      return [...states, ...numbers(LEAN_ANGLES)]
    case 'crouch':
      // `bodyDrop` опускает фигуру в кадре, не трогая колен: ровно этим голоса
      // приседа по просадке отвязываются от его голоса по углу в колене.
      return [...states, ...BODY_DROPS.map((bodyDrop) => ({ bodyDrop }))]
    case 'knees':
      return [...states, ...numbers(KNEE_ANGLES)]
    case 'footAtKnee':
      return [...states, ...FOOT_TO_KNEE.map((footToKnee) => ({ footToKnee }))]
    default:
      return states
  }
}

type Broken = { label: string; match: FrameMatch }

const cache = new Map<string, Broken[]>()

/**
 * Приговоры по всем испорченным кадрам этой оси. Описание, которое кинематика
 * не выражает, молча отбрасывается: невыразимое — не кадр.
 */
function broken(p: PoseSpec, axis: Axis): Broken[] {
  const key = `${p.id}.${axis}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const out: Broken[] = []
  for (const patch of spoilers(axis, p.requires[axis])) {
    try {
      out.push({
        label: JSON.stringify(patch),
        match: matchFrame(p, read({ ...poseDesc(p), ...patch })),
      })
    } catch {
      continue
    }
  }
  cache.set(key, out)
  return out
}

/** Кадры, на которых упала ровно одна ось — и это та, которую портили. */
const onlyThisAxis = (p: PoseSpec, axis: Axis): Broken[] =>
  broken(p, axis).filter(({ match }) => {
    const fell = failing(match)
    return !match.matched && fell.length === 1 && fell[0] === axis
  })

/** Кадры, на которых упала эта ось — одна или вместе с чем-то. */
const thisAxisFell = (p: PoseSpec, axis: Axis): Broken[] =>
  broken(p, axis).filter(({ match }) => failing(match).includes(axis))

// --- оси, которые геометрия не даёт сбить порознь ----------------------------

/**
 * Промах РОВНО по одной оси выразим не везде, и это находка, а не поблажка:
 * оси позы связаны телом, а не только судейством. Каждое правило ниже —
 * геометрия, и у каждого названа причина; правила выводятся из `requires`, а
 * не перечисляют пары «поза + ось» руками.
 *
 * `immovable` — выразимого кадра, роняющего эту ось, нет вовсе.
 * `coupled` — кадр есть, но вместе с осью обязаны упасть перечисленные.
 *
 * Утверждение в обе стороны: где правило молчит, тест требует РОВНО одну
 * упавшую ось; где говорит — требует, чтобы порознь ось действительно не
 * сбивалась. Устаревшее правило поэтому падает так же, как забытое.
 */
type Entanglement =
  | { kind: 'immovable'; why: string }
  | { kind: 'coupled'; with: Axis[]; why: string }

const swapSuffix = (axis: Axis, from: string, to: string): Axis =>
  `${axis.slice(0, -from.length)}${to}` as Axis

function entangled(p: PoseSpec, axis: Axis): Entanglement | null {
  const r = p.requires
  /** Поза сводит кисти, значит руки доворачиваются вокруг плеч. */
  const swung = r.hands !== undefined && r.hands !== 'no'

  if (axis === 'support' && r.support === 'both' && r.knees === 'straight') {
    return {
      kind: 'coupled',
      with: ['legs', 'knees'],
      why:
        'уйти с двух ног на одну — значит поставить стопы под корпус и подогнуть ' +
        'свободную ногу; ось колен судит ХУДШЕЕ из двух колен, поэтому требование ' +
        '«колени прямые» падает вместе с опорой, а вместе с ним и разнос стоп ' +
        '(в приседе колени требуются согнутыми, и там опора сбивается порознь)',
    }
  }
  const pinnedForearm =
    axis.endsWith('Elbow') && r[swapSuffix(axis, 'Elbow', 'Forearm')] !== undefined
  if (pinnedForearm && r[axis] === 'bent') {
    return {
      kind: 'immovable',
      why:
        'угол в локте — угол МЕЖДУ плечом и предплечьем; поза задаёт оба, значит ' +
        'локоть ими и определён, и сдвинуть его порознь нечем',
    }
  }
  if (swung && (axis.endsWith('Shoulder') || axis === 'lean')) {
    return {
      kind: 'immovable',
      why:
        'поза со сведёнными кистями доворачивает руки вокруг плеч; тронь плечо или ' +
        'наклон корпуса — и кисти не сводятся, не выведя описанную руку из её полос',
    }
  }
  if (swung && axis.endsWith('Forearm')) {
    return {
      kind: 'coupled',
      with: [swapSuffix(axis, 'Forearm', 'Elbow'), 'hands'],
      why: 'повернув предплечье при описанном плече, меняешь и угол в локте, и зазор между кистями',
    }
  }
  if (axis === 'knees' && r.crouch === 'yes') {
    return {
      kind: 'immovable',
      why: 'присед САМ задаёт угол в колене: выпрямив колени, приседа не остаётся',
    }
  }
  if (axis === 'hands' && r.hands === 'no') {
    return {
      kind: 'immovable',
      why:
        'кисти врозь сбиваются только сведением, а сведение доворачивает руки — ' +
        'описанные плечо и предплечье этого не терпят',
    }
  }
  return null
}

// --- тесты ------------------------------------------------------------------

describe('совпадение кадра', () => {
  test('для каждого из 18 вырезов верный скелет совпадает', () => {
    for (const p of POSES) {
      const m = matchFrame(p, readPose(p))
      expect(failing(m), p.id).toEqual([])
      expect(m.matched, p.id).toBe(true)
      // Проверяются ровно требуемые оси, и у каждой — своё измерение.
      expect(Object.keys(m.perAxis).sort(), p.id).toEqual([...required(p)].sort())
      for (const axis of required(p)) {
        const v = m.perAxis[axis]!
        expect(v.want, `${p.id}.${axis}`).toBe(String(p.requires[axis]))
        expect(v.got, `${p.id}.${axis}`).toBe(v.want)
      }
    }
  })

  test('промах ровно по одной оси роняет только её', () => {
    const wrong: string[] = []
    const say = (p: PoseSpec, axis: Axis, what: string): void => {
      wrong.push(`${p.id}.${axis}: ${what}`)
    }
    for (const p of POSES) {
      for (const axis of required(p)) {
        const e = entangled(p, axis)
        const alone = onlyThisAxis(p, axis)
        const frames = broken(p, axis)
        const seen = (): string =>
          frames.map(({ label, match }) => `${label} → [${failing(match).join(',')}]`).join('; ')

        if (e === null) {
          // Сбивается порознь: обязан существовать кадр, где упала РОВНО она.
          if (alone.length === 0) {
            say(p, axis, `ни один из ${frames.length} кадров не уронил ровно её — ${seen()}`)
          }
          continue
        }
        // Правило обязано быть не только достаточным, но и необходимым: если
        // ось всё-таки сбивается порознь, правило устарело и его надо снять.
        if (alone.length > 0) {
          say(p, axis, `правило устарело (${e.why}): ${alone[0].label} уронил ровно эту ось`)
        }
        if (e.kind === 'immovable') {
          const fell = thisAxisFell(p, axis)
          if (fell.length > 0) {
            say(p, axis, `ось считалась несдвигаемой (${e.why}), но ${fell[0].label} её уронил`)
          }
          continue
        }
        const allowed = new Set<Axis>([axis, ...e.with])
        const together = thisAxisFell(p, axis).filter(({ match }) =>
          failing(match).every((a) => allowed.has(a)),
        )
        if (together.length === 0) {
          const only = e.with.join(',')
          say(p, axis, `ни один кадр не уронил её вместе только с [${only}] — ${seen()}`)
        }
      }
    }
    expect(wrong.join('\n')).toBe('')
  })

  test('подменённое показание одной оси роняет ровно её, и это промах', () => {
    // Скелетом промах ровно по одной оси выразим не всюду (см. `entangled`), а
    // приговор обязан изолировать КАЖДУЮ ось. Поэтому здесь подменяется само
    // показание: вход `matchFrame` — показания, а не кадр.
    for (const p of POSES) {
      const r = readPose(p)
      for (const axis of required(p)) {
        const other = otherState(axis, p.requires[axis])
        const m = matchFrame(p, { ...r, [axis]: { state: other, measured: r[axis].measured } })
        expect(failing(m), `${p.id}.${axis}`).toEqual([axis])
        expect(m.perAxis[axis]!.outcome, `${p.id}.${axis}`).toBe('miss')
        expect(m.perAxis[axis]!.got, `${p.id}.${axis}`).toBe(String(other))
        expect(m.matched, `${p.id}.${axis}`).toBe(false)
      }
    }
  })

  test('по каждой оси есть кадр, где ребёнок сделал НЕ ТО, а не кадр без измерения', () => {
    // Полнота выводится из `AXES`: ось, забытая и в позах, и здесь, иначе не
    // ловится ничем. Ориентация -- не ось совпадения, и в требованиях её нет.
    const judged = AXES.filter((axis) => POSES.some((p) => p.requires[axis] !== undefined))
    expect(judged).toEqual(AXES.filter((axis) => axis !== 'orientation'))

    for (const axis of judged) {
      const found = POSES.some((p) =>
        thisAxisFell(p, axis).some(
          ({ match }) => match.perAxis[axis]!.outcome === 'miss' && !match.matched,
        ),
      )
      expect(found, axis).toBe(true)
    }
  })

  test('оси, которых поза не требует, не проверяются', () => {
    const p = POSES.find((q) => q.id === 'tee')!
    const free = AXES.filter((axis) => axis !== 'orientation' && p.requires[axis] === undefined)
    expect(free.length).toBeGreaterThan(0)
    for (const axis of free) {
      for (const { label, match } of broken(p, axis)) {
        expect(match.perAxis[axis], `${p.id}.${axis} ${label}`).toBeUndefined()
        // Не требуемая ось не вправе ни ронять приговор, ни попадать в журнал.
        expect(failing(match).includes(axis), `${p.id}.${axis} ${label}`).toBe(false)
      }
    }
    // И хотя бы один такой кадр обязан остаться совпавшим: иначе утверждение
    // выше выполнялось бы просто потому, что кадры падают по другой причине.
    const hands = broken(p, 'hands')
    expect(hands.some(({ match }) => match.matched)).toBe(true)
  })

  test('ориентация не ось совпадения: в требованиях её нет и приговор её не судит', () => {
    for (const p of POSES) expect(p.requires.orientation, p.id).toBeUndefined()
    const p = POSES.find((q) => q.id === 'tee')!
    const spec: PoseSpec = { ...p, requires: { ...p.requires, orientation: 'profile' } }
    const m = matchFrame(spec, readPose(p))
    expect(m.perAxis.orientation).toBeUndefined()
    expect(m.matched).toBe(true)
  })

  test('unknown по требуемой оси — не совпадение', () => {
    const p = POSES.find((q) => q.id === 'tee')!
    const r = read({ ...poseDesc(p), visibilityOf: { leftShoulder: 0.1, leftElbow: 0.1 } })
    expect(r.leftShoulder.state).toBe('unknown')
    const m = matchFrame(p, r)
    expect(m.matched).toBe(false)
    const v = m.perAxis.leftShoulder!
    expect(v.ok).toBe(false)
    expect(v.got).toBe('unknown')
    // «Не смогли измерить» отличимо от «сделал не то»: взрослый, читающий
    // журнал, обязан видеть разницу.
    expect(v.outcome).toBe('unmeasured')
    expect(Number.isNaN(v.measured)).toBe(true)
    const miss = onlyThisAxis(p, 'leftShoulder').find(
      ({ match }) => match.perAxis.leftShoulder!.outcome === 'miss',
    )!
    expect(miss.match.perAxis.leftShoulder!.got).not.toBe('unknown')
  })

  test('в профильной позе подмена левого на правое не меняет приговор', () => {
    for (const p of POSES.filter((q) => q.orientation === 'profile')) {
      // Разворот тела в другую сторону: ближняя и дальняя сторона
      // отсчитываются ОТ КАМЕРЫ, поэтому приговор обязан совпасть.
      const right = matchFrame(p, read({ ...poseDesc(p), facing: 'right' }))
      const left = matchFrame(p, read({ ...poseDesc(p), facing: 'left' }))
      expect(right.matched, p.id).toBe(true)
      expect(left.matched, p.id).toBe(true)
      expect(Object.keys(left.perAxis).sort(), p.id).toEqual(Object.keys(right.perAxis).sort())

      // И подмена самих показаний: профильная поза не вправе смотреть ни в
      // одно поле `left*`/`right*`, значит их перестановка приговор не трогает.
      const r = read(poseDesc(p))
      expect(matchFrame(p, swapSides(r)), p.id).toEqual(matchFrame(p, r))
    }
  })

  test('в профиль промах дальней конечности с низкой visibility — не промах', () => {
    const p = POSES.find((q) => q.id === 'egypt')!
    // Взгляд в `+x` → к камере обращён ПРАВЫЙ бок, дальняя рука левая.
    const far = { leftShoulder: 0.1, leftElbow: 0.1, leftWrist: 0.1 }
    const spoiled = { ...poseDesc(p), facing: 'right' as const, farForearm: 'down' as const }

    // Видимая дальняя рука не в том состоянии — это промах.
    const seen = matchFrame(p, read(spoiled))
    expect(failing(seen)).toContain('farForearm')
    expect(seen.perAxis.farForearm!.outcome).toBe('miss')
    expect(seen.matched).toBe(false)

    // Та же рука, перекрытая телом, промахом не считается.
    const hidden = matchFrame(p, read({ ...spoiled, visibilityOf: far }))
    expect(hidden.perAxis.farForearm!.got).toBe('unknown')
    expect(hidden.perAxis.farForearm!.outcome).toBe('excused')
    expect(hidden.perAxis.farForearm!.ok).toBe(false)
    expect(hidden.matched).toBe(true)

    // Перекрытие оправдывает только ДАЛЬНЮЮ сторону: ближняя обращена к
    // камере, и её пропажа — случайность, а не свойство позы.
    const near = { rightShoulder: 0.1, rightElbow: 0.1, rightWrist: 0.1 }
    const blind = matchFrame(p, read({ ...poseDesc(p), visibilityOf: near }))
    expect(blind.perAxis.nearForearm!.outcome).toBe('unmeasured')
    expect(blind.matched).toBe(false)
  })

  test('во фронтальной позе перекрытие не оправдывает ничего', () => {
    const p = POSES.find((q) => q.id === 'tee')!
    const m = matchFrame(p, read({ ...poseDesc(p), visibilityOf: { leftElbow: 0.1 } }))
    expect(m.perAxis.leftShoulder!.outcome).toBe('unmeasured')
    expect(m.matched).toBe(false)
  })

  test('пустые показания (lm === null выше) не доходят сюда — matchFrame не вызывается', () => {
    // `matchFrame` принимает ПОКАЗАНИЯ, а не кадр: ветки «нет скелета» у него
    // нет и быть не должно. Путь к показаниям один — `geometry()` → `axes()`,
    // и он обрывается раньше.
    const empty: Frame = { t: 0, lm: null }
    expect(geometry(empty.lm, ASPECT)).toBeNull()
    const judge = (p: PoseSpec, f: Frame): FrameMatch | null => {
      if (f.lm === null) return null
      const g = geometry(f.lm, ASPECT)
      if (g === null) return null
      return matchFrame(p, axes(f.lm, g, CAL, 1))
    }
    expect(judge(POSES[0], empty)).toBeNull()
    expect(judge(POSES[0], { t: 0, lm: frame(poseDesc(POSES[0])) })?.matched).toBe(true)
  })

  test('measured доходит до журнала по каждой требуемой оси', () => {
    // Главное, ради чего журнал существует: «левое плечо 58° при цели 90±30».
    const p = POSES.find((q) => q.id === 'tee')!
    const m = matchFrame(p, readPose(p))
    const r = readPose(p)
    for (const axis of required(p)) {
      expect(m.perAxis[axis]!.measured, axis).toBe(r[axis].measured)
      expect(Number.isFinite(m.perAxis[axis]!.measured), axis).toBe(true)
    }
    // Чем измерена ось ног — тоже: «ноги 2.0» по стопам и по коленям разные.
    const crouched = POSES.find((q) => q.id === 'barrier')!
    const legs = matchFrame(crouched, readPose(crouched)).perAxis.legs!
    expect(legs.measuredBy).toBe(readPose(crouched).legs.measuredBy)
    expect(legs.measuredBy).toBeDefined()
  })
})

/** Перестановка показаний левого и правого: профильный приговор её не видит. */
function swapSides(r: AxisReadings): AxisReadings {
  const out = { ...r }
  for (const axis of AXES) {
    if (!axis.startsWith('left')) continue
    const other = `right${axis.slice(4)}` as Axis
    Object.assign(out, { [axis]: r[other], [other]: r[axis] })
  }
  return out
}
