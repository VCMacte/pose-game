import { describe, expect, test } from 'vitest'
import { AXES, axes, type Axis } from '../../src/core/axes'
import { strictness } from '../../src/core/config'
import {
  dependentAxes,
  JOINTS,
  limbImplication,
  limbImplications,
  type Implication,
} from '../../src/core/dependencies'
import { geometry } from '../../src/core/geometry'
import { POSES } from '../../src/core/poses'
import type { Calibration, Landmarks, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Связность осей руки: плечо, локоть и предплечье связаны ОДНИМ уравнением
 * |плечо − предплечье| = 180° − локоть, поэтому поза, задавшая два из трёх,
 * могла задать третье впустую — или, хуже, противоречиво.
 *
 * Здесь проверяется сам вывод. Данные набора поз сторожит
 * tests/core/poses.test.ts («согласованность» и «запас по независимым осям»).
 */

const LEVELS = (['soft', 'normal', 'strict'] as const).map((l) => strictness(l))
const NORMAL = strictness('normal')
const ASPECT = 16 / 9

const frame = (desc: Partial<StickDesc>): Landmarks => stick({ aspect: ASPECT, ...desc })

function calibrate(): Calibration {
  const g = geometry(frame({}), ASPECT)!
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

const readPose = (p: PoseSpec, strict: number): Record<Axis, { state: unknown }> => {
  const lm = frame({ orientation: p.orientation, ...p.requires })
  return axes(lm, geometry(lm, ASPECT)!, CAL, strict) as unknown as Record<
    Axis,
    { state: unknown }
  >
}

/** Имена звеньев одной руки, выведенные из `AXES`: `left`, `right`, `near`, `far`. */
const PREFIXES = AXES.filter((a) => a.endsWith('Elbow')).map((a) => a.slice(0, -'Elbow'.length))

const nonEmpty = (strict: number): Record<string, Axis[]> =>
  Object.fromEntries(
    POSES.map((p) => [p.id, dependentAxes(p, strict)] as const).filter(([, a]) => a.length > 0),
  )

describe('вывод по полосам', () => {
  test('локоть при плече `side` и предплечье `up` определён: только `bent` достижим', () => {
    // |плечо − предплечье| = 180° − локоть. Плечо `side` живёт в (75°, 120°],
    // предплечье `up` — в [−35°, 35°], значит разница лежит в (40°, 155°], а
    // локоть — в [25°, 140°). Полоса `straight` (≥150°) из этого промежутка
    // недостижима, `bent` (70…115°) достижима: состояние локтя определено.
    const got = limbImplication(
      'elbow',
      { shoulder: 'side', elbow: 'bent', forearm: 'up' },
      'front',
      NORMAL,
    )
    expect(got).toEqual<Implication>({
      kind: 'derived',
      state: 'bent',
      reachable: ['bent'],
      nominal: ['bent'],
    })
  })

  test('локоть при плече `side` и предплечье `down` НЕ определён: достижим и `straight`', () => {
    // Плечо 120° и предплечье 145° — это `side` и `down`, но угол в локте там
    // 155°, то есть `straight`. Такая рука выразима, значит ось локтя здесь
    // несёт своё, а не повторяет два соседних требования.
    const got = limbImplication(
      'elbow',
      { shoulder: 'side', elbow: 'bent', forearm: 'down' },
      'front',
      NORMAL,
    )
    expect(got.kind).toBe('open')
    // Сужение типа: строка недостижима — `kind` проверен выше.
    if (got.kind === 'no-angle') throw new Error(got.why)
    expect([...got.reachable].sort()).toEqual(['bent', 'straight'])
  })

  test('строгость сужает полосы и делает тот же локоть определённым', () => {
    // Строгая настройка умножает допуски на 0.75: плечо `side` сжимается до
    // [67.5°, 112.5°], предплечье `down` — до [153.75°, 180°], и `straight`
    // из достижимых уходит. Поэтому сторожа данных обязаны считать запас при
    // ВСЕХ трёх строгостях, а не только при нормальной.
    const got = limbImplication(
      'elbow',
      { shoulder: 'side', elbow: 'bent', forearm: 'down' },
      'front',
      strictness('strict'),
    )
    expect(got).toEqual<Implication>({
      kind: 'derived',
      state: 'bent',
      reachable: ['bent'],
      nominal: ['bent'],
    })
  })

  test('рука на камеру углом не выражается — выводить нечем', () => {
    // Во фронтальном кадре `front` опознаётся вырождением проекции (локоть и
    // кисть у средней линии), а не углом: полосы для него нет, и уравнение
    // связности к такой руке не применяется вовсе.
    for (const joint of JOINTS) {
      const got = limbImplication(
        joint,
        { shoulder: 'front', elbow: 'bent', forearm: 'up' },
        'front',
        NORMAL,
      )
      expect(got.kind, joint).toBe('no-angle')
    }
    // В профиль тот же `front` — это угол 90° от вертикали, и вывод работает.
    expect(
      limbImplication(
        'elbow',
        { shoulder: 'front', elbow: 'bent', forearm: 'up' },
        'profile',
        NORMAL,
      ).kind,
    ).toBe('derived')
  })

  test('плечо во фронтальном кадре не определить: `front` достижим всегда', () => {
    // Полосы `front` во фронте нет, но состояние есть: рука, уведённая на
    // камеру, читается им при любом угле, попавшем в зазор между полосами.
    // Поэтому плечо и предплечье во фронте независимы всегда.
    const got = limbImplication(
      'shoulder',
      { shoulder: 'side', elbow: 'bent', forearm: 'up' },
      'front',
      NORMAL,
    )
    expect(got.kind).toBe('open')
    // Сужение типа: строка недостижима — `kind` проверен выше.
    if (got.kind === 'no-angle') throw new Error(got.why)
    expect(got.reachable).toContain('front')
  })
})

describe('связность в наборе поз', () => {
  test('ось-звено без двух соседей вывода не имеет', () => {
    // «Звезда» задаёт плечо и локоть, но не предплечье: уравнение неполно, и
    // ось локтя там никем не определена.
    const star = POSES.find((p) => p.id === 'star')!
    expect(star.requires.leftForearm).toBeUndefined()
    expect(limbImplications(star, NORMAL).leftElbow).toBeUndefined()
    expect(dependentAxes(star, NORMAL)).toEqual([])
  })

  test('зависимые оси набора при нормальной строгости', () => {
    // Таблица выписана целиком, а не «хотя бы одна»: набор поз — данные, и
    // всякое изменение связности должно быть видно здесь глазами.
    expect(nonEmpty(NORMAL)).toEqual({
      robot: ['leftElbow'],
      'robot-mirror': ['rightElbow'],
      crab: ['leftElbow', 'rightElbow'],
      egypt: ['nearElbow'],
    })
  })

  test('мягкая настройка оставляет зависимым один локоть', () => {
    // Мягкая строгость расширяет полосы: плечо `side` дотягивается до 129°, и
    // при предплечье `up` локоть достаёт до `straight` — ось снова своя.
    expect(nonEmpty(strictness('soft'))).toEqual({ egypt: ['nearElbow'] })
  })

  test('строгая настройка делает зависимыми все локти описанных рук и одно предплечье', () => {
    expect(nonEmpty(strictness('strict'))).toEqual({
      robot: ['leftElbow', 'rightElbow'],
      'robot-mirror': ['leftElbow', 'rightElbow'],
      rockstar: ['rightElbow'],
      'rockstar-mirror': ['leftElbow'],
      barrier: ['leftElbow', 'rightElbow'],
      crab: ['leftElbow', 'rightElbow'],
      four: ['leftElbow', 'rightElbow'],
      'four-mirror': ['leftElbow', 'rightElbow'],
      // Зависим не только локоть: у «Египетского рисунка» ДАЛЬНЕЕ ПРЕДПЛЕЧЬЕ
      // при плече `down` и локте `bent` достаёт только до полосы `front`.
      // В профиль у плеча и предплечья нет состояния «на камеру», которым они
      // во фронте спасаются от определённости.
      egypt: ['nearElbow', 'farElbow', 'farForearm'],
    })
    // «Боксёр» не зависим ни при какой строгости, но и не свободен: его руки
    // уведены на камеру, и выводить о них нечем вовсе.
    expect(nonEmpty(strictness('strict')).boxer).toBeUndefined()
  })

  test('подразумеваемое состояние — то же, что axes() читает на скелете позы', () => {
    // Связь вывода с судейством: вывод идёт по полосам `axes()`, значит на
    // скелете самой позы он обязан совпасть с измерением. Иначе сторож
    // согласованности сторожил бы свою копию порогов.
    let checked = 0
    for (const strict of LEVELS) {
      for (const p of POSES) {
        const r = readPose(p, strict)
        for (const [axis, imp] of Object.entries(limbImplications(p, strict))) {
          if (imp.kind === 'no-angle') continue
          expect(imp.reachable, `${p.id}.${axis} @${strict}`).toContain(r[axis as Axis].state)
          checked += 1
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  test('оси-звенья выводятся из AXES, а не перечисляются рядом', () => {
    expect(PREFIXES).toEqual(['left', 'right', 'near', 'far'])
    for (const prefix of PREFIXES) {
      for (const joint of JOINTS) {
        const axis = `${prefix}${joint[0].toUpperCase()}${joint.slice(1)}`
        expect(AXES, axis).toContain(axis)
      }
    }
  })
})
