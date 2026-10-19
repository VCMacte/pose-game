import { expect, test } from 'vitest'
import { isStale, makeCalibrator } from '../../src/core/calibration'
import { CONFIG } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import type { Calibration } from '../../src/core/types'
import { stick } from '../../src/fake/stick'

const ASPECT = 16 / 9
const CAMERA = 'cam-1'
const DAY_MS = 24 * 60 * 60 * 1000
const WALL_NOW = 1_700_000_000_000 // произвольная точка часов стены — далеко от нуля, как и в жизни

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

test('значения берутся медианой, не средним — один выброс втрое не сдвигает ни одно из пяти полей', () => {
  const STEP = 100 // 11 Гц ≈ каждые ~90 мс; 100 мс даёт >= minSamples за 5 секунд
  const base = neutralFrame(0.22, 0.5)
  const c = fill(Math.ceil(CONFIG.calibration.durationMs / STEP) + 1, STEP, (i) =>
    i === 10 ? neutralFrame(0.22 * 3, 0.5) : base,
  )
  const result = c.done(WALL_NOW)
  expect('S0' in result).toBe(true)
  const cal = result as Calibration
  // Выброс при i===10 меняет torso, а значит и S, shoulderWidth, shoulderY, hipY — ни одно
  // из пяти медианных полей не должно сдвинуться, иначе это была бы не медиана, а среднее.
  expect(cal.S0).toBeCloseTo(base.S, 6)
  expect(cal.shoulderWidth).toBeCloseTo(base.shoulderRatio * base.S, 6)
  expect(cal.neutralX).toBeCloseTo(base.cx, 6)
  expect(cal.neutralShoulderY).toBeCloseTo(base.shoulderMid.y, 6)
  expect(cal.neutralHipY).toBeCloseTo(base.hipMid.y, 6)
})

test('5 секунд набраны — отдаёт калибровку', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  const c = fill(n, STEP, () => neutralFrame(0.22, 0.5))
  const result = c.done(WALL_NOW)
  expect('S0' in result).toBe(true)
  const cal = result as Calibration
  expect(cal.S0).toBeCloseTo(0.22, 6)
  expect(cal.neutralX).toBeCloseTo(0.5, 6)
  expect(cal.aspect).toBe(ASPECT)
  expect(cal.at).toBe((n - 1) * STEP) // рамочные часы — последний отсчёт стадии
  expect(cal.takenAtMs).toBe(WALL_NOW) // часы стены — что передали в done()
})

test('мало отсчётов — need more (срок стадии не набран)', () => {
  const c = fill(5, 100) // 400 мс — меньше durationMs
  expect(c.done(WALL_NOW)).toEqual({ need: 'more' })
})

test('мало отсчётов — need more (срок набран, но кадры редкие)', () => {
  // Срок набран (интервал от первого до последнего кадра >= durationMs), но
  // количество отсчётов внутри него — ниже минимума: трекер терял позу.
  const c = makeCalibrator(ASPECT, CAMERA)
  c.push(neutralFrame(0.22, 0.5), 0)
  c.push(neutralFrame(0.22, 0.5), CONFIG.calibration.durationMs)
  expect(c.done(WALL_NOW)).toEqual({ need: 'more' })
})

test('игрок шевелился — need steady, отличимо от «мало отсчётов»', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  // Центр качается далеко за порог устойчивости, но отсчётов и времени достаточно.
  const c = fill(n, STEP, (i) => neutralFrame(0.22, i % 2 === 0 ? 0.5 : 0.5 + CONFIG.calibration.steadyCx * 3))
  expect(c.done(WALL_NOW)).toEqual({ need: 'steady' })
})

test('done(), пройдя через isStale с той же камерой и aspect, читается как свежая (круговой тест)', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  const c = fill(n, STEP)
  const cal = c.done(WALL_NOW) as Calibration
  expect('S0' in cal).toBe(true)
  // Проверка сразу после калибровки, той же камерой и aspect — не должна требовать пересдачи.
  expect(isStale(cal, WALL_NOW, ASPECT, CAMERA)).toBe(false)
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
    takenAtMs: WALL_NOW,
    cameraId: CAMERA,
    ...overrides,
  }
}

test('смена aspect делает калибровку устаревшей', () => {
  const cal = freshCalibration()
  expect(isStale(cal, WALL_NOW, 1, CAMERA)).toBe(true)
})

test('смена камеры делает калибровку устаревшей', () => {
  const cal = freshCalibration()
  expect(isStale(cal, WALL_NOW, ASPECT, 'cam-2')).toBe(true)
})

test('14 дней (по часам стены) делают калибровку устаревшей', () => {
  const cal = freshCalibration({ takenAtMs: WALL_NOW })
  expect(isStale(cal, WALL_NOW + 14 * DAY_MS + 1, ASPECT, CAMERA)).toBe(true)
})

test('без смены камеры, aspect и до срока — калибровка остаётся годной', () => {
  const cal = freshCalibration({ takenAtMs: WALL_NOW })
  expect(isStale(cal, WALL_NOW + 14 * DAY_MS - 1, ASPECT, CAMERA)).toBe(false)
})

test('калибровка без takenAtMs (ручная сборка) читается как устаревшая — отказ в безопасную сторону', () => {
  const cal = freshCalibration({ takenAtMs: undefined })
  expect(isStale(cal, WALL_NOW, ASPECT, CAMERA)).toBe(true)
})

// Регрессия, которую ловит следующий тест: если бы `isStale` снова стала сравнивать
// по `cal.at` (рамочные часы), то калибровка со свежей отметкой часов СТЕНЫ, но
// старым (по номеру сессии) рамочным `at`, прочиталась бы как устаревшая — ложно,
// в ОПАСНУЮ сторону (отказ открывается, а не закрывается). Именно эта асимметрия
// шкал (рамочные часы — единицы-секунды с начала сессии; часы стены — эпоха,
// ~10^12 мс) и была исходным дефектом: `now - cal.at` после перезапуска почти
// всегда превышает `maxAgeMs`, вне зависимости от того, сколько часов стены
// реально прошло. Числа ниже подобраны так, чтобы это было видно явной проверкой,
// а не угадано по совпадению порядка величины.
test('калибровка остаётся СВЕЖЕЙ после перезапуска сессии: часы стены недавние, рамочные часы — чужой сессии и несравнимого масштаба', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  // Забег 1: рамочные часы (t) идут от 0 — калибровка снята в его конце (`cal.at` — единицы секунд),
  // часы стены (`WALL_NOW`, переданные в done()) — настоящая дата калибровки.
  const c = fill(n, STEP)
  const cal = c.done(WALL_NOW) as Calibration
  expect('S0' in cal).toBe(true)

  // Забег 2 — перезапуск приложения спустя ЧАС по часам стены (заведомо внутри 14 дней).
  const wallNowSessionTwo = WALL_NOW + 60 * 60 * 1000
  // Контроль: разница по старой (ошибочной) формуле `now - cal.at` — рамочные часы
  // сессии 1 ничтожны рядом с эпохой — на порядки больше `maxAgeMs`. Старый код счёл
  // бы калибровку устаревшей; это и есть то, что регрессия маскирует.
  expect(wallNowSessionTwo - cal.at).toBeGreaterThan(CONFIG.calibration.maxAgeMs)
  // Правильный код сравнивает по `takenAtMs` (часы стены) — час меньше 14 дней, калибровка свежая.
  expect(isStale(cal, wallNowSessionTwo, ASPECT, CAMERA)).toBe(false)
})

// Отдельно от теста выше: документирует, что ПОДЛИННАЯ (14+ дней по часам стены)
// устарелость продолжает отлавливаться и после перезапуска сессии. Эта проверка НЕ
// отличает правильный код от регрессии на `cal.at` — под реверсией обе отметки времени
// дают «устарела» (см. тест выше, который и ловит регрессию).
test('14-дневная калибровка остаётся устаревшей при перезапуске сессии — часы стены и рамочные часы разделены', () => {
  const STEP = 100
  const n = Math.ceil(CONFIG.calibration.durationMs / STEP) + 1
  const c = fill(n, STEP)
  const cal = c.done(WALL_NOW) as Calibration

  const sessionTwoFrameNow = STEP * 30 // несколько секунд после старта новой сессии — на случай regress по `at`
  const wallNowTwoWeeksLater = WALL_NOW + 14 * DAY_MS + 1
  expect(sessionTwoFrameNow).toBeLessThan(cal.at) // рамочные часы правда «отмотались назад»
  expect(isStale(cal, wallNowTwoWeeksLater, ASPECT, CAMERA)).toBe(true)
})
