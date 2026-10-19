import { describe, expect, test } from 'vitest'
import type { Axis } from '../../src/core/axes'
import { CONFIG } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { judgeWindow, type CheckedFrame, type Verdict } from '../../src/core/judge'
import { POSES } from '../../src/core/poses'
import { newPresenceState, presence, type PresenceReason } from '../../src/core/presence'
import type { Calibration, Frame, Landmarks, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Окно судейства и приговор за раунд. Голосование по окну кадров — здесь;
 * совпадение одного кадра — в `match.test.ts`.
 *
 * Валидность кадров судья не считает, а получает готовой, поэтому её здесь
 * считает `checked()` — роль забега (задача 12): одна память присутствия на всю
 * серию кадров, как на живой камере. Фикстуры от этого не изменились: `LOST`
 * по-прежнему означает «трекер потерял ребёнка», просто отвергает такой кадр
 * теперь присутствие забега, а не судья.
 *
 * Пять правил держат этот файл:
 *
 * - **Что судья читает вердикт, а не пересчитывает его, проверяется кадрами с
 *   вердиктом, назначенным ВРУЧНУЮ** (`valid()` / `invalid()`): верная поза,
 *   отвергнутая забегом, не судится, а потерянный трекингом кадр, помеченный
 *   годным, судится. Через `checked()` оба случая были бы невидимы — там
 *   вердикт совпадает с тем, что судья посчитал бы сам.
 * - **Тест на ЗНАК сдвига обязан падать при смене знака.** Тест «сдвиг
 *   сдвигает окно» этого не ловит: ошибка в нём невидима. Поэтому задержка
 *   взята равной окну (`latency === windowMs`), и верное окно
 *   `[contact, contact + 600]` не пересекается с перевёрнутым
 *   `[contact − 1200, contact − 600]` вовсе — между ними зазор 600 мс. Кадры с
 *   верной позой лежат в одном из них, с неверной — в другом, и приговор
 *   меняется с `hit` на `miss` ровно от смены знака.
 * - **Счётчики утверждаются вместе с исходом.** `kind` один совпадает слишком
 *   часто случайно: отбор по номеру кадра вместо времени, деление на все кадры
 *   вместо валидных и исключённая граница окна дают тот же `hit`/`miss` при
 *   других `frames`/`valid`/`matched`. Поэтому проверяется вся четвёрка.
 * - **Границы ловятся на 7±1 кадре, а не на круглых числах:** при 11–12 Гц
 *   окно 600 мс даёт столько, и 60 % там — это 3 из 5 или 5 из 7.
 * - **Обе стороны анти-цели.** Строгость, съедающая очки за потерю трекинга
 *   (невалидный кадр в знаменателе, ориентация как промах), и мягкость,
 *   зачитывающая позу, которой ребёнок не делал (кадры вне окна), проверяются
 *   порознь.
 */

const ASPECT = 16 / 9

const shot = (desc: Partial<StickDesc>): Landmarks => stick({ aspect: ASPECT, ...desc })

function calibrate(): Calibration {
  const g = geometry(shot({}), ASPECT)!
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

const TEE: PoseSpec = POSES.find((p) => p.id === 'tee')!

/** Кадр самой позы: требования уходят в фикстуру как есть. */
const RIGHT: Partial<StickDesc> = { orientation: TEE.orientation, ...TEE.requires }

/** Та же поза с опущенными руками: промах по плечам, ориентация та же — кадр ВАЛИДЕН. */
const WRONG: Partial<StickDesc> = { ...RIGHT, leftShoulder: 'down', rightShoulder: 'down' }

/** Верная поза, но трекер потерял ребёнка: кадр НЕвалиден (`lowvis`). */
const LOST: Partial<StickDesc> = { ...RIGHT, visibility: 0.2 }

/** Верная поза, но ребёнок у края кадра: присутствие отвергает (`edge`), поза совпадает. */
const AT_EDGE: Partial<StickDesc> = { ...RIGHT, x: 0.07 }

/** Неверная поза И потерянный трекинг: невалидный кадр, который нельзя засчитать. */
const WRONG_LOST: Partial<StickDesc> = { ...WRONG, visibility: 0.2 }

/** Касание стены в игровом времени и задержка тракта, равная длине окна. */
const CONTACT = 10_000
const LATENCY = CONFIG.judge.windowMs

const WINDOW_END = CONTACT + LATENCY
const WINDOW_START = WINDOW_END - CONFIG.judge.windowMs

/** 12 Гц: окно 600 мс даёт 7 кадров, как на живой камере. */
const PERIOD = 83

const judgeChecked = (frames: CheckedFrame[], spec: PoseSpec = TEE): Verdict =>
  judgeWindow({ spec, frames, contactT: CONTACT, latencyMs: LATENCY, cal: CAL, strict: 1 })

/**
 * Роль ЗАБЕГА: присутствие считается один раз, непрерывной памятью по всей
 * серии, и уезжает в судью вместе с кадрами. Кадры проходят через `presence()`
 * в порядке времени — память присутствия автомат, и пропуск кадра сдвинул бы
 * её, — включая негодные.
 */
function checked(frames: Frame[], spec: PoseSpec = TEE): CheckedFrame[] {
  const st = newPresenceState()

  return [...frames]
    .sort((a, b) => a.t - b.t)
    .map((f) => {
      const gm = f.lm === null ? null : geometry(f.lm, CAL.aspect)
      const v = presence(gm, f.t, st, spec.orientation)
      // Присутствие подтвердило кадр — значит у него есть и скелет, и геометрия.
      return v.ok
        ? ({ t: f.t, ok: true, lm: f.lm!, gm: gm! } as const)
        : ({ t: f.t, ok: false, why: v.why } as const)
    })
}

const judge = (frames: Frame[], spec: PoseSpec = TEE): Verdict =>
  judgeChecked(checked(frames, spec), spec)

/** Кадры с ВРУЧНУЮ назначенным годным вердиктом — чем бы их ни считало присутствие. */
const valid = (frames: Frame[]): CheckedFrame[] =>
  frames.map((f) => ({ t: f.t, ok: true, lm: f.lm!, gm: geometry(f.lm!, ASPECT)! }))

/** Кадры, ВРУЧНУЮ отвергнутые забегом по названной причине. */
const invalid = (frames: Frame[], why: PresenceReason): CheckedFrame[] =>
  frames.map((f) => ({ t: f.t, ok: false, why }))

/** Кадры с шагом 12 Гц от `from` до `to` включительно; поза решается ВРЕМЕНЕМ кадра. */
function series(from: number, to: number, at: (t: number) => Partial<StickDesc>): Frame[] {
  const out: Frame[] = []
  for (let t = from; t <= to; t += PERIOD) out.push({ t, lm: shot(at(t)) })
  return out
}

/**
 * Ровно столько кадров внутри окна, сколько описаний, от его начала.
 *
 * Шаг — 12 Гц, пока столько кадров в окно влезает (это все случаи на 5–8
 * кадрах, то есть все границы голосования); для более длинных наборов кадры
 * уплотняются, чтобы остаться В ОКНЕ — иначе тест проверял бы отбор по
 * времени, а не то, ради чего написан.
 */
function inWindow(descs: Partial<StickDesc>[]): Frame[] {
  const span = CONFIG.judge.windowMs - 2
  const step = Math.min(PERIOD, Math.floor(span / Math.max(1, descs.length - 1)))
  return descs.map((d, i) => ({ t: WINDOW_START + 1 + i * step, lm: shot(d) }))
}

const times = (n: number, d: Partial<StickDesc>): Partial<StickDesc>[] =>
  Array.from({ length: n }, () => d)

/** Оси, промахнувшиеся хоть в одном кадре окна. */
const missed = (v: Verdict): Axis[] =>
  (Object.keys(v.perAxis.axes) as Axis[]).filter((a) => v.perAxis.axes[a]!.counts.miss > 0)

describe('знак сдвига на задержку', () => {
  // Кадры покрывают и верное окно, и перевёрнутое, с запасом: приговор
  // различает их только знаком сдвига.
  const SPAN_FROM = CONTACT - 1300
  const SPAN_TO = CONTACT + 700

  test('поза, пойманная только ПОСЛЕ касания, даёт hit', () => {
    const v = judge(series(SPAN_FROM, SPAN_TO, (t) => (t >= CONTACT ? RIGHT : WRONG)))

    // Сдвиг ВПЕРЁД: окно [10000, 10600] — там только верные кадры.
    expect(v.kind).toBe('hit')
    expect(v.frames).toBe(7)
    expect(v.valid).toBe(7)
    expect(v.matched).toBe(7)
    // Сдвиг НАЗАД дал бы окно [8800, 9400] — там только неверные кадры, и
    // приговор стал бы `miss`. Это и есть падение при смене знака.
  })

  test('поза, пойманная только ДО касания, даёт miss', () => {
    const v = judge(series(SPAN_FROM, SPAN_TO, (t) => (t < CONTACT ? RIGHT : WRONG)))

    expect(v.kind).toBe('miss')
    expect(v.valid).toBe(7)
    expect(v.matched).toBe(0)
    // При сдвиге назад те же кадры дали бы `hit` — ребёнок получил бы очки за
    // позу, которую отпустил ещё до касания стены.
  })
})

describe('валидность приходит вместе с кадрами', () => {
  test('кадр, отвергнутый забегом, не судится даже с верной позой', () => {
    // Вошедшая в кадр мама: забег отверг кадры как `jump`, и ни одна поза в
    // них зачёта не даёт. Своя память присутствия у судьи дала бы `hit` — в
    // ней первый кадр окна доверенным торсом не проверяется вовсе.
    const v = judgeChecked(invalid(inWindow(times(7, RIGHT)), 'jump'))

    expect(v.frames).toBe(7)
    expect(v.valid).toBe(0)
    expect(v.matched).toBe(0)
    expect(v.kind).toBe('skip')
    expect(v.why).toBe('fewFrames')
  })

  test('кадр, признанный забегом годным, судится — судья вердикт не пересчитывает', () => {
    // Фикстура подобрана так, что присутствие её отвергает (ребёнок у края
    // кадра), а поза при этом верная: пересчитай судья годность — вышел бы
    // `skip` при нуле валидных. Первая строка это и доказывает.
    expect(judge(inWindow(times(5, AT_EDGE))).valid).toBe(0)

    const v = judgeChecked(valid(inWindow(times(5, AT_EDGE))))

    expect(v.valid).toBe(5)
    expect(v.matched).toBe(5)
    expect(v.kind).toBe('hit')
  })
})

describe('отбор кадров по времени', () => {
  test('кадры вне окна игнорируются', () => {
    // Верных кадров вне окна вдвое больше, чем неверных внутри: отбор по
    // номеру кадра вместо времени дал бы 10 из 15 — зачёт за позу, которой
    // ребёнок в окне не делал.
    const outside = [
      ...series(WINDOW_START - 5 * PERIOD, WINDOW_START - PERIOD, () => RIGHT),
      ...series(WINDOW_END + PERIOD, WINDOW_END + 5 * PERIOD, () => RIGHT),
    ]
    const v = judge([...outside, ...inWindow(times(5, WRONG))])

    expect(outside).toHaveLength(10)
    expect(v.frames).toBe(5)
    expect(v.valid).toBe(5)
    expect(v.matched).toBe(0)
    expect(v.kind).toBe('miss')
  })

  test('границы окна включительны', () => {
    const edges = [WINDOW_START, WINDOW_START + 150, CONTACT + 300, WINDOW_END - 150, WINDOW_END]
    const v = judge(edges.map((t) => ({ t, lm: shot(RIGHT) })))

    expect(v.frames).toBe(5)
    expect(v.valid).toBe(5)
    expect(v.kind).toBe('hit')
  })
})

describe('голосование', () => {
  test('5 из 7 валидных — hit', () => {
    const v = judge(inWindow([...times(5, RIGHT), ...times(2, WRONG)]))

    expect(v.valid).toBe(7)
    expect(v.matched).toBe(5)
    expect(v.kind).toBe('hit')
  })

  test('3 из 7 валидных — miss', () => {
    const v = judge(inWindow([...times(3, RIGHT), ...times(4, WRONG)]))

    expect(v.valid).toBe(7)
    expect(v.matched).toBe(3)
    expect(v.kind).toBe('miss')
    expect(v.why).toBe('lowRatio')
  })

  test('ровно 0.60 — граница включительна: 3 из 5 — hit', () => {
    const v = judge(inWindow([...times(3, RIGHT), ...times(2, WRONG)]))

    expect(v.valid).toBe(5)
    expect(v.ratio).toBe(CONFIG.judge.ratio)
    expect(v.kind).toBe('hit')
  })

  test('чуть ниже 0.60 — 3 из 6 — miss', () => {
    const v = judge(inWindow([...times(3, RIGHT), ...times(3, WRONG)]))

    expect(v.ratio).toBeLessThan(CONFIG.judge.ratio)
    expect(v.kind).toBe('miss')
  })

  test('ratio считается от ВАЛИДНЫХ, не от всех', () => {
    // 3 совпавших, 2 валидных-несовпавших, 5 невалидных с НЕВЕРНОЙ позой:
    // деление на все кадры дало бы 3/10 = 0.3, то есть промах за потерю
    // трекинга. Знаменатель из валидных даёт ровно 0.60 — зачёт.
    const v = judge(inWindow([...times(3, RIGHT), ...times(2, WRONG), ...times(5, WRONG_LOST)]))

    expect(v.frames).toBe(10)
    expect(v.valid).toBe(5)
    expect(v.matched).toBe(3)
    expect(v.ratio).toBe(CONFIG.judge.ratio)
    expect(v.kind).toBe('hit')
  })

  test('невалидные кадры не съедают очки даже с верной позой', () => {
    const v = judge(inWindow([...times(4, RIGHT), ...times(4, LOST)]))

    expect(v.valid).toBe(4)
    expect(v.matched).toBe(4)
    expect(v.ratio).toBe(1)
    expect(v.kind).toBe('hit')
  })

  test('не та ориентация делает кадр невалидным, а не промахнувшимся', () => {
    // Повернувшись боком в фронтальной позе, плечи `side` сохранить нельзя:
    // будь ориентация осью совпадения, вышло бы 4 из 7 = 0.571 — промах.
    const turned: Partial<StickDesc> = { ...RIGHT, profileLateral: CONFIG.figure.profileLateral }
    const v = judge(inWindow([...times(4, RIGHT), ...times(3, turned)]))

    expect(v.frames).toBe(7)
    expect(v.valid).toBe(4)
    expect(v.matched).toBe(4)
    expect(v.kind).toBe('hit')
  })
})

describe('мало кадров', () => {
  test('валидных ровно 4 — граница minValid включительна: hit', () => {
    const v = judge(inWindow([...times(3, RIGHT), ...times(1, WRONG), ...times(3, LOST)]))

    expect(v.valid).toBe(CONFIG.judge.minValid)
    expect(v.ratio).toBe(0.75)
    expect(v.kind).toBe('hit')
  })

  test('валидных 3 — skip, а не miss: порог один', () => {
    // Порог один: `minValid`. Три валидных кадра — это «ребёнка почти не было
    // видно», и минус два очка за такой раунд били бы по анти-цели «наказан за
    // то, что трекер его потерял». Даже при идеальном отношении 3/3 — `skip`.
    const v = judge(inWindow([...times(3, RIGHT), ...times(4, LOST)]))

    expect(v.valid).toBe(3)
    expect(v.matched).toBe(3)
    expect(v.ratio).toBe(1)
    expect(v.kind).toBe('skip')
    expect(v.why).toBe('fewFrames')
  })

  test('валидных 2 — skip с why fewFrames', () => {
    const v = judge(inWindow([...times(2, RIGHT), ...times(5, LOST)]))

    expect(v.valid).toBe(2)
    expect(v.kind).toBe('skip')
    expect(v.why).toBe('fewFrames')
  })

  test('ноль валидных кадров — skip, без деления на ноль', () => {
    const v = judge(inWindow(times(7, LOST)))

    expect(v.frames).toBe(7)
    expect(v.valid).toBe(0)
    expect(v.matched).toBe(0)
    expect(v.ratio).toBe(0)
    expect(Number.isNaN(v.ratio)).toBe(false)
    expect(v.kind).toBe('skip')
  })

  test('пустой массив кадров — skip', () => {
    const v = judge([])

    expect(v.frames).toBe(0)
    expect(v.valid).toBe(0)
    expect(v.ratio).toBe(0)
    expect(v.kind).toBe('skip')
    expect(v.perAxis.axes).toEqual({})
    expect(v.perAxis.worst).toBeNull()
  })

  test('кадр без скелета — невалиден, а не падение', () => {
    const v = judge([
      ...inWindow(times(4, RIGHT)),
      { t: WINDOW_START + 500, lm: null },
      { t: WINDOW_START + 550, lm: null },
    ])

    expect(v.frames).toBe(6)
    expect(v.valid).toBe(4)
    expect(v.kind).toBe('hit')
  })
})

describe('perAxis', () => {
  /** Та же поза с разведёнными ногами: промах ровно по оси `legs`. */
  const WIDE: Partial<StickDesc> = { ...RIGHT, legs: 'wide' }
  /** Та же поза с согнутым левым локтем: промах ровно по оси `leftElbow`. */
  const BENT: Partial<StickDesc> = { ...RIGHT, leftElbow: 'bent', leftForearm: 'down' }

  test('фикстуры промахиваются ровно по той оси, которую портили', () => {
    expect(missed(judge(inWindow(times(4, WIDE))))).toEqual(['legs'])
    expect(missed(judge(inWindow(times(4, BENT))))).toEqual(['leftElbow'])
  })

  test('агрегирует самую частую промахнувшуюся ось', () => {
    const v = judge(inWindow([...times(4, WIDE), ...times(2, BENT), ...times(1, RIGHT)]))

    expect(v.kind).toBe('miss')
    expect(v.perAxis.axes.legs!.counts).toEqual({ ok: 3, miss: 4, unmeasured: 0, excused: 0 })
    expect(v.perAxis.axes.leftElbow!.counts).toEqual({
      ok: 5,
      miss: 2,
      unmeasured: 0,
      excused: 0,
    })
    expect(v.perAxis.worst).toEqual({ axis: 'legs', frames: 4 })
  })

  test('несёт требуемое и измеренное значение промахнувшейся оси', () => {
    const v = judge(inWindow(times(5, WIDE)))
    const legs = v.perAxis.axes.legs!

    expect(legs.want).toBe('together')
    expect(legs.outcome).toBe('miss')
    expect(legs.sample.got).toBe('wide')
    expect(Number.isFinite(legs.sample.measured)).toBe(true)
    expect(legs.sample.measuredBy).toBe('ankle')
  })

  test('оси, которых поза не требует, в приговор не попадают', () => {
    const v = judge(inWindow(times(5, RIGHT)))
    const judged = Object.keys(v.perAxis.axes).sort()

    expect(judged).toEqual(
      [
        'crouch',
        'knees',
        'leftElbow',
        'leftShoulder',
        'legs',
        'lean',
        'rightElbow',
        'rightShoulder',
        'support',
      ].sort(),
    )
    expect(v.perAxis.worst).toBeNull()
  })

  test('«не смогли измерить» отличимо от «сделал не то»', () => {
    // Пропавшая кисть делает локоть «не знаю»: кадр не совпал, но взрослый
    // обязан видеть, что это не промах ребёнка.
    const blind: Partial<StickDesc> = { ...RIGHT, visibilityOf: { leftWrist: 0.2 } }
    const v = judge(inWindow([...times(3, blind), ...times(4, RIGHT)]))
    const elbow = v.perAxis.axes.leftElbow!

    expect(elbow.counts).toEqual({ ok: 4, miss: 0, unmeasured: 3, excused: 0 })
    expect(elbow.outcome).toBe('unmeasured')
    expect(Number.isNaN(elbow.sample.measured)).toBe(true)
    expect(v.matched).toBe(4)
    expect(v.kind).toBe('miss')
    expect(missed(v)).toEqual([])
  })
})
