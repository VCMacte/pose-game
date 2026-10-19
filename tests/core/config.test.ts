import { describe, expect, test } from 'vitest'
import { CONFIG, strictness } from '../../src/core/config'

test('CONFIG несёт все пороги из спека', () => {
  expect(CONFIG.shoulder.tolerance).toBe(30)
  expect(CONFIG.legs.ankle.together).toBe(0.35)
  expect(CONFIG.legs.ankle.max).toBe(1.4)
  expect(CONFIG.judge.ratio).toBe(0.60)
  expect(CONFIG.judge.minValid).toBe(4)
  expect(CONFIG.judge.skipBelow).toBe(3)
  expect(CONFIG.judge.windowMs).toBe(600)
  expect(CONFIG.score.hit).toBe(3)
  expect(CONFIG.score.miss).toBe(-2)
  expect(CONFIG.orientation.front).toBe(0.70)
  expect(CONFIG.orientation.profile).toBe(0.45)
})

test('строгость масштабирует допуски', () => {
  expect(strictness('soft')).toBe(1.3)
  expect(strictness('strict')).toBe(0.75)
})

test('угол фикстуры глубокого приседа остаётся анатомически возможным', () => {
  expect(CONFIG.knee.crouchDeep).toBeLessThan(CONFIG.knee.crouchVoteMax)
})
