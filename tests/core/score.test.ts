import { describe, expect, test } from 'vitest'
import { applyVerdict } from '../../src/core/score'
import type { Verdict } from '../../src/core/judge'

/** Минимальный `Verdict`: applyVerdict смотрит только на `kind`. */
const verdict = (kind: Verdict['kind']): Verdict => ({
  kind,
  frames: 0,
  valid: 0,
  matched: 0,
  ratio: 0,
  perAxis: { axes: {}, worst: null },
})

describe('applyVerdict', () => {
  test('hit +3, miss −2, skip без изменений', () => {
    expect(applyVerdict(10, verdict('hit'))).toBe(13)
    expect(applyVerdict(10, verdict('miss'))).toBe(8)
    expect(applyVerdict(10, verdict('skip'))).toBe(10)
  })

  test('сумма упирается в ноль', () => {
    expect(applyVerdict(1, verdict('miss'))).toBe(0)
    expect(applyVerdict(0, verdict('miss'))).toBe(0)
  })

  test('не уходит в минус даже от нескольких промахов подряд', () => {
    let total = 2
    total = applyVerdict(total, verdict('miss'))
    total = applyVerdict(total, verdict('miss'))
    total = applyVerdict(total, verdict('miss'))
    expect(total).toBe(0)
  })
})
