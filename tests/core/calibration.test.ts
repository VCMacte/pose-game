import { expect, test } from 'vitest'
import { isStale, makeCalibrator } from '../../src/core/calibration'
import { CONFIG } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import type { Calibration } from '../../src/core/types'
import { stick } from '../../src/fake/stick'

const ASPECT = 16 / 9
const CAMERA = 'cam-1'
const DAY_MS = 24 * 60 * 60 * 1000

/** Кадр нейтральной стойки: торс и центр — единственное, что варьируют тесты. */
const neutralFrame = (torso: number, x: number) =>
  geometry(stick({ aspect: ASPECT, torso, x }), ASPECT)!

/** Заполняет калибратор `n` отсчётами, по умолчанию ровно стадию (5 секунд, 11 Гц). */
function fill(
  n: number,
  stepMs: number,
  frameAt: (i: number) => ReturnType<typeof neutralFrame> = () => neutralFrame(0.22, 0.5),
) {
  const c = makeCalibrator(ASPECT, CAMERA)
  for (let i = 0; i < n; i++) {
    c.push(frameAt(i), i * stepMs)
  }
  return c
}

test('значения берутся медианой, не средним — один выброс втрое не сдвигает S0', () => {
  const STEP = 100 // 11 Гц ≈ каждые ~90 мс; 100 мс даёт >= minSamples за 5 секунд
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  const c = fill(n, STEP, (i) => (i === 10 ? neutralFrame(0.22 * 3, 0.5) : neutralFrame(0.22, 0.5)))
  const result = c.done()
  expect('S0' in result).toBe(true)
  expect((result as Calibration).S0).toBeCloseTo(0.22, 6)
})

test('5 секунд набраны — отдаёт калибровку', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  const c = fill(n, STEP, () => neutralFrame(0.22, 0.5))
  const result = c.done()
  expect('S0' in result).toBe(true)
  const cal = result as Calibration
  expect(cal.S0).toBeCloseTo(0.22, 6)
  expect(cal.neutralX).toBeCloseTo(0.5, 6)
  expect(cal.aspect).toBe(ASPECT)
  expect(cal.at).toBe((n - 1) * STEP)
})

test('мало отсчётов — need more (срок стадии не набран)', () => {
  const c = fill(5, 100) // 400 мс — меньше durationMs
  expect(c.done()).toEqual({ need: 'more' })
})

test('мало отсчётов — need more (срок набран, но кадры редкие)', () => {
  // Срок набран (интервал от первого до последнего кадра >= durationMs), но
  // количество отсчётов внутри него — ниже минимума: трекер терял позу.
  const c = makeCalibrator(ASPECT, CAMERA)
  c.push(neutralFrame(0.22, 0.5), 0)
  c.push(neutralFrame(0.22, 0.5), CONFIG.calibration.durationMs)
  expect(c.done()).toEqual({ need: 'more' })
})

test('игрок шевелился — need steady, отличимо от «мало отсчётов»', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  // Центр качается далеко за порог устойчивости, но отсчётов и времени достаточно.
  const c = fill(n, STEP, (i) => neutralFrame(0.22, i % 2 === 0 ? 0.5 : 0.5 + CONFIG.calibration.steadyCx * 3))
  expect(c.done()).toEqual({ need: 'steady' })
})

function freshCalibration(overrides: Partial<Calibration> = {}): Calibration {
  return {
    S0: 0.22,
    shoulderWidth: 0.22 * 0.86,
    neutralX: 0.5,
    neutralShoulderY: 0.4,
    neutralHipY: 0.62,
    aspect: ASPECT,
    at: 0,
    cameraId: CAMERA,
    ...overrides,
  }
}

test('смена aspect делает калибровку устаревшей', () => {
  const cal = freshCalibration({ at: 1000 })
  expect(isStale(cal, 1000, 1, CAMERA)).toBe(true)
})

test('смена камеры делает калибровку устаревшей', () => {
  const cal = freshCalibration({ at: 1000 })
  expect(isStale(cal, 1000, ASPECT, 'cam-2')).toBe(true)
})

test('14 дней делают калибровку устаревшей', () => {
  const cal = freshCalibration({ at: 0 })
  expect(isStale(cal, 14 * DAY_MS + 1, ASPECT, CAMERA)).toBe(true)
})

test('без смены камеры, aspect и до срока — калибровка остаётся годной', () => {
  const cal = freshCalibration({ at: 0 })
  expect(isStale(cal, 14 * DAY_MS - 1, ASPECT, CAMERA)).toBe(false)
})
