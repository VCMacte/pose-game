import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { POSES } from '../../src/core/poses'
import { makeRound, timingsFor, type RoundPhase, type Timings } from '../../src/core/round'
import type { PoseSpec } from '../../src/core/types'

/**
 * Такты раунда (docs/judging.md «Четыре такта раунда»).
 *
 * Два правила держат этот файл:
 *
 * - **Фаза считается от времени, состояния анимации нет вовсе.** Поэтому
 *   `phaseAt` спрашивается и вразнобой, и дважды об одном моменте: автомат,
 *   хранящий фазу, развёл бы расписание с картинкой при просадке кадра.
 * - **Приговор физически недоступен раньше `contact + latency`.** Замирание
 *   равно настроенной задержке тракта и отдельно не настраивается — на это
 *   стоит тест, и он обязан падать, если замирание станет своим числом.
 */

const TEE: PoseSpec = POSES.find((p) => p.id === 'tee')!

const T: Timings = { previewMs: 2000, wallMs: 2000, latencyMs: 150, verdictMs: 800 }

const START = 1_000

/** Последовательность СМЕН фазы на всём протяжении раунда, шагом 1 мс. */
function phases(timings: Timings): RoundPhase[] {
  const r = makeRound(TEE, START, timings)
  const out: RoundPhase[] = []
  for (let t = START; t < r.endT; t += 1) {
    const p = r.phaseAt(t)
    if (out[out.length - 1] !== p) out.push(p)
  }
  return out
}

test('четыре такта в порядке preview → wall → freeze → verdict', () => {
  expect(phases(T)).toEqual(['preview', 'wall', 'freeze', 'verdict'])
})

test('границы тактов названы отметками раунда', () => {
  const r = makeRound(TEE, START, T)

  expect(r.contactT).toBe(START + T.previewMs + T.wallMs)
  expect(r.verdictT).toBe(r.contactT + T.latencyMs)
  expect(r.endT).toBe(r.verdictT + T.verdictMs)

  expect(r.phaseAt(START)).toBe('preview')
  expect(r.phaseAt(START + T.previewMs - 1)).toBe('preview')
  expect(r.phaseAt(START + T.previewMs)).toBe('wall')
  expect(r.phaseAt(r.contactT - 1)).toBe('wall')
  // Касание стены — начало замирания, а не его конец.
  expect(r.phaseAt(r.contactT)).toBe('freeze')
  expect(r.phaseAt(r.endT - 1)).toBe('verdict')
})

test('длина freeze равна настроенной задержке', () => {
  for (const latencyMs of [0, 60, 150, 400, 900]) {
    const timings = { ...T, latencyMs }
    const r = makeRound(TEE, START, timings)
    const freeze = Array.from({ length: r.endT - START }, (_, i) => START + i).filter(
      (t) => r.phaseAt(t) === 'freeze',
    )

    expect(freeze.length, `latency ${latencyMs}`).toBe(latencyMs)
    expect(r.verdictT - r.contactT, `latency ${latencyMs}`).toBe(latencyMs)
    // Нулевая задержка — такта замирания нет вовсе, и это не дефект: он
    // ВЫВЕДЕН из задержки, а не настроен своим числом.
    if (latencyMs === 0) expect(phases(timings)).toEqual(['preview', 'wall', 'verdict'])
  }
})

test('приговор не выносится раньше contact + latency', () => {
  const r = makeRound(TEE, START, T)

  expect(r.phaseAt(r.contactT)).not.toBe('verdict')
  expect(r.phaseAt(r.verdictT - 1)).not.toBe('verdict')
  expect(r.phaseAt(r.verdictT)).toBe('verdict')
})

test('фаза считается от времени: порядок вопросов её не меняет', () => {
  const r = makeRound(TEE, START, T)
  const asked: RoundPhase[] = [
    r.phaseAt(r.verdictT),
    r.phaseAt(START),
    r.phaseAt(r.contactT),
    r.phaseAt(START + T.previewMs),
    r.phaseAt(START),
    r.phaseAt(r.verdictT),
  ]

  expect(asked).toEqual(['verdict', 'preview', 'freeze', 'wall', 'preview', 'verdict'])
})

test('время вне раунда зажимается крайними тактами', () => {
  const r = makeRound(TEE, START, T)

  // Раунд ведёт забег; `phaseAt` снаружи границ отвечает крайним тактом, а не
  // бросает: просадка кадра не обязана ронять картинку.
  expect(r.phaseAt(START - 500)).toBe('preview')
  expect(r.phaseAt(r.endT + 5_000)).toBe('verdict')
})

test('раунд несёт позу и своё начало', () => {
  const r = makeRound(TEE, START, T)

  expect(r.spec).toBe(TEE)
  expect(r.startT).toBe(START)
})

describe('настройки тактов', () => {
  test('такт раунда из CONFIG — около пяти секунд', () => {
    const t = timingsFor(150)

    expect(t.previewMs).toBe(CONFIG.round.previewMs)
    expect(t.wallMs).toBe(CONFIG.round.wallMs)
    expect(t.verdictMs).toBe(CONFIG.round.verdictMs)
    expect(t.latencyMs).toBe(150)

    const length = t.previewMs + t.wallMs + t.latencyMs + t.verdictMs
    expect(length).toBeGreaterThan(4_500)
    expect(length).toBeLessThan(5_500)
  })

  test('нулевой или отрицательный такт отвергается', () => {
    expect(() => makeRound(TEE, START, { ...T, previewMs: 0 })).toThrow()
    expect(() => makeRound(TEE, START, { ...T, wallMs: -1 })).toThrow()
    expect(() => makeRound(TEE, START, { ...T, verdictMs: 0 })).toThrow()
    expect(() => makeRound(TEE, START, { ...T, latencyMs: -1 })).toThrow()
    expect(() => makeRound(TEE, START, { ...T, latencyMs: Number.NaN })).toThrow()
  })
})
