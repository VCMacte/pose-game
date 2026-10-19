import { describe, expect, test } from 'vitest'
import { AXES, axes, type Axis, type AxisReadings } from '../../src/core/axes'
import { strictness } from '../../src/core/config'
import { dependentAxes, limbImplications } from '../../src/core/dependencies'
import { geometry } from '../../src/core/geometry'
import { cutouts, POSES, type Toggles } from '../../src/core/poses'
import { POSE_TAGS, type Calibration, type Landmarks, type PoseSpec, type PoseTag } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Набор поз — данные, и проверяются они как данные: сторожами над всем набором,
 * а не выборочными примерами.
 *
 * Два правила держат этот файл:
 *
 * - **Полнота выводится из `AXES`** — канонического списка осей ядра, а не из
 *   таблицы в этом файле. Таблица рядом с тестом ловит только то, что в неё
 *   вписали: забудь ось в обоих местах, и не поймает ничто.
 * - **Различимость двусторонняя.** Профильная поза не вправе использовать ни
 *   одно поле `left*`/`right*`, фронтальная — ни одно `near*`/`far*`. Тип
 *   `AxisRequirements` плоский и позволяет задать и то, и другое; размеченного
 *   объединения здесь сознательно нет, значит невозможность обеспечивает тест.
 */

const NAMES = 13
const CUTOUTS = 18
const MIRRORED = 5

const ASPECT = 16 / 9
const TIERS = [1, 2, 3] as const

/** Пары сторон, выведенные из `AXES`: `left*`↔`right*` и `near*`↔`far*`. */
const SIDE_PAIRS: [Axis, Axis][] = AXES.flatMap((axis) => {
  if (axis.startsWith('left')) return [[axis, `right${axis.slice(4)}` as Axis]]
  if (axis.startsWith('near')) return [[axis, `far${axis.slice(4)}` as Axis]]
  return []
})

const state = (p: PoseSpec, axis: Axis): unknown => p.requires[axis]

/** Оси, по которым требуемое состояние задано у ОБЕИХ поз и расходится. */
function differing(a: PoseSpec, b: PoseSpec): Axis[] {
  return AXES.filter((axis) => {
    const x = state(a, axis)
    const y = state(b, axis)
    return x !== undefined && y !== undefined && x !== y
  })
}

/** Все три строгости: полосы у них разной ширины, а правило одно. */
const LEVELS = (['soft', 'normal', 'strict'] as const).map((l) => strictness(l))
const NORMAL = strictness('normal')

/**
 * Запас различимости пары: оси, которые расходятся и при этом НЕ определены
 * другими осями той же позы.
 *
 * Зависимая ось повторяет соседей (см. `src/core/dependencies.ts`), поэтому
 * запасом быть не может: пара, разведённая только ею, — это пара, которую
 * ребёнок не различает. Ось исключается, если зависима хоть у одной из двух
 * поз: расхождение считается честным только там, где обе позы вольны выбирать.
 */
function independentDiffering(a: PoseSpec, b: PoseSpec, strict: number): Axis[] {
  const dependent = new Set<Axis>([...dependentAxes(a, strict), ...dependentAxes(b, strict)])
  return differing(a, b).filter((axis) => !dependent.has(axis))
}

const pairs = (): [PoseSpec, PoseSpec][] =>
  POSES.flatMap((a, i) => POSES.slice(i + 1).map((b): [PoseSpec, PoseSpec] => [a, b]))

/** Теги, которые ОБЯЗАНЫ стоять у позы при таких требованиях. */
function tagsFrom(p: PoseSpec): PoseTag[] {
  const r = p.requires
  const tags: PoseTag[] = []
  if (r.crouch === 'yes') tags.push('crouch')
  if (r.lean !== undefined && r.lean !== 'upright') tags.push('lean')
  if (SIDE_PAIRS.some(([one, other]) => state(p, one) !== state(p, other))) tags.push('asymmetric')
  if (p.orientation === 'profile') tags.push('profile')
  if (r.support === 'left' || r.support === 'right') tags.push('one-leg')
  return tags.sort()
}

// --- синтетический скелет: та же развязка, что в tests/core/axes.test.ts -----

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

/** Кадр самой позы: требования уходят в фикстуру как есть. */
function readPose(p: PoseSpec): AxisReadings {
  const lm = frame({ orientation: p.orientation, ...p.requires })
  return axes(lm, geometry(lm, ASPECT)!, CAL, 1)
}

describe('набор', () => {
  test('13 названий и 18 вырезов: пять названий с зеркалом', () => {
    expect(new Set(POSES.map((p) => p.name)).size).toBe(NAMES)
    expect(POSES.length).toBe(CUTOUTS)
    expect(POSES.filter((p) => p.mirror)).toHaveLength(MIRRORED)
    expect(new Set(POSES.map((p) => p.id)).size).toBe(CUTOUTS)
  })

  test('профильная поза зеркала не имеет: его нечем судить', () => {
    // Ближняя и дальняя сторона отсчитываются ОТ КАМЕРЫ, а угол конечности — в
    // сторону взгляда. Поворот в другую сторону поэтому даёт ровно те же
    // показания осей (это утверждает tests/core/axes.test.ts: «зеркальный
    // поворот не меняет ближнюю и дальнюю»). Отдельный вырез с теми же
    // требованиями был бы вырезом, которого судейство не отличает от
    // исходного, — то есть ребёнок, повернувшийся не в ту сторону, получал бы
    // попадание при силуэте, в вырез не входящем.
    expect(POSES.filter((p) => p.orientation === 'profile' && p.mirror)).toEqual([])
  })

  test('зеркало — перестановка левого и правого при том же названии', () => {
    for (const m of POSES.filter((p) => p.mirror)) {
      const origin = POSES.find((p) => p.name === m.name && !p.mirror)
      expect(origin, m.id).toBeDefined()
      if (origin === undefined) continue
      expect(m.tier).toBe(origin.tier)
      expect(m.orientation).toBe(origin.orientation)
      expect([...m.tags].sort()).toEqual([...origin.tags].sort())
      for (const [one, other] of SIDE_PAIRS) {
        expect(state(m, one), `${m.id}.${one}`).toBe(state(origin, other))
        expect(state(m, other), `${m.id}.${other}`).toBe(state(origin, one))
      }
      expect(m.requires.support).toBe(
        origin.requires.support === 'left'
          ? 'right'
          : origin.requires.support === 'right'
            ? 'left'
            : origin.requires.support,
      )
      expect(m.requires.lean).toBe(
        origin.requires.lean === 'lean-left'
          ? 'lean-right'
          : origin.requires.lean === 'lean-right'
            ? 'lean-left'
            : origin.requires.lean,
      )
      // Зеркало обязано быть отличимо от своего оригинала — иначе это два
      // выреза с одним приговором.
      expect(differing(m, origin).length, `${m.id} vs ${origin.id}`).toBeGreaterThan(0)
    }
  })
})

describe('различимость', () => {
  test('каждая пара отличается минимум одним целым состоянием оси', () => {
    for (const [a, b] of pairs()) {
      // Разная ориентация разводит пару СИЛЬНЕЕ промаха: кадр не с той
      // ориентацией невалиден вовсе (причина отказа присутствия), а не
      // «промахнулся». Повернув «Букву Т» в профиль, плечи `side` сохранить
      // нельзя, поэтому требовать от такой пары расхождения по осям нечем —
      // и ориентация в `requires` поэтому не живёт.
      if (a.orientation !== b.orientation) continue
      expect(differing(a, b), `${a.id} vs ${b.id}`).not.toHaveLength(0)
    }
  })

  test('запас каждой пары набран НЕЗАВИСИМЫМИ осями, при любой строгости', () => {
    // Расхождение по оси, чьё состояние определено другими осями той же позы,
    // запасом не является: ось повторяет соседей, и считать её значило бы
    // объявить различимыми две позы, которых ребёнок не различает — прямое
    // попадание в анти-цель «две позы отличаются оттенком».
    //
    // Строгость входит сюда потому, что она сужает полосы: при `strict` рук
    // становится определено БОЛЬШЕ, а значит запас — меньше. Пара обязана
    // держаться на самой узкой настройке, а не только на нормальной.
    for (const strict of LEVELS) {
      for (const [a, b] of pairs()) {
        if (a.orientation !== b.orientation) continue
        expect(independentDiffering(a, b, strict), `${a.id} vs ${b.id} @${strict}`).not.toHaveLength(
          0,
        )
      }
    }
  })

  test('сторож запаса не считает ось, определённую соседями', () => {
    // Сторож, который считает зависимую ось, выглядит как зелёный тест. У
    // «Плоского Робота» левый локоть определён плечом `side` и предплечьем
    // `up`, поэтому пара, разведённая ТОЛЬКО им, обязана дать нулевой запас —
    // при полном расхождении в одну ось.
    const robot = POSES.find((p) => p.id === 'robot')!
    expect(dependentAxes(robot, NORMAL)).toContain('leftElbow')
    const twin: PoseSpec = {
      ...robot,
      id: 'robot-twin',
      name: 'Двойник',
      requires: { ...robot.requires, leftElbow: 'straight' },
    }
    expect(differing(twin, robot)).toEqual(['leftElbow'])
    expect(independentDiffering(twin, robot, NORMAL)).toHaveLength(0)
    // И наоборот: независимая ось запасом остаётся.
    const leaning: PoseSpec = {
      ...robot,
      id: 'robot-leaning',
      name: 'Накренившийся',
      requires: { ...robot.requires, lean: 'horizontal' },
    }
    expect(independentDiffering(leaning, robot, NORMAL)).toEqual(['lean'])
  })

  test('сторож различимости ловит две похожие позы', () => {
    // Сторож, который ничего не ловит, выглядит как зелёный тест. Клон позы с
    // теми же требованиями обязан дать пустое расхождение — ровно то, на чём
    // падает тест выше.
    const origin = POSES[0]
    const clone: PoseSpec = { ...origin, id: `${origin.id}-clone`, name: 'Клон' }
    expect(differing(clone, origin)).toHaveLength(0)
    // И наоборот: смена одного целого состояния расхождение даёт.
    const changed: PoseSpec = { ...clone, requires: { ...clone.requires, lean: 'horizontal' } }
    expect(differing(changed, origin)).toEqual(['lean'])
  })

  test('профильная поза не различает левое и правое', () => {
    for (const p of POSES.filter((p) => p.orientation === 'profile')) {
      for (const axis of AXES.filter((a) => a.startsWith('left') || a.startsWith('right'))) {
        expect(state(p, axis), `${p.id}.${axis}`).toBeUndefined()
      }
    }
  })

  test('фронтальная поза не говорит о ближней и дальней стороне', () => {
    for (const p of POSES.filter((p) => p.orientation === 'front')) {
      for (const axis of AXES.filter((a) => a.startsWith('near') || a.startsWith('far'))) {
        expect(state(p, axis), `${p.id}.${axis}`).toBeUndefined()
      }
    }
  })
})

describe('требования', () => {
  test('ни одна поза не требует ориентацию: её владелец — PoseSpec.orientation', () => {
    for (const p of POSES) expect(p.requires.orientation, p.id).toBeUndefined()
  })

  test('требуются только оси из AXES, и каждая из них — хоть одной позой', () => {
    const known = new Set<string>(AXES)
    for (const p of POSES) {
      for (const key of Object.keys(p.requires)) expect(known.has(key), `${p.id}.${key}`).toBe(true)
    }
    // Полнота выводится из AXES, а не из таблицы рядом: ось, которую не
    // требует ни одна поза, — ось, которую ядро умеет читать, а судить по ней
    // нечего.
    for (const axis of AXES) {
      if (axis === 'orientation') continue
      expect(
        POSES.some((p) => state(p, axis) !== undefined),
        axis,
      ).toBe(true)
    }
  })

  test('теги позы — только известные значения, без повторов', () => {
    const allowed = new Set<PoseTag>(POSE_TAGS)
    for (const p of POSES) {
      for (const tag of p.tags) expect(allowed.has(tag), `${p.id}.${tag}`).toBe(true)
      expect(new Set(p.tags).size, p.id).toBe(p.tags.length)
    }
    // Прыжка и движения вдоль оптической оси в словаре нет вовсе: это
    // отсутствующая категория, а не выключенная опция. `AXES` фиксирует это
    // на уровне типов (сторож полноты в axes.ts) — проверка того же здесь
    // рантаймом ничего не ловит и ловить не может, поэтому не дублируется.
  })

  test('tags у каждой позы согласны с requires', () => {
    for (const p of POSES) expect([...p.tags].sort(), p.id).toEqual(tagsFrom(p))
  })

  test('tier от 1 до 3 и согласован со ступенями', () => {
    for (const p of POSES) {
      expect(TIERS, p.id).toContain(p.tier)
      const tags = new Set(p.tags)
      // Ступень 1 — фронтальные симметричные на двух ногах, без тегов вовсе.
      if (p.tier === 1) expect([...tags], p.id).toEqual([])
      // Ступень 2 добавляет асимметричные руки и наклон, ступень 3 — присед,
      // опору на одной ноге и профиль.
      if (tags.has('asymmetric') || tags.has('lean')) {
        expect(p.tier, p.id).toBeGreaterThanOrEqual(2)
      }
      for (const tag of ['crouch', 'one-leg', 'profile'] as const) {
        if (tags.has(tag)) expect(p.tier, `${p.id}.${tag}`).toBe(3)
      }
    }
  })
})

describe('согласованность связанных осей', () => {
  test('состояние звена — то, которое подразумевают два соседних', () => {
    // Плечо, локоть и предплечье одной руки сидят на одном уравнении
    // |плечо − предплечье| = 180° − локоть, поэтому поза, задавшая все три,
    // могла задать их противоречиво: вырез показывал бы ребёнку руку, которой
    // не бывает, а приговор требовал бы её же. До этого теста набор был
    // согласован по случайности — теперь это проверено.
    let checked = 0
    const skipped = new Set<string>()
    for (const strict of LEVELS) {
      for (const p of POSES) {
        for (const [axis, implied] of Object.entries(limbImplications(p, strict))) {
          // Рука на камеру (`front` во фронтальном кадре) опознаётся
          // вырождением проекции, а не углом: уравнение к ней не применяется.
          if (implied.kind === 'no-angle') {
            skipped.add(`${p.id}.${axis}`)
            continue
          }
          const want = state(p, axis as Axis)
          expect(implied.reachable, `${p.id}.${axis} @${strict}: не выразимо рукой`).toContain(want)
          expect(implied.nominal, `${p.id}.${axis} @${strict}: не то, что в центре полос`).toContain(
            want,
          )
          if (implied.kind === 'derived') {
            expect(implied.state, `${p.id}.${axis} @${strict}`).toBe(want)
          }
          checked += 1
        }
      }
    }
    // Сторож, которому нечего сторожить, выглядит как зелёный тест.
    expect(checked).toBeGreaterThan(0)
    // И список необойдённого не вправе тихо расти: руки «на камеру» есть
    // только у «Боксёра», и больше ни одна рука набора от проверки не уходит.
    expect([...skipped].sort()).toEqual([
      'boxer.leftElbow',
      'boxer.leftForearm',
      'boxer.leftShoulder',
      'boxer.rightElbow',
      'boxer.rightForearm',
      'boxer.rightShoulder',
    ])
  })

  test('сторож согласованности ловит подменённое состояние локтя', () => {
    // Плечо `side` с предплечьем `up` оставляют локтю ровно `bent`: подменив
    // его на `straight`, получаем руку, которой не бывает, — и тест выше
    // обязан падать именно на этом.
    const robot = POSES.find((p) => p.id === 'robot')!
    const broken: PoseSpec = {
      ...robot,
      requires: { ...robot.requires, leftElbow: 'straight' },
    }
    const implied = limbImplications(broken, NORMAL).leftElbow!
    expect(implied.kind).toBe('derived')
    // Сужение типа: строка недостижима — `kind` проверен выше.
    if (implied.kind === 'no-angle') throw new Error(implied.why)
    expect(implied.reachable).not.toContain('straight')
    expect(implied.reachable).toEqual(['bent'])
  })
})

describe('выполнимость', () => {
  test('каждая поза собирается скелетом и читается обратно теми же состояниями', () => {
    // Это и есть проверка того, что требования — поза, а не набор слов: кадр,
    // построенный прямой кинематикой из `requires`, обязан вернуться из
    // `axes()` ровно теми же состояниями. Иначе вырез показывал бы ребёнку
    // одно, а приговор требовал другого.
    for (const p of POSES) {
      const r = readPose(p) as unknown as Record<Axis, { state: unknown }>
      expect(r.orientation.state, `${p.id}.orientation`).toBe(p.orientation)
      for (const axis of AXES) {
        const want = state(p, axis)
        if (want === undefined) continue
        expect(r[axis].state, `${p.id}.${axis}`).toBe(want)
      }
    }
  })
})

describe('пул вырезов', () => {
  test('ступень N включает всё с ней и ниже', () => {
    expect(cutouts(3)).toHaveLength(CUTOUTS)
    for (const tier of TIERS) {
      const pool = cutouts(tier)
      expect(
        pool.every((p) => p.tier <= tier),
        `ступень ${tier}`,
      ).toBe(true)
      expect(pool).toEqual(POSES.filter((p) => p.tier <= tier))
    }
    expect(cutouts(1).length).toBeLessThan(cutouts(2).length)
    expect(cutouts(2).length).toBeLessThan(cutouts(3).length)
  })

  test('тумблер вычитает из пула по тегу', () => {
    const off: Toggles = { crouch: false }
    expect(cutouts(3, off).some((p) => p.tags.includes('crouch'))).toBe(false)
    expect(cutouts(3, off).length).toBe(
      CUTOUTS - POSES.filter((p) => p.tags.includes('crouch')).length,
    )
    // Выключенная категория не выпадает ребёнку ни в одном вырезе — именно
    // поэтому тег обязан быть согласен с requires.
    for (const tag of POSE_TAGS) {
      expect(cutouts(3, { [tag]: false }).some((p) => p.tags.includes(tag)), tag).toBe(false)
    }
  })

  test('пул не падает ниже трёх ни при одной комбинации ступени и тумблеров', () => {
    const tags = POSE_TAGS
    for (const tier of TIERS) {
      for (let mask = 0; mask < 1 << tags.length; mask += 1) {
        const toggles: Toggles = {}
        tags.forEach((tag, i) => {
          if ((mask & (1 << i)) !== 0) toggles[tag] = false
        })
        const pool = cutouts(tier, toggles)
        expect(pool.length, `ступень ${tier}, маска ${mask}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
