import { describe, expect, test } from 'vitest'
import { startPoseSource } from '../../src/adapters/pose/source'
import type { Frame } from '../../src/core/types'

/**
 * Синтетический источник в БРАУЗЕРЕ.
 *
 * Его кадры нумеруются от нуля (`fake/player.ts`), а тик экрана приходит из
 * `requestAnimationFrame`, то есть из `performance.now()` — десятки тысяч
 * миллисекунд. Это та же ловушка часов, что увела первый живой прогон, только
 * зеркальная: кадры не из будущего, а из далёкого прошлого, и в окно судейства
 * они не попадают НИКОГДА. Локальная проверка без камеры, собранная на таких
 * кадрах, показывала бы «игра идёт, но ничего не засчитывается» — и это
 * выглядело бы дефектом игры, а не стенда.
 *
 * → `docs/camera-and-pose.md`
 */
describe('синтетические кадры лежат на часах главного потока', () => {
  /** Три кадра по 83 мс, нумерация от нуля — ровно как у `fakeSource`. */
  const frames = (): AsyncIterable<Frame> => ({
    async *[Symbol.asyncIterator]() {
      for (const t of [0, 83, 166]) yield { t, lm: null }
    },
  })

  async function collect(): Promise<number[]> {
    const got: number[] = []
    const stop = await startPoseSource({
      source: 'fake',
      onSample: (f) => void got.push(f.t),
      onStatus: () => {},
      fakeFrames: () => frames(),
    })
    // Источник качает кадры в своём такте: даём ему дойти до конца.
    for (let i = 0; i < 50 && got.length < 3; i++) await Promise.resolve()
    await stop()
    return got
  }

  test('первый кадр датирован НЕ нулём, а текущим временем', async () => {
    const before = performance.now()
    const got = await collect()

    expect(got.length).toBe(3)
    expect(got[0]).toBeGreaterThanOrEqual(before)
  })

  test('шаг между кадрами сохранён: сдвигается начало отсчёта, а не темп', async () => {
    const got = await collect()

    // С допуском: поправка — дробное число, и разность кадров несёт её хвост.
    expect(got[1] - got[0]).toBeCloseTo(83, 6)
    expect(got[2] - got[1]).toBeCloseTo(83, 6)
  })
})
