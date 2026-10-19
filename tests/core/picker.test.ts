import { describe, expect, test, vi } from 'vitest'
import { nextPose, toggleAllowed } from '../../src/core/picker'
import * as posesModule from '../../src/core/poses'
import { cutouts, type Toggles } from '../../src/core/poses'
import { POSE_TAGS, type PoseSpec } from '../../src/core/types'

const TIERS = [1, 2, 3] as const
const ROUNDS = 1000

/** Детерминированный ГСЧ для воспроизводимых прогонов: xorshift32. */
function makeRnd(seed: number): () => number {
  let s = seed
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0xffffffff
  }
}

describe('toggleAllowed', () => {
  test('формула: разрешено тогда и только тогда, когда пул после выключения >= 3', () => {
    for (const tier of TIERS) {
      for (let mask = 0; mask < 1 << POSE_TAGS.length; mask += 1) {
        const tg: Toggles = {}
        POSE_TAGS.forEach((tag, i) => {
          if ((mask & (1 << i)) !== 0) tg[tag] = false
        })
        for (const which of POSE_TAGS) {
          const expected = cutouts(tier, { ...tg, [which]: false }).length >= 3
          expect(toggleAllowed(tg, tier, which), `tier ${tier}, маска ${mask}, ${which}`).toBe(
            expected,
          )
        }
      }
    }
  })

  test('тумблер, роняющий пул ниже 3, запрещён (если такой есть в наборе)', () => {
    // Набор поз спроектирован так, что пул никогда не падает ниже 3 (см.
    // tests/core/poses.test.ts «пул не падает ниже трёх ни при одной
    // комбинации»), поэтому прямого позитивного случая в текущих данных нет —
    // это проверяется её же тестом. Здесь утверждается обратное
    // направление формулы: там, где выключение действительно уронило бы пул
    // ниже 3, toggleAllowed обязана это запретить, и наоборот — нигде не
    // запрещать лишнего.
    for (const tier of TIERS) {
      for (const which of POSE_TAGS) {
        const droppedBelow = cutouts(tier, { [which]: false }).length < 3
        expect(toggleAllowed({}, tier, which), `tier ${tier}, ${which}`).toBe(!droppedBelow)
      }
    }
  })
})

describe('nextPose', () => {
  test('не повторяет предыдущую позу (1000 прогонов)', () => {
    const rnd = makeRnd(1)
    let prev: PoseSpec | null = null
    for (let i = 0; i < ROUNDS; i += 1) {
      const next = nextPose(prev, 3, {}, rnd)
      if (prev !== null) expect(next.id, `раунд ${i}`).not.toBe(prev.id)
      prev = next
    }
  })

  test('не выдаёт зеркало сразу за оригиналом (1000 прогонов)', () => {
    const rnd = makeRnd(42)
    let prev: PoseSpec | null = null
    for (let i = 0; i < ROUNDS; i += 1) {
      const next = nextPose(prev, 3, {}, rnd)
      if (prev !== null && prev.mirrorId !== undefined)
        expect(next.id, `раунд ${i}`).not.toBe(prev.mirrorId)
      prev = next
    }
  })

  test('набирает только из разрешённых ступеней', () => {
    const rnd = makeRnd(7)
    let prev: PoseSpec | null = null
    for (const tier of TIERS) {
      for (let i = 0; i < 200; i += 1) {
        const next = nextPose(prev, tier, {}, rnd)
        expect(next.tier, `tier ${tier}, раунд ${i}`).toBeLessThanOrEqual(tier)
        prev = next
      }
    }
  })

  test('учитывает тумблеры: не выдаёт позу с выключенным тегом', () => {
    const rnd = makeRnd(99)
    let prev: PoseSpec | null = null
    for (let i = 0; i < ROUNDS; i += 1) {
      const next = nextPose(prev, 3, { crouch: false }, rnd)
      expect(next.tags, `раунд ${i}`).not.toContain('crouch')
      prev = next
    }
  })

  test('первый вызов (prev = null) не фильтрует ничего лишнего', () => {
    const rnd = makeRnd(5)
    const first = nextPose(null, 1, {}, rnd)
    expect(cutouts(1).map((p) => p.id)).toContain(first.id)
  })

  // У реального набора поз пул после исключения prev и его зеркала никогда не
  // опустошается (toggleAllowed это гарантирует) — поэтому, чтобы проверить
  // громкий отказ, здесь подменяется cutouts() урезанным пулом из самой prev
  // (и её зеркала, если оно есть): это единственный способ воспроизвести
  // ветку, которая в боевых данных недостижима.
  test('бросает громко, если пул опустел после исключения prev и её зеркала', () => {
    const rnd = makeRnd(1)
    const prev = cutouts(3)[0]
    const tiny: PoseSpec[] = prev.mirrorId !== undefined ? [prev, { ...prev, id: prev.mirrorId }] : [prev]
    const spy = vi.spyOn(posesModule, 'cutouts').mockReturnValue(tiny)
    expect(() => nextPose(prev, 3, {}, rnd)).toThrow(/пул опустел/)
    spy.mockRestore()
  })

  test('чистая функция: одинаковый rnd даёт одинаковую последовательность', () => {
    const run = () => {
      const rnd = makeRnd(123)
      let prev: PoseSpec | null = null
      const ids: string[] = []
      for (let i = 0; i < 10; i += 1) {
        prev = nextPose(prev, 3, {}, rnd)
        ids.push(prev.id)
      }
      return ids
    }
    expect(run()).toEqual(run())
  })
})
