import { expect, test } from 'vitest'
import { geometry } from '../../src/core/geometry'
import { LANDMARK_COUNT, LANDMARK_STRIDE, LM } from '../../src/core/landmarks'
import { stick } from '../../src/fake/stick'

const ASPECT = 16 / 9

test('S — длина торса в единицах y, cx — центр четырёх опорных точек', () => {
  const g = geometry(stick({ torso: 0.25, x: 0.4, aspect: ASPECT }), ASPECT)
  expect(g).not.toBeNull()
  expect(g!.S).toBeCloseTo(0.25, 6)
  expect(g!.cx).toBeCloseTo(0.4, 6)
  expect(g!.cxh).toBeCloseTo(0.4 * ASPECT, 6)
  expect(g!.hipMid.x).toBeCloseTo(0.4 * ASPECT, 6)
  expect(g!.shoulderMid.x).toBeCloseTo(0.4 * ASPECT, 6)
  expect(g!.hipMid.y - g!.shoulderMid.y).toBeCloseTo(0.25, 6)
  expect(g!.ok).toBe(true)
})

test('машущие руки не сдвигают cx — центр считается по плечам и бёдрам', () => {
  const still = geometry(stick({}), ASPECT)!
  const waving = geometry(stick({ leftShoulder: 'side', rightShoulder: 'up' }), ASPECT)!
  expect(waving.cx).toBeCloseTo(still.cx, 6)
})

test('x приводится к единицам y через aspect', () => {
  const lm = stick({ aspect: ASPECT })
  const corrected = geometry(lm, ASPECT)!
  const raw = geometry(lm, 1)!

  // Физическое отношение ширины плеч к длине торса — 0.86 (docs/camera-and-pose.md).
  expect(corrected.shoulderRatio).toBeCloseTo(0.86, 2)
  // Без поправки тот же скелет даёт 0.48 — ровно тот случай, на котором
  // в run-game ломался детектор профиля.
  expect(raw.shoulderRatio).toBeCloseTo(0.48, 2)
  expect(raw.shoulderRatio).toBeLessThan(corrected.shoulderRatio)
})

test('S не зависит от aspect только после поправки — наклонный торс это показывает', () => {
  const lm = stick({ lean: 'lean-left', torso: 0.25, aspect: ASPECT })
  expect(geometry(lm, ASPECT)!.S).toBeCloseTo(0.25, 6)
  // При неверном aspect горизонтальная часть торса сжата — S выходит короче.
  expect(geometry(lm, 1)!.S).toBeLessThan(0.25)
})

test('lm === null даёт null, не исключение', () => {
  expect(geometry(null, ASPECT)).toBeNull()
})

test('aspect === null даёт null — считать углы без него нельзя', () => {
  expect(geometry(stick({}), null)).toBeNull()
})

test('негодный aspect даёт null', () => {
  expect(geometry(stick({}), 0)).toBeNull()
  expect(geometry(stick({}), -1)).toBeNull()
  expect(geometry(stick({}), Number.NaN)).toBeNull()
})

test('массив не той длины даёт null', () => {
  expect(geometry(new Float32Array(8), ASPECT)).toBeNull()
})

test('выродившийся торс даёт null, а не бесконечное отношение', () => {
  const flat = new Float32Array(LANDMARK_COUNT * LANDMARK_STRIDE)
  for (let i = 0; i < LANDMARK_COUNT; i += 1) {
    flat[i * LANDMARK_STRIDE + 3] = 1
  }
  expect(geometry(flat, ASPECT)).toBeNull()
})

test('нечисловая координата опорной точки даёт null', () => {
  const lm = stick({})
  lm[LM.leftShoulder * LANDMARK_STRIDE] = Number.NaN
  expect(geometry(lm, ASPECT)).toBeNull()
})

test('нечисловая visibility опорной точки даёт null, а не тихий NaN в vis', () => {
  // NaN в `vis` прошёл бы молча: каждое сравнение `vis >= порог` дальше читается
  // как «не уверен», и игра судит по тому, чего не видела.
  const lm = stick({ visibilityOf: { leftHip: Number.NaN } })
  expect(geometry(lm, ASPECT)).toBeNull()
})

test('visibility за полосой [0, 1] подрезается, а не уезжает в vis', () => {
  const high = geometry(stick({ visibility: 1.5 }), ASPECT)!
  expect(high.vis).toBe(1)
  const low = geometry(stick({ visibility: -0.5 }), ASPECT)!
  expect(low.vis).toBe(0)
})

test('vis — среднее visibility плеч и бёдер', () => {
  const g = geometry(stick({ visibility: 0.5, visibilityOf: { leftShoulder: 0.1 } }), ASPECT)!
  expect(g.vis).toBeCloseTo((0.1 + 0.5 + 0.5 + 0.5) / 4, 6)
})

test('ушедшие из кадра стопы на vis не влияют — опора судится по коленям', () => {
  const g = geometry(stick({ visibilityOf: { leftAnkle: 0, rightAnkle: 0 } }), ASPECT)!
  expect(g.vis).toBeCloseTo(1, 6)
})
