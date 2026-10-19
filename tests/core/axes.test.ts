import { describe, expect, test } from 'vitest'
import { AXES, axes, type Axis, type AxisReadings } from '../../src/core/axes'
import { CONFIG, strictness } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { LANDMARK_STRIDE, LM } from '../../src/core/landmarks'
import type { Calibration, Landmarks } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

const ASPECT = 16 / 9
type Desc = Partial<StickDesc>

const frame = (desc: Desc): Landmarks => stick({ aspect: ASPECT, ...desc })

/** Калибровка из нейтральной стойки: ею судятся просадки приседа. */
function calibrate(desc: Desc = {}): Calibration {
  const g = geometry(frame(desc), ASPECT)!
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
const SOFT = strictness('soft')
const STRICT = strictness('strict')

const readFrame = (lm: Landmarks, strict = 1, cal = CAL): AxisReadings =>
  axes(lm, geometry(lm, ASPECT)!, cal, strict)
const read = (desc: Desc, strict = 1, cal = CAL): AxisReadings => readFrame(frame(desc), strict, cal)

/** Высоты стоп наоборот: колени говорят одно, стопы — другое. */
function swapAnkleHeights(lm: Landmarks): Landmarks {
  const out = Float32Array.from(lm)
  const a = LM.leftAnkle * LANDMARK_STRIDE + 1
  const b = LM.rightAnkle * LANDMARK_STRIDE + 1
  const keep = out[a]
  out[a] = out[b]
  out[b] = keep
  return out
}

const FEET_GONE: Desc['visibilityOf'] = {
  leftAnkle: 0,
  rightAnkle: 0,
  leftHeel: 0,
  rightHeel: 0,
  leftFootIndex: 0,
  rightFootIndex: 0,
}

// Кадры, на которых стоят тесты. Те же кадры сторож полноты прогоняет по всем
// осям из AXES — поэтому они собраны здесь, а не разбросаны по тестам.
const ROBOT: Desc = {
  legs: 'shoulder',
  leftShoulder: 'side',
  rightShoulder: 'side',
  leftElbow: 'bent',
  rightElbow: 'bent',
  leftForearm: 'up',
  rightForearm: 'down',
}
const BOXER: Desc = {
  legs: 'shoulder',
  leftShoulder: 'front',
  rightShoulder: 'front',
  leftElbow: 'bent',
  rightElbow: 'bent',
  leftForearm: 'up',
  rightForearm: 'up',
}
const ROCKET: Desc = { leftShoulder: 'up', rightShoulder: 'up', hands: 'over-head' }
const BARRIER: Desc = {
  leftElbow: 'bent',
  rightElbow: 'bent',
  leftForearm: 'in',
  rightForearm: 'in',
  hands: 'in-front',
}
/**
 * «Низкий барьер»: глубокий присед, ноги широко, стопы ушли из кадра. Ровно тот
 * кадр, на котором ось ног обязана считаться по коленям: уход стоп в приседе —
 * норма, а не отказ.
 */
const BARRIER_DEEP: Desc = { ...BARRIER, legs: 'wide', crouch: 'yes', visibilityOf: FEET_GONE }
const FLAMINGO: Desc = { support: 'left', visibilityOf: FEET_GONE }
const FOUR: Desc = { support: 'left', footAtKnee: true }
const EGYPT: Desc = { orientation: 'profile', nearShoulder: 'up', farShoulder: 'down' }
const EGYPT_MIRROR: Desc = { ...EGYPT, facing: 'left' }
const ARROW: Desc = {
  orientation: 'profile',
  lean: 'horizontal',
  nearShoulder: 'front',
  farShoulder: 'front',
}

const NEUTRAL_G = geometry(frame({}), ASPECT)!
const SANK_G = geometry(frame({ crouch: 75 }), ASPECT)!
/** Насколько присед сам опускает бёдра в кадре — ровно столько и вернуть наверх. */
const SELF_DROP = (SANK_G.hipMid.y - NEUTRAL_G.hipMid.y) / SANK_G.S
/** Присед ровно с одним голосом: колено согнуто, плечи и бёдра на месте. */
const ONE_VOTE: Desc = { crouch: 75, bodyDrop: -SELF_DROP }
/** Подошедший к камере: торс вырос, плечи и бёдра в кадре опустились. */
const CLOSER: Desc = { torso: 0.33, bodyDrop: 1.3 }
const CAL_CLOSE = calibrate({ torso: 0.33 })

test('по каждой оси возвращается и состояние, и измеренное значение', () => {
  const r = read({ leftShoulder: 58 })
  // Ровно это и уходит в `perAxis` журнала: «левое плечо 58° при цели 90±30».
  expect(r.leftShoulder.measured).toBeCloseTo(58, 1)
  expect(r.leftShoulder.state).toBe('diag-up')
  for (const axis of AXES) {
    expect(typeof r[axis].measured).toBe('number')
    expect(r[axis].state).toBeDefined()
  }
})

test('AXES — канонический список осей, по нему и собраны показания', () => {
  expect(new Set(AXES).size).toBe(AXES.length)
  expect([...Object.keys(read({}))].sort()).toEqual([...AXES].sort())
})

describe('плечо', () => {
  test('up/diag-up/side/down по углу от вертикали', () => {
    expect(read({ leftShoulder: 0 }).leftShoulder.state).toBe('up')
    expect(read({ leftShoulder: 45 }).leftShoulder.state).toBe('diag-up')
    expect(read({ leftShoulder: 90 }).leftShoulder.state).toBe('side')
    expect(read({ leftShoulder: 180 }).leftShoulder.state).toBe('down')
    // Тот же угол на другой руке даёт то же состояние: угол растёт наружу.
    expect(read({ rightShoulder: 90 }).rightShoulder.state).toBe('side')
    expect(read({ rightShoulder: 45 }).rightShoulder.state).toBe('diag-up')
  })

  test('угол между состояниями даёт unknown', () => {
    expect(read({ leftShoulder: 65 }).leftShoulder.state).toBe('unknown')
    expect(read({ leftShoulder: 65 }).leftShoulder.measured).toBeCloseTo(65, 1)
  })

  test('front — рука на камеру: проекция вырождается у средней линии корпуса', () => {
    expect(read(BOXER).leftShoulder.state).toBe('front')
    expect(read(BOXER).rightShoulder.state).toBe('front')
    // Поднятая рука с кистями вместе к средней линии тоже близка, но она
    // читается по углу и `front` не становится.
    expect(read(ROCKET).leftShoulder.state).toBe('up')
  })
})

describe('локоть и предплечье', () => {
  test('локоть straight > 150°, bent 70–115°, между — unknown', () => {
    expect(read({ leftElbow: 'straight' }).leftElbow.state).toBe('straight')
    expect(read({ leftElbow: 160 }).leftElbow.state).toBe('straight')
    expect(read({ leftElbow: 'bent' }).leftElbow.state).toBe('bent')
    expect(read({ leftElbow: 130 }).leftElbow.state).toBe('unknown')
    expect(read({ leftElbow: 130 }).leftElbow.measured).toBeCloseTo(130, 1)
  })

  test('предплечье различает up и down при bent локте', () => {
    const r = read(ROBOT)
    expect(r.leftElbow.state).toBe('bent')
    expect(r.rightElbow.state).toBe('bent')
    expect(r.leftForearm.state).toBe('up')
    expect(r.rightForearm.state).toBe('down')
  })

  test('предплечье in у «Низкого барьера», и между состояниями — unknown', () => {
    expect(read(BARRIER).leftForearm.state).toBe('in')
    // 90° — «в сторону»: у предплечья такого состояния нет.
    expect(read({ leftElbow: 'bent', leftForearm: 90 }).leftForearm.state).toBe('unknown')
  })
})

describe('кисти', () => {
  test('over-head: расстояние < 0.4 S и обе выше головы', () => {
    const r = read(ROCKET)
    expect(r.hands.state).toBe('over-head')
    expect(r.hands.measured).toBeLessThan(CONFIG.hands.overHead)
    // Те же поднятые руки, но кисти разведены — уже не «вместе».
    expect(read({ ...ROCKET, handGap: 0.6 }).hands.state).toBe('no')
    // Кисти вместе, но на высоте груди — это не over-head.
    expect(read(BARRIER).hands.state).toBe('in-front')
  })
})

describe('ноги и опора', () => {
  test('together/shoulder/wide/max по разносу стоп', () => {
    expect(read({ legs: 0.2 }).legs.state).toBe('together')
    expect(read({ legs: 0.6 }).legs.state).toBe('shoulder')
    expect(read({ legs: 1.0 }).legs.state).toBe('wide')
    expect(read({ legs: 1.6 }).legs.state).toBe('max')
    expect(read({ legs: 1.0 }).legs.measured).toBeCloseTo(1.0, 2)
  })

  test('разнос между полосами даёт unknown', () => {
    expect(read({ legs: 0.4 }).legs.state).toBe('unknown')
    expect(read({ legs: 0.8 }).legs.state).toBe('unknown')
    expect(read({ legs: 1.35 }).legs.state).toBe('unknown')
  })

  test('присед со стопами вне кадра судится по КОЛЕНЯМ, а не отказом', () => {
    // «Низкий барьер» требует одновременно присед `yes` и ноги `wide`, а в
    // приседе стопы уходят из кадра. Отказ по оси ног сорвал бы раунд не по
    // вине ребёнка — худший класс дефекта в этой игре.
    const r = read(BARRIER_DEEP)
    expect(r.crouch.state).toBe('yes')
    expect(r.legs.state).toBe('wide')
    // Взрослый, читающий «ноги 2.0» в журнале, обязан знать, что это колени.
    expect(r.legs.measuredBy).toBe('knee')
    expect(r.legs.measured).toBeGreaterThan(CONFIG.legs.knee.wideMin)
    expect(r.legs.measured).toBeLessThan(CONFIG.legs.knee.wideMax)
  })

  test('видимые стопы остаются главным источником', () => {
    const r = read({ legs: 1.0 })
    expect(r.legs.state).toBe('wide')
    expect(r.legs.measuredBy).toBe('ankle')
    expect(r.legs.measured).toBeCloseTo(1.0, 2)
  })

  test('по коленям те же четыре состояния', () => {
    const byKnees = (spread: number): Desc => ({
      legs: spread,
      crouch: 'yes',
      visibilityOf: FEET_GONE,
    })
    expect(read(byKnees(0.2)).legs.state).toBe('together')
    expect(read(byKnees(0.6)).legs.state).toBe('shoulder')
    expect(read(byKnees(1.075)).legs.state).toBe('wide')
    expect(read(byKnees(1.6)).legs.state).toBe('max')
    // Зазоры между полосами остаются зазорами и здесь.
    expect(read(byKnees(0.4)).legs.state).toBe('unknown')
    expect(read(byKnees(0.8)).legs.state).toBe('unknown')
  })

  test('прямые ноги со стопами вне кадра — «не знаю», а не «вместе»', () => {
    // Полоса `together` по коленям закрыта снизу именно ради этого кадра:
    // иначе широко стоящий ребёнок без стоп в кадре получил бы `together`, то
    // есть промах не по своей вине.
    const r = read({ legs: 'wide', visibilityOf: FEET_GONE })
    expect(r.legs.state).toBe('unknown')
    expect(r.legs.measuredBy).toBe('knee')
    expect(r.legs.measured).toBeLessThan(CONFIG.legs.knee.togetherMin)
  })

  test('ни стоп, ни колен — ось «не знаю»', () => {
    const r = read({
      legs: 'wide',
      crouch: 'yes',
      visibilityOf: { ...FEET_GONE, leftKnee: 0, rightKnee: 0 },
    })
    expect(r.legs.state).toBe('unknown')
    expect(r.legs.measuredBy).toBeUndefined()
  })

  test('опора считается по коленям, а не по стопам', () => {
    // «Фламинго» со стопами вне кадра — опора определена.
    const r = read(FLAMINGO)
    expect(r.support.state).toBe('left')
    expect(r.legs.state).toBe('unknown')
    expect(read({}).support.state).toBe('both')
    expect(read({ support: 'right' }).support.state).toBe('right')
  })

  test('стопы — подтверждение: противоречие им даёт unknown', () => {
    const lm = frame({ support: 'left' })
    expect(readFrame(lm).support.state).toBe('left')
    expect(readFrame(swapAnkleHeights(lm)).support.state).toBe('unknown')
  })

  test('стопа у колена опорной ноги («Цифра 4»)', () => {
    expect(read(FOUR).footAtKnee.state).toBe(true)
    expect(read(FOUR).footAtKnee.measured).toBeLessThan(CONFIG.footAtKnee.distance)
    expect(read({ support: 'left', footToKnee: 0.7 }).footAtKnee.state).toBe(false)
    // Обе ноги на полу — стопе не у чего стоять.
    expect(read({}).footAtKnee.state).toBe(false)
  })
})

describe('корпус', () => {
  test('наклон: > 20° — lean, > 60° — horizontal', () => {
    expect(read({}).lean.state).toBe('upright')
    expect(read({ lean: 'lean-left' }).lean.state).toBe('lean-left')
    expect(read({ lean: 'lean-right' }).lean.state).toBe('lean-right')
    expect(read({ lean: 'horizontal' }).lean.state).toBe('horizontal')
    expect(read({ lean: 'lean-left' }).lean.measured).toBeGreaterThan(CONFIG.lean.tolerance)
  })

  test('в профиль боковой наклон не выражается и даёт unknown', () => {
    // Наклон влево-вправо в профиль направлен на камеру: 40° в кадре —
    // это наклон вперёд, и ни одно состояние его не описывает.
    expect(read({ orientation: 'profile', lean: 40 }).lean.state).toBe('unknown')
    expect(read(ARROW).lean.state).toBe('horizontal')
  })

  test('колени straight > 150°, bent < 140°, полоса 140–150 — unknown', () => {
    expect(read({ knees: 'straight' }).knees.state).toBe('straight')
    expect(read({ knees: 120 }).knees.state).toBe('bent')
    expect(read({ knees: 145 }).knees.state).toBe('unknown')
    expect(read({ knees: 145 }).knees.measured).toBeCloseTo(145, 0)
  })
})

describe('присед', () => {
  test('голосование 2 из 3', () => {
    const deep = read({ crouch: 'yes' })
    expect(deep.crouch.state).toBe('yes')
    expect(deep.crouch.measured).toBe(CONFIG.crouch.votesTotal)

    const one = read(ONE_VOTE)
    expect(one.crouch.measured).toBe(1)
    expect(one.crouch.state).toBe('no')
  })

  test('отвергается, если торс вырос (подход к камере)', () => {
    // Один и тот же кадр: против нейтральной стойки поменьше он «присед»
    // только по просадке плеч и бёдер — и отвергается ростом торса.
    expect(read(CLOSER, 1, CAL).crouch.measured).toBe(CONFIG.crouch.votesRequired)
    expect(read(CLOSER, 1, CAL).crouch.state).toBe('no')
    // Та же фигура против своей калибровки — честный присед.
    expect(read(CLOSER, 1, CAL_CLOSE).crouch.state).toBe('yes')
  })

  test('недоступный голос колена даёт unknown, а не «нет»', () => {
    // Корпус сложен, стопы вне кадра: один голос есть, третий посчитать
    // нечем — и он бы решил исход.
    const r = read({ lean: 'horizontal', visibilityOf: FEET_GONE })
    expect(r.crouch.measured).toBe(1)
    expect(r.crouch.state).toBe('unknown')
  })
})

describe('ориентация', () => {
  test('front > 0.70, profile < 0.45, между — unknown', () => {
    expect(read({}).orientation.state).toBe('front')
    expect(read({ orientation: 'profile' }).orientation.state).toBe('profile')
    const between = read({ profileLateral: 0.65 })
    expect(between.orientation.state).toBe('unknown')
    expect(between.orientation.measured).toBeGreaterThan(CONFIG.orientation.profile)
    expect(between.orientation.measured).toBeLessThan(CONFIG.orientation.front)
  })

  test('в профиль ближняя и дальняя сторона разрешаются по направлению взгляда', () => {
    const right = read(EGYPT)
    expect(right.nearShoulder.state).toBe('up')
    expect(right.farShoulder.state).toBe('down')
    // Взгляд в `+x` — к камере обращён правый бок игрока.
    expect(right.rightShoulder.state).toBe('up')
    expect(right.leftShoulder.state).toBe('down')

    // Зеркальный поворот не меняет ближнюю и дальнюю, а левое с правым меняет.
    const left = read(EGYPT_MIRROR)
    expect(left.nearShoulder.state).toBe('up')
    expect(left.farShoulder.state).toBe('down')
    expect(left.leftShoulder.state).toBe('up')
    expect(left.rightShoulder.state).toBe('down')
  })

  test('во фронтальном кадре ближней и дальней стороны нет', () => {
    const r = read(ROBOT)
    expect(r.nearShoulder.state).toBe('unknown')
    expect(r.farShoulder.state).toBe('unknown')
    expect(r.nearElbow.state).toBe('unknown')
    expect(r.farForearm.state).toBe('unknown')
  })

  test('в профиль «в сторону» читается как front — рука по линии взгляда', () => {
    expect(read(ARROW).nearShoulder.state).toBe('front')
    expect(read(ARROW).farShoulder.state).toBe('front')
  })

  test('в профиль углы обеих рук отсчитываются в сторону взгляда', () => {
    // Один и тот же угол на ближней и дальней руке обязан дать одно
    // состояние: иначе дальняя читалась бы зеркально и промахивалась.
    for (const facing of ['left', 'right'] as const) {
      const r = read({ orientation: 'profile', facing, nearShoulder: 45, farShoulder: 45 })
      expect(r.nearShoulder.state).toBe('diag-up')
      expect(r.farShoulder.state).toBe('diag-up')
    }
  })
})

describe('«не знаю» по уверенности точки', () => {
  test('точка с низкой visibility даёт unknown по своей оси', () => {
    const r = read({ visibilityOf: { leftElbow: 0.2 } })
    expect(r.leftShoulder.state).toBe('unknown')
    expect(r.leftElbow.state).toBe('unknown')
    // Соседняя рука цела — ось берёт только свои точки.
    expect(r.rightShoulder.state).toBe('down')
  })

  test('NaN в уверенности кисти не роняет ось и не читается как промах', () => {
    const r = read({ visibilityOf: { leftWrist: Number.NaN } })
    expect(r.leftElbow.state).toBe('unknown')
    expect(r.leftForearm.state).toBe('unknown')
    expect(r.hands.state).toBe('unknown')
    // Плечо считается по плечу и локтю — его NaN в кисти не трогает.
    expect(r.leftShoulder.state).toBe('down')
  })

  test('без головы over-head отличить нельзя', () => {
    const r = read({ ...ROCKET, visibilityOf: { nose: 0, leftEye: 0, rightEye: 0 } })
    expect(r.hands.state).toBe('unknown')
  })

  test('в профиль без носа не разрешить ближнюю сторону', () => {
    const r = read({ ...EGYPT, visibilityOf: { nose: 0 } })
    expect(r.nearShoulder.state).toBe('unknown')
    expect(r.leftShoulder.state).toBe('unknown')
  })
})

describe('строгость', () => {
  test('масштабирует угловые допуски', () => {
    // 115° — в 25° от `side`: при мягком и обычном допуске попадание,
    // при строгом (22.5°) — уже «не знаю».
    expect(read({ leftShoulder: 115 }, SOFT).leftShoulder.state).toBe('side')
    expect(read({ leftShoulder: 115 }, 1).leftShoulder.state).toBe('side')
    expect(read({ leftShoulder: 115 }, STRICT).leftShoulder.state).toBe('unknown')
    // Колено 155°: мягко и обычно — `straight`, строго требует 157.5°.
    expect(read({ knees: 155 }, SOFT).knees.state).toBe('straight')
    expect(read({ knees: 155 }, 1).knees.state).toBe('straight')
    expect(read({ knees: 155 }, STRICT).knees.state).toBe('unknown')
  })

  test('мягкий допуск, налезший на соседнее состояние, даёт «не знаю»', () => {
    // 63° — уже `horizontal` (> 60°), но мягкая полоса наклона (±26° вокруг
    // 40°) достаёт и до него: различить их на этом кадре нечем.
    expect(read({ lean: 63 }, 1).lean.state).toBe('horizontal')
    expect(read({ lean: 63 }, SOFT).lean.state).toBe('unknown')
  })

  test('масштабирует допуски по расстоянию', () => {
    const wide: Desc = { ...ROCKET, handGap: 0.45 }
    expect(read(wide, SOFT).hands.state).toBe('over-head')
    expect(read(wide, 1).hands.state).toBe('no')
  })
})

test('каждая ось из AXES хоть где-то определена и хоть где-то «не знаю»', () => {
  // Сторож выводит полноту из самого списка осей: забытая в показаниях ось
  // здесь и всплывёт. Таблица в этом же файле такого не поймала бы.
  const descs: Desc[] = [
    {},
      ROBOT,
      BOXER,
      ROCKET,
      BARRIER,
      BARRIER_DEEP,
      FLAMINGO,
      FOUR,
      EGYPT,
      EGYPT_MIRROR,
      ARROW,
    ONE_VOTE,
    { crouch: 'yes' },
    { legs: 0.4 },
    { knees: 145 },
    { leftShoulder: 65 },
    { leftElbow: 130 },
    { leftElbow: 'bent', leftForearm: 90 },
    { profileLateral: 0.65 },
    { orientation: 'profile', lean: 40 },
    { lean: 'horizontal', visibilityOf: FEET_GONE },
    { ...ROCKET, visibilityOf: { nose: 0, leftEye: 0, rightEye: 0 } },
    { visibilityOf: { leftWrist: Number.NaN } },
    { visibilityOf: { rightWrist: Number.NaN } },
    { ...EGYPT, visibilityOf: { nose: 0 } },
  ]

  const cases: Array<{ lm: Landmarks; strict?: number; cal?: Calibration }> = [
    ...descs.map((desc) => ({ lm: frame(desc) })),
    { lm: swapAnkleHeights(frame({ support: 'left' })) },
    { lm: swapAnkleHeights(frame({ support: 'left', footAtKnee: true })) },
    { lm: frame(CLOSER), cal: CAL },
  ]

  const determined = new Set<Axis>()
  const unknown = new Set<Axis>()
  for (const c of cases) {
    const r = readFrame(c.lm, c.strict ?? 1, c.cal ?? CAL)
    for (const axis of AXES) {
      ;(r[axis].state === 'unknown' ? unknown : determined).add(axis)
    }
  }

  expect(AXES.filter((axis) => !determined.has(axis))).toEqual([])
  expect(AXES.filter((axis) => !unknown.has(axis))).toEqual([])
})
