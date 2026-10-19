import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { geometry } from '../../src/core/geometry'
import { judgeWindow, type CheckedFrame } from '../../src/core/judge'
import { POSES } from '../../src/core/poses'
import { newPresenceState, presence, type PresenceState } from '../../src/core/presence'
import type { Calibration, Frame, Orientation } from '../../src/core/types'
import { fakeSource, SCRIPTS, type FakeScript, type FakeSource } from '../../src/fake/player'
import { stick } from '../../src/fake/stick'

/**
 * Синтетический игрок — источник кадров вместо камеры (тема «Синтетический
 * игрок», docs/log-and-storage.md). Шесть сценариев, и каждый проверен
 * СКВОЗНЫМ утверждением через настоящее ядро (`presence()`, `judgeWindow()`),
 * а не фактом, что кадры вообще выдаются: источнику достаточно соврать одной
 * цифрой, чтобы тест, смотрящий только на форму кадра, этого не заметил.
 */

const ASPECT = 16 / 9
const STAR = POSES.find((p) => p.id === 'star')!

function calibrate(): Calibration {
  const g = geometry(stick({ aspect: ASPECT }), ASPECT)!
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

/** Тянет `n` кадров источника под управлением поддельных часов — быстро и точно. */
async function collect(src: FakeSource, n: number, periodMs: number): Promise<Frame[]> {
  const it = src[Symbol.asyncIterator]()
  const out: Frame[] = []
  const first = await it.next()
  out.push(first.value as Frame)
  for (let k = 1; k < n; k += 1) {
    const p = it.next()
    await vi.advanceTimersByTimeAsync(periodMs)
    out.push((await p).value as Frame)
  }
  return out
}

/** То же самое, что делает `run.ts` с каждым кадром камеры: присутствие решает годность. */
function checkFrames(frames: Frame[], pst: PresenceState, expect: Orientation): CheckedFrame[] {
  return frames.map((f) => {
    const gm = geometry(f.lm, CAL.aspect)
    const v = presence(gm, f.t, pst, expect)
    return v.ok ? { t: f.t, ok: true, lm: f.lm as NonNullable<Frame['lm']>, gm: v.gm } : { t: f.t, ok: false, why: v.why }
  })
}

const HZ = 12
const PERIOD = 1000 / HZ

/** Для тестов, которым самомаркировка не предмет проверки. */
const noMark = (): void => {}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('шесть сценариев из темы', () => {
  test('сценарий hit даёт кадры, на которых judgeWindow выносит hit', async () => {
    const frames = await collect(fakeSource('hit', HZ, noMark), 8, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), STAR.orientation)
    const verdict = judgeWindow({
      spec: STAR,
      frames: checked,
      contactT: frames[frames.length - 1].t,
      latencyMs: 0,
      cal: CAL,
      strict: 1,
    })
    expect(verdict.kind).toBe('hit')
    expect(verdict.valid).toBeGreaterThanOrEqual(8)
  })

  test('сценарий miss-one-axis роняет ровно одну ось', async () => {
    const frames = await collect(fakeSource('miss-one-axis', HZ, noMark), 8, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), STAR.orientation)
    const verdict = judgeWindow({
      spec: STAR,
      frames: checked,
      contactT: frames[frames.length - 1].t,
      latencyMs: 0,
      cal: CAL,
      strict: 1,
    })
    expect(verdict.kind).toBe('miss')
    expect(verdict.perAxis.worst?.axis).toBe('leftShoulder')
    // Промах ровно один: все требуемые оси, кроме упавшей, засчитаны.
    for (const [axis, summary] of Object.entries(verdict.perAxis.axes)) {
      if (axis === 'leftShoulder') {
        expect(summary!.outcome).toBe('miss')
      } else {
        expect(summary!.outcome, axis).toBe('ok')
      }
    }
  })

  test('still — непрерывное присутствие, без ложных скачков', async () => {
    const frames = await collect(fakeSource('still', HZ, noMark), 10, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), 'front')
    expect(checked.every((f) => f.ok)).toBe(true)
  })

  test('leave-frame даёт кадры, дающие presence why none/lowvis', async () => {
    const frames = await collect(fakeSource('leave-frame', HZ, noMark), 8, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), 'front')
    const before = checked.slice(0, 5)
    const after = checked.slice(5)
    expect(before.every((f) => f.ok)).toBe(true)
    for (const f of after) {
      expect(f.ok).toBe(false)
      if (!f.ok) expect(['none', 'lowvis']).toContain(f.why)
    }
  })

  test('turn-profile даёт presence why orientation для раунда с фронтом', async () => {
    const frames = await collect(fakeSource('turn-profile', HZ, noMark), 8, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), 'front')
    const before = checked.slice(0, 5)
    const after = checked.slice(5)
    expect(before.every((f) => f.ok)).toBe(true)
    for (const f of after) {
      expect(f.ok).toBe(false)
      if (!f.ok) expect(f.why).toBe('orientation')
    }
  })

  test('subject-swap даёт jump', async () => {
    const frames = await collect(fakeSource('subject-swap', HZ, noMark), 8, PERIOD)
    const checked = checkFrames(frames, newPresenceState(), 'front')
    const before = checked.slice(0, 5)
    const after = checked.slice(5)
    expect(before.every((f) => f.ok)).toBe(true)
    for (const f of after) {
      expect(f.ok).toBe(false)
      if (!f.ok) expect(f.why).toBe('jump')
    }
  })
})

test('частота кадров соответствует заданной: пауза между кадрами равна 1000/hz', async () => {
  const src = fakeSource('still', HZ, noMark)
  const it = src[Symbol.asyncIterator]()

  const first = await it.next()
  expect(first.value?.t).toBe(0)

  const pending = it.next()
  let resolved = false
  void pending.then(() => {
    resolved = true
  })

  await vi.advanceTimersByTimeAsync(PERIOD - 10)
  expect(resolved).toBe(false)

  await vi.advanceTimersByTimeAsync(10)
  const second = await pending
  expect(resolved).toBe(true)
  expect(second.value?.t).toBeCloseTo(PERIOD, 6)
})

test('частота держится и на других значениях hz', async () => {
  const hz = 11
  const period = 1000 / hz
  const frames = await collect(fakeSource('still', hz, noMark), 5, period)
  for (let i = 1; i < frames.length; i += 1) {
    expect(frames[i].t - frames[i - 1].t).toBeCloseTo(period, 6)
  }
})

describe('самомаркировка в журнале', () => {
  test('marker называет источник и сценарий синтетическими до единого выданного кадра', () => {
    const onMark = vi.fn()
    fakeSource('hit', HZ, onMark)
    expect(onMark).toHaveBeenCalledWith({ type: 'fake.source', data: { script: 'hit', hz: HZ } })
  })

  test('marker есть у каждого сценария и несёт ровно его имя', () => {
    for (const script of SCRIPTS) {
      const onMark = vi.fn()
      fakeSource(script, HZ, onMark)
      expect(onMark.mock.calls[0]?.[0].data.script).toBe(script)
    }
  })

  test('onMark обязателен: источник без него не создать', () => {
    // @ts-expect-error — onMark обязателен в рантайме и в типах.
    expect(() => fakeSource('hit', HZ)).toThrow(/onMark/)
  })

  test('onMark вызывается при создании источника ровно один раз со script и hz', () => {
    const onMark = vi.fn()
    fakeSource('hit', HZ, onMark)
    expect(onMark).toHaveBeenCalledTimes(1)
    expect(onMark).toHaveBeenCalledWith({ type: 'fake.source', data: { script: 'hit', hz: HZ } })
  })

  test('источник, созданный и ни разу не прочитанный, всё равно помечен', () => {
    const onMark = vi.fn()
    // Источник создан, но из него не взято ни одного кадра (ни .next(), ни for await).
    fakeSource('still', HZ, onMark)
    expect(onMark).toHaveBeenCalledTimes(1)
  })
})

describe('отказы формы', () => {
  test('неизвестный сценарий падает громко', () => {
    expect(() => fakeSource('nope' as FakeScript, HZ, noMark)).toThrow(/сценари/)
  })

  test('негодный hz падает громко', () => {
    expect(() => fakeSource('still', 0, noMark)).toThrow(/hz/)
    expect(() => fakeSource('still', -1, noMark)).toThrow(/hz/)
    expect(() => fakeSource('still', NaN, noMark)).toThrow(/hz/)
  })

  test('SCRIPTS перечисляет ровно шесть сценариев темы', () => {
    expect([...SCRIPTS].sort()).toEqual(
      ['hit', 'leave-frame', 'miss-one-axis', 'still', 'subject-swap', 'turn-profile'].sort(),
    )
  })
})
