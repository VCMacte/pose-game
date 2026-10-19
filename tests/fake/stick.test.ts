import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { LANDMARK_COUNT, LM, pointAt } from '../../src/core/landmarks'
import type { ForearmState, Landmarks, Pt, ShoulderState } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

const ASPECT = 16 / 9
const DEG = 180 / Math.PI

/**
 * Читалка скелета в тех же единицах, в которых судит ядро: доли длины торса,
 * `x` приведён к единицам `y`, отсчёт от середины бёдер.
 */
function reader(lm: Landmarks, aspect = ASPECT): (i: number) => Pt {
  const g = geometry(lm, aspect)
  if (g === null) throw new Error('геометрия не посчиталась')
  return (i: number): Pt => {
    const p = pointAt(lm, i)
    return { x: (p.x * aspect - g.hipMid.x) / g.S, y: (p.y - g.hipMid.y) / g.S }
  }
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Угол вектора `a→b` от вертикали: 0° — вверх, 90° — в сторону `sign`, 180° — вниз. */
const limbAngle = (a: Pt, b: Pt, sign: number): number =>
  Math.atan2((b.x - a.x) * sign, -(b.y - a.y)) * DEG

/**
 * Отклонение угла от опорного, с учётом того, что 180° и −180° — одно и то же.
 * Без приведения по кругу «плечо down» читается как промах на 360°.
 */
const deviation = (angle: number, ref: number): number => Math.abs(((angle - ref + 540) % 360) - 180)

/** Угол в точке `b` между `a` и `c` — тот самый «угол плечо–локоть–кисть». */
function jointAngle(a: Pt, b: Pt, c: Pt): number {
  const u = { x: a.x - b.x, y: a.y - b.y }
  const v = { x: c.x - b.x, y: c.y - b.y }
  const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG
}

/** Отклонение точки от средней линии корпуса (бёдра→плечи), в долях торса. */
function offMidline(lm: Landmarks, i: number): number {
  const at = reader(lm)
  const top = at(LM.leftShoulder)
  const bottom = at(LM.rightShoulder)
  const mid = { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 }
  const dir = { x: mid.x / Math.hypot(mid.x, mid.y), y: mid.y / Math.hypot(mid.x, mid.y) }
  const p = at(i)
  return Math.abs(p.x * dir.y - p.y * dir.x)
}

test('скелет заполнен целиком и укладывается в кадр', () => {
  for (const desc of [{}, { legs: 'max' as const }, { lean: 'horizontal' as const }]) {
    const lm = stick(desc)
    expect(lm.length).toBe(LANDMARK_COUNT * 4)
    for (let i = 0; i < LANDMARK_COUNT; i += 1) {
      const p = pointAt(lm, i)
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(1)
      expect(p.y).toBeGreaterThan(0)
      expect(p.y).toBeLessThan(1)
      expect(p.visibility).toBe(1)
    }
  }
})

test('по умолчанию — стоять прямо, руки вниз, ноги вместе', () => {
  const lm = stick({})
  const at = reader(lm)
  const g = geometry(lm, ASPECT)!
  expect(limbAngle(at(LM.leftShoulder), at(LM.leftElbow), 1)).toBeCloseTo(180, 6)
  expect(jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))).toBeCloseTo(180, 6)
  expect(Math.abs(at(LM.leftAnkle).x - at(LM.rightAnkle).x)).toBeLessThan(CONFIG.legs.together)
  expect(limbAngle(g.hipMid, g.shoulderMid, 1)).toBeCloseTo(0, 6)
})

describe('состояния осей попадают в полосы CONFIG, а не на их границы', () => {
  const shoulders: Array<[ShoulderState, number]> = [
    ['up', 0],
    ['diag-up', 45],
    ['side', 90],
    ['down', 180],
  ]

  test.each(shoulders)('плечо %s — угол от вертикали около %i°', (state, ref) => {
    const at = reader(stick({ leftShoulder: state, rightShoulder: state }))
    const left = limbAngle(at(LM.leftShoulder), at(LM.leftElbow), 1)
    const right = limbAngle(at(LM.rightShoulder), at(LM.rightElbow), -1)
    expect(deviation(left, ref)).toBeLessThan(CONFIG.shoulder.tolerance / 2)
    expect(deviation(right, ref)).toBeLessThan(CONFIG.shoulder.tolerance / 2)
  })

  test('плечо front — локоть и кисть у средней линии корпуса', () => {
    const lm = stick({
      leftShoulder: 'front',
      rightShoulder: 'front',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'up',
      rightForearm: 'up',
    })
    for (const i of [LM.leftElbow, LM.rightElbow, LM.leftWrist, LM.rightWrist]) {
      expect(offMidline(lm, i)).toBeLessThan(CONFIG.shoulder.front)
    }
    // Боксёр: локти при этом обязаны читаться согнутыми.
    const at = reader(lm)
    const angle = jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))
    expect(angle).toBeGreaterThan(CONFIG.elbow.bentMin)
    expect(angle).toBeLessThan(CONFIG.elbow.bentMax)
  })

  test('локоть straight — угол больше порога', () => {
    const at = reader(stick({ leftElbow: 'straight', rightElbow: 'straight' }))
    expect(jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))).toBeGreaterThan(
      CONFIG.elbow.straightMin,
    )
  })

  test('локоть bent — угол в середине полосы 70–115°', () => {
    const at = reader(stick({ leftElbow: 'bent', rightElbow: 'bent' }))
    const angle = jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))
    expect(angle).toBeGreaterThan(CONFIG.elbow.bentMin + 10)
    expect(angle).toBeLessThan(CONFIG.elbow.bentMax - 10)
  })

  const forearms: Array<[ForearmState, number, ShoulderState]> = [
    ['up', 0, 'side'],
    ['down', 180, 'side'],
    ['in', -90, 'down'],
  ]

  test.each(forearms)('предплечье %s — угол около %i° при плече %s', (state, ref, shoulder) => {
    const lm = stick({
      leftShoulder: shoulder,
      rightShoulder: shoulder,
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: state,
      rightForearm: state,
    })
    const at = reader(lm)
    expect(deviation(limbAngle(at(LM.leftElbow), at(LM.leftWrist), 1), ref)).toBeLessThan(
      CONFIG.forearm.tolerance / 2,
    )
    expect(deviation(limbAngle(at(LM.rightElbow), at(LM.rightWrist), -1), ref)).toBeLessThan(
      CONFIG.forearm.tolerance / 2,
    )
    // Предплечье судится только при согнутом локте — он обязан им и остаться.
    const angle = jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))
    expect(angle).toBeGreaterThan(CONFIG.elbow.bentMin)
    expect(angle).toBeLessThan(CONFIG.elbow.bentMax)
  })

  test('ноги together / shoulder / wide / max попадают каждая в свою полосу', () => {
    const spread = (legs: 'together' | 'shoulder' | 'wide' | 'max'): number => {
      const at = reader(stick({ legs }))
      return Math.abs(at(LM.leftAnkle).x - at(LM.rightAnkle).x)
    }
    expect(spread('together')).toBeLessThan(CONFIG.legs.together)
    expect(spread('shoulder')).toBeGreaterThan(CONFIG.legs.shoulderMin)
    expect(spread('shoulder')).toBeLessThan(CONFIG.legs.shoulderMax)
    expect(spread('wide')).toBeGreaterThan(CONFIG.legs.wideMin)
    expect(spread('wide')).toBeLessThan(CONFIG.legs.wideMax)
    expect(spread('max')).toBeGreaterThan(CONFIG.legs.max)
  })

  test('опора на одной ноге — разница высот колен больше порога', () => {
    const both = reader(stick({ support: 'both' }))
    expect(Math.abs(both(LM.leftKnee).y - both(LM.rightKnee).y)).toBeLessThan(
      CONFIG.support.kneeHeightDiff,
    )

    const onLeft = reader(stick({ support: 'left' }))
    expect(onLeft(LM.leftKnee).y - onLeft(LM.rightKnee).y).toBeGreaterThan(
      CONFIG.support.kneeHeightDiff,
    )

    const onRight = reader(stick({ support: 'right' }))
    expect(onRight(LM.rightKnee).y - onRight(LM.leftKnee).y).toBeGreaterThan(
      CONFIG.support.kneeHeightDiff,
    )
  })

  test('стопа у колена опорной ноги — и её отсутствие тоже выразимы', () => {
    const near = reader(stick({ support: 'left', footAtKnee: true }))
    expect(dist(near(LM.rightAnkle), near(LM.leftKnee))).toBeLessThan(CONFIG.footAtKnee.distance)

    const far = reader(stick({ support: 'left', footAtKnee: false }))
    expect(dist(far(LM.rightAnkle), far(LM.leftKnee))).toBeGreaterThan(CONFIG.footAtKnee.distance)
    // Опора при этом обязана читаться по-прежнему.
    expect(far(LM.leftKnee).y - far(LM.rightKnee).y).toBeGreaterThan(CONFIG.support.kneeHeightDiff)
  })

  test('наклон корпуса upright / lean-left / lean-right / horizontal', () => {
    const lean = (desc: Parameters<typeof stick>[0]): number => {
      const g = geometry(stick(desc), ASPECT)!
      return limbAngle(g.hipMid, g.shoulderMid, 1)
    }
    expect(Math.abs(lean({}))).toBeLessThan(CONFIG.lean.tolerance)
    expect(lean({ lean: 'lean-left' })).toBeGreaterThan(CONFIG.lean.tolerance)
    expect(lean({ lean: 'lean-left' })).toBeLessThan(CONFIG.lean.horizontal)
    expect(lean({ lean: 'lean-right' })).toBeLessThan(-CONFIG.lean.tolerance)
    expect(lean({ lean: 'lean-right' })).toBeGreaterThan(-CONFIG.lean.horizontal)
    expect(Math.abs(lean({ lean: 'horizontal' }))).toBeGreaterThan(CONFIG.lean.horizontal)
  })

  test('присед опускает плечи и бёдра в кадре и не увеличивает торс', () => {
    const up = geometry(stick({ crouch: 'no' }), ASPECT)!
    const down = geometry(stick({ crouch: 'yes' }), ASPECT)!
    expect(down.hipMid.y).toBeGreaterThan(up.hipMid.y + 0.05)
    expect(down.shoulderMid.y).toBeGreaterThan(up.shoulderMid.y + 0.05)
    expect(down.S).toBeCloseTo(up.S, 6)
  })

  test('колени straight и bent различимы по углу в колене', () => {
    const straight = reader(stick({ knees: 'straight' }))
    expect(jointAngle(straight(LM.leftHip), straight(LM.leftKnee), straight(LM.leftAnkle))).toBeGreaterThan(
      CONFIG.elbow.straightMin,
    )
    const bent = reader(stick({ knees: 'bent' }))
    const angle = jointAngle(bent(LM.leftHip), bent(LM.leftKnee), bent(LM.leftAnkle))
    expect(angle).toBeGreaterThan(CONFIG.elbow.bentMin)
    expect(angle).toBeLessThan(CONFIG.elbow.bentMax)
  })

  test('ориентация front и profile различимы по отношению ширины плеч к торсу', () => {
    expect(geometry(stick({ orientation: 'front' }), ASPECT)!.shoulderRatio).toBeGreaterThan(
      CONFIG.orientation.front,
    )
    expect(geometry(stick({ orientation: 'profile' }), ASPECT)!.shoulderRatio).toBeLessThan(
      CONFIG.orientation.profile,
    )
  })

  test('кисти over-head — рядом и выше линии головы', () => {
    const lm = stick({ leftShoulder: 'up', rightShoulder: 'up', hands: 'over-head' })
    const at = reader(lm)
    expect(dist(at(LM.leftWrist), at(LM.rightWrist))).toBeLessThan(CONFIG.hands.overHead)
    expect(at(LM.leftWrist).y).toBeLessThan(at(LM.leftEye).y)
    expect(at(LM.rightWrist).y).toBeLessThan(at(LM.rightEye).y)
    // Космическая ракета судит ещё и прямые локти при плечах up.
    expect(jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))).toBeGreaterThan(
      CONFIG.elbow.straightMin,
    )
    expect(deviation(limbAngle(at(LM.leftShoulder), at(LM.leftElbow), 1), 0)).toBeLessThan(
      CONFIG.shoulder.tolerance,
    )
  })

  test('кисти in-front — рядом, у средней линии, на высоте груди', () => {
    const lm = stick({
      leftShoulder: 'down',
      rightShoulder: 'down',
      leftElbow: 'bent',
      rightElbow: 'bent',
      leftForearm: 'in',
      rightForearm: 'in',
      hands: 'in-front',
    })
    const at = reader(lm)
    expect(dist(at(LM.leftWrist), at(LM.rightWrist))).toBeLessThan(CONFIG.hands.inFront)
    expect(offMidline(lm, LM.leftWrist)).toBeLessThan(CONFIG.shoulder.front)
    expect(at(LM.leftWrist).y).toBeLessThan(0)
    expect(at(LM.leftWrist).y).toBeGreaterThan(-1)
  })

  test('кисти no — руки по умолчанию врозь', () => {
    const at = reader(stick({ hands: 'no' }))
    expect(dist(at(LM.leftWrist), at(LM.rightWrist))).toBeGreaterThan(CONFIG.hands.overHead)
  })
})

describe('профиль', () => {
  test('near и far разрешаются через facing', () => {
    // facing 'right' — тело смотрит в +x кадра, к камере обращён правый бок.
    const right = reader(stick({ orientation: 'profile', facing: 'right', nearShoulder: 'up' }))
    expect(right(LM.rightElbow).y).toBeLessThan(right(LM.rightShoulder).y)
    expect(right(LM.leftElbow).y).toBeGreaterThan(right(LM.leftShoulder).y)

    const left = reader(stick({ orientation: 'profile', facing: 'left', nearShoulder: 'up' }))
    expect(left(LM.leftElbow).y).toBeLessThan(left(LM.leftShoulder).y)
    expect(left(LM.rightElbow).y).toBeGreaterThan(left(LM.rightShoulder).y)
  })

  test('плечо front — рука по линии взгляда, горизонтально', () => {
    const at = reader(
      stick({ orientation: 'profile', facing: 'right', nearShoulder: 'front', farShoulder: 'front' }),
    )
    expect(deviation(limbAngle(at(LM.rightShoulder), at(LM.rightElbow), 1), 90)).toBeLessThan(
      CONFIG.shoulder.tolerance / 2,
    )
    expect(at(LM.rightWrist).x).toBeGreaterThan(at(LM.rightShoulder).x)
  })

  test('предплечье front зигзагом — Египетский рисунок', () => {
    const lm = stick({
      orientation: 'profile',
      facing: 'right',
      nearShoulder: 'down',
      farShoulder: 'down',
      nearElbow: 'bent',
      farElbow: 'bent',
      nearForearm: 'front',
      farForearm: 'front',
    })
    const at = reader(lm)
    expect(deviation(limbAngle(at(LM.rightElbow), at(LM.rightWrist), 1), 90)).toBeLessThan(
      CONFIG.forearm.tolerance / 2,
    )
    const angle = jointAngle(at(LM.rightShoulder), at(LM.rightElbow), at(LM.rightWrist))
    expect(angle).toBeGreaterThan(CONFIG.elbow.bentMin)
    expect(angle).toBeLessThan(CONFIG.elbow.bentMax)
  })

  test('боковые состояния в профиль не выражаются и падают громко', () => {
    expect(() => stick({ orientation: 'profile', nearShoulder: 'side' })).toThrow(/профил/)
    expect(() =>
      stick({ orientation: 'profile', nearElbow: 'bent', nearForearm: 'in' }),
    ).toThrow(/профил/)
    expect(() => stick({ orientation: 'profile', lean: 'lean-left' })).toThrow(/профил/)
  })
})

describe('противоречивое описание падает громко, а не врёт тихо', () => {
  test('предплечье при прямом локте', () => {
    expect(() => stick({ leftElbow: 'straight', leftForearm: 'up' })).toThrow(/локт/)
  })

  test('near и left для одной и той же стороны', () => {
    expect(() =>
      stick({ orientation: 'profile', facing: 'right', nearShoulder: 'up', rightShoulder: 'down' }),
    ).toThrow(/сторон/)
  })

  test('негодный aspect', () => {
    expect(() => stick({ aspect: 0 })).toThrow(/aspect/)
  })
})

test('visibility задаётся и целиком, и по отдельным точкам', () => {
  const lm = stick({ visibility: 0.9, visibilityOf: { leftWrist: 0.2, rightAnkle: 0 } })
  expect(pointAt(lm, LM.leftWrist).visibility).toBeCloseTo(0.2, 6)
  expect(pointAt(lm, LM.rightAnkle).visibility).toBe(0)
  expect(pointAt(lm, LM.nose).visibility).toBeCloseTo(0.9, 6)
})

test('углы задаются и числом — для промаха рядом с порогом', () => {
  const at = reader(stick({ leftShoulder: 70, leftElbow: 120 }))
  expect(limbAngle(at(LM.leftShoulder), at(LM.leftElbow), 1)).toBeCloseTo(70, 4)
  expect(jointAngle(at(LM.leftShoulder), at(LM.leftElbow), at(LM.leftWrist))).toBeCloseTo(120, 4)
})

test('разнос ног, наклон и высота колена задаются числом', () => {
  const at = reader(stick({ legs: 1.0 }))
  expect(Math.abs(at(LM.leftAnkle).x - at(LM.rightAnkle).x)).toBeCloseTo(1.0, 4)

  const g = geometry(stick({ lean: 25 }), ASPECT)!
  expect(limbAngle(g.hipMid, g.shoulderMid, 1)).toBeCloseTo(25, 4)

  const one = reader(stick({ support: 'left', raisedKnee: 0.2 }))
  expect(one(LM.leftKnee).y - one(LM.rightKnee).y).toBeCloseTo(0.2, 4)
})

test('камера видит одно и то же тело с разных дистанций', () => {
  const near = geometry(stick({ torso: 0.3 }), ASPECT)!
  const far = geometry(stick({ torso: 0.15 }), ASPECT)!
  expect(near.S).toBeCloseTo(0.3, 6)
  expect(far.S).toBeCloseTo(0.15, 6)
  // Всё, что судится, — в долях торса, и от дистанции не зависит.
  expect(far.shoulderRatio).toBeCloseTo(near.shoulderRatio, 5)
})

describe('кадр рядом с порогом собирается числом — иначе его не на чем судить', () => {
  test('недовёрнутое тело попадает в полосу «не знаю» между профилем и фронтом', () => {
    // Полоса между порогами ориентации — та, на которой судья обязан отказать
    // по присутствию, а не промахнуться: собрать её нечем, если боковое
    // смещение в профиль — константа модуля.
    const ratio = geometry(stick({ profileLateral: 0.65 }), ASPECT)!.shoulderRatio
    expect(ratio).toBeGreaterThan(CONFIG.orientation.profile)
    expect(ratio).toBeLessThan(CONFIG.orientation.front)
  })

  test('handGap ставит кисти по обе стороны порога', () => {
    const gap = (handGap: number): number => {
      const at = reader(stick({ leftShoulder: 'up', rightShoulder: 'up', hands: 'over-head', handGap }))
      return dist(at(LM.leftWrist), at(LM.rightWrist))
    }
    expect(gap(CONFIG.hands.overHead - 0.02)).toBeLessThan(CONFIG.hands.overHead)
    expect(gap(CONFIG.hands.overHead + 0.02)).toBeGreaterThan(CONFIG.hands.overHead)
  })

  test('footToKnee ставит стопу по обе стороны порога «Цифры 4»', () => {
    const toKnee = (footToKnee: number): number => {
      const at = reader(stick({ support: 'left', footToKnee }))
      return dist(at(LM.rightAnkle), at(LM.leftKnee))
    }
    expect(toKnee(CONFIG.footAtKnee.distance - 0.03)).toBeLessThan(CONFIG.footAtKnee.distance)
    expect(toKnee(CONFIG.footAtKnee.distance + 0.03)).toBeGreaterThan(CONFIG.footAtKnee.distance)
  })

  test('недостижимое расстояние стопа–колено падает громко', () => {
    expect(() => stick({ support: 'left', footToKnee: 0.1 })).toThrow(/колен/)
  })

  test('присед собирается ровно с одним голосом из трёх', () => {
    // Голосов у приседа три (угол в колене, высота бёдер, высота плеч), и
    // засчитывается он по двум. Кадр с одним голосом — согнутое колено при
    // бёдрах и плечах на прежней высоте: его собирает `crouch` числом плюс
    // `bodyDrop`, которым фигура возвращается наверх.
    const up = geometry(stick({}), ASPECT)!
    const sank = geometry(stick({ crouch: 75 }), ASPECT)!
    // Насколько присед сам опустил бёдра — ровно столько и вернуть наверх.
    const drop = (sank.hipMid.y - up.hipMid.y) / sank.S
    expect(drop).toBeGreaterThan(0.5)

    const desc = { crouch: 75, bodyDrop: -drop } as const
    const one = geometry(stick(desc), ASPECT)!
    const at = reader(stick(desc))

    const knee = jointAngle(at(LM.leftHip), at(LM.leftKnee), at(LM.leftAnkle))
    expect(knee).toBeGreaterThan(CONFIG.elbow.bentMin)
    expect(knee).toBeLessThan(CONFIG.elbow.bentMax)
    expect(Math.abs(one.hipMid.y - up.hipMid.y)).toBeLessThan(0.01 * one.S)
    expect(Math.abs(one.shoulderMid.y - up.shoulderMid.y)).toBeLessThan(0.01 * one.S)
    // Торс при этом не вырос — подошедшим к камере такой кадр не притворяется.
    expect(one.S).toBeCloseTo(up.S, 6)
  })
})

describe('по каждой требуемой оси выразим промах ровно по ней — это и нужно задаче 7', () => {
  /**
   * Какими полями описания задаётся каждая ось. Промах по оси обязан менять
   * только их: «не равно правильной позе» проверкой НЕ является — его
   * удовлетворяет любая правка любого поля.
   */
  const AXIS_KEYS: Record<string, ReadonlyArray<keyof StickDesc>> = {
    orientation: ['orientation', 'facing', 'profileLateral'],
    shoulder: ['leftShoulder', 'rightShoulder', 'nearShoulder', 'farShoulder'],
    elbow: ['leftElbow', 'rightElbow', 'nearElbow', 'farElbow'],
    forearm: ['leftForearm', 'rightForearm', 'nearForearm', 'farForearm'],
    hands: ['hands', 'handGap'],
    legs: ['legs'],
    support: ['support', 'raisedKnee'],
    lean: ['lean'],
    crouch: ['crouch', 'bodyDrop'],
    knees: ['knees'],
    footAtKnee: ['footAtKnee', 'footToKnee'],
  }

  /** Рок-звезда: ноги wide, одно плечо up локоть straight, другое down локоть bent. */
  const ROCK: Partial<StickDesc> = {
    legs: 'wide',
    leftShoulder: 'up',
    rightShoulder: 'down',
    rightElbow: 'bent',
    rightForearm: 'up',
  }

  /**
   * У каждой оси своя правильная поза: промах выходит одноосевым только
   * тогда, когда предпосылка оси в позе уже выполнена. Кисти требуют руки,
   * способной их свести, «Цифра 4» — опоры на одной ноге, а локоть — руки,
   * у которой предплечье не задано (при прямом локте его судить не на чем,
   * и описание с ним падает).
   */
  const cases: Array<{ axis: string; base: Partial<StickDesc>; miss: Partial<StickDesc> }> = [
    // Боковых состояний в рок-звезде нет, поэтому её хватает повернуть целиком.
    { axis: 'orientation', base: ROCK, miss: { orientation: 'profile' } },
    { axis: 'shoulder', base: ROCK, miss: { leftShoulder: 'side' } },
    {
      axis: 'elbow',
      base: { legs: 'wide', leftShoulder: 'up', rightShoulder: 'down', rightElbow: 'bent' },
      miss: { rightElbow: 'straight' },
    },
    { axis: 'forearm', base: ROCK, miss: { rightForearm: 'down' } },
    {
      axis: 'hands',
      base: {
        legs: 'wide',
        leftShoulder: 'down',
        rightShoulder: 'down',
        leftElbow: 'bent',
        rightElbow: 'bent',
        leftForearm: 'in',
        rightForearm: 'in',
        hands: 'no',
      },
      miss: { hands: 'in-front' },
    },
    { axis: 'legs', base: ROCK, miss: { legs: 'together' } },
    { axis: 'support', base: ROCK, miss: { support: 'left' } },
    { axis: 'lean', base: ROCK, miss: { lean: 'lean-left' } },
    { axis: 'crouch', base: ROCK, miss: { crouch: 'yes' } },
    { axis: 'knees', base: ROCK, miss: { knees: 'bent' } },
    {
      axis: 'footAtKnee',
      base: { ...ROCK, support: 'left', footAtKnee: false },
      miss: { footAtKnee: true },
    },
  ]

  test.each(cases.map((c) => [c.axis, c] as const))('ось %s', (axis, c) => {
    const wrong = { ...c.base, ...c.miss }
    const keys = new Set<string>([...Object.keys(c.base), ...Object.keys(wrong)])
    const changed = [...keys].filter(
      (k) => wrong[k as keyof StickDesc] !== c.base[k as keyof StickDesc],
    )

    // Промах есть, и он задан ровно полями своей оси — ни одного чужого поля.
    expect(changed.length, axis).toBeGreaterThan(0)
    expect(changed.sort(), axis).toEqual(
      changed.filter((k) => AXIS_KEYS[axis].includes(k as keyof StickDesc)).sort(),
    )
    // И он виден в кадре: оба описания строятся, а скелеты различны.
    expect(stick(wrong), axis).not.toEqual(stick(c.base))
  })

  test('перечислены все оси, по которым судят позы', () => {
    expect(cases.map((c) => c.axis).sort()).toEqual(Object.keys(AXIS_KEYS).sort())
  })
})
