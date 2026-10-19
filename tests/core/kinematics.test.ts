import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { kinematics } from '../../src/core/kinematics'
import type { Pt } from '../../src/core/types'

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const F = CONFIG.figure

describe('единицы и соглашения о сторонах', () => {
  test('торс ровно 1 S, середина бёдер — начало координат', () => {
    const j = kinematics()
    expect(j.hipMid).toEqual({ x: 0, y: 0 })
    expect(dist(j.hipMid, j.shoulderMid)).toBeCloseTo(1, 12)
    // `y` растёт вниз: плечи выше бёдер — значит меньше.
    expect(j.shoulderMid.y).toBeLessThan(j.hipMid.y)
  })

  test('камера не зеркалит: левая сторона игрока лежит в +x', () => {
    const j = kinematics()
    expect(j.shoulder.left.x).toBeGreaterThan(0)
    expect(j.shoulder.right.x).toBeLessThan(0)
    expect(j.hip.left.x).toBeGreaterThan(0)
    expect(j.hip.right.x).toBeLessThan(0)
  })

  test('длины звеньев — ровно те, что в CONFIG.figure, и у рук, и у ног', () => {
    const j = kinematics()
    for (const side of ['left', 'right'] as const) {
      expect(dist(j.shoulder[side], j.elbow[side]), side).toBeCloseTo(F.upperArm, 12)
      expect(dist(j.elbow[side], j.wrist[side]), side).toBeCloseTo(F.forearm, 12)
      expect(dist(j.hip[side], j.knee[side]), side).toBeCloseTo(F.thigh, 12)
      expect(dist(j.knee[side], j.ankle[side]), side).toBeCloseTo(F.shin, 12)
    }
  })

  test('в профиль ближняя к камере сторона лежит ПРОТИВ взгляда', () => {
    // Знак выведен, а не выбран. Экранные оси: `x` вправо, `y` вниз, `z` в
    // экран. У тела с рысканьем θ (0° — лицом в камеру, 90° — профиль вправо)
    // `forward = (sin θ, 0, −cos θ)`, а анатомически правая сторона лежит по
    // `right = forward × up = (−cos θ, 0, −sin θ)`. Недовёрнутое тело, у
    // которого боковые размеры ещё видны (`latScale = |cos θ| > 0`), повёрнуто
    // К камере при θ < 90° — и тогда `right.x = −cos θ < 0`. Обратный знак
    // изображал бы тело, довёрнутое ЗА профиль, то есть отвернувшееся: ребёнку
    // было бы нарисовано «отвернись» вместо «повернись боком».
    const right = kinematics({ orientation: 'profile', facing: 'right' })
    expect(right.near).toBe('right')
    expect(right.facing).toBe(1)
    expect(right.shoulder.right.x).toBeLessThan(0)
    expect(right.shoulder.left.x).toBeGreaterThan(0)

    const left = kinematics({ orientation: 'profile', facing: 'left' })
    expect(left.near).toBe('left')
    expect(left.shoulder.left.x).toBeGreaterThan(0)
    expect(left.shoulder.right.x).toBeLessThan(0)
  })

  test('в профиль боковые размеры тела сжаты, а носок уходит в сторону взгляда', () => {
    const front = kinematics()
    const profile = kinematics({ orientation: 'profile', facing: 'right' })
    const span = (j: ReturnType<typeof kinematics>): number =>
      Math.abs(j.shoulder.left.x - j.shoulder.right.x)

    expect(span(profile)).toBeCloseTo(span(front) * F.profileLateral, 12)
    for (const side of ['left', 'right'] as const) {
      expect(profile.toe[side].x, side).toBeGreaterThan(profile.ankle[side].x)
      expect(profile.heel[side].x, side).toBeLessThan(profile.ankle[side].x)
    }
  })
})

describe('невыразимое падает, а не выдаёт искажённую фигуру', () => {
  // Два прежних молчаливых зажима. Сработав, они оставляли бы точку там, где
  // её запросили, а звено решалось бы по укороченному пролёту: нога выходила
  // бы не той длины МОЛЧА. Ребёнок копирует именно её.
  test('разнос шире, чем нога достаёт, — отказ с числами, а не короткая нога', () => {
    const reach = 2 * F.thigh
    // Стопа дальше от бедра, чем нога вытянутая достаёт.
    expect(() => kinematics({ legs: 2 * (reach + F.hipHalf) + 0.2 })).toThrow(/не достаёт стопой/)
    // Ровно за кромкой достижимого — и при прямых ногах, и в приседе, где
    // пролёт короче.
    expect(() => kinematics({ legs: 2 * (F.hipHalf + reach) - 0.01 })).not.toThrow()
    expect(() => kinematics({ crouch: 'yes', legs: 2 * (F.hipHalf + reach) - 0.01 })).toThrow(
      /не достаёт стопой/,
    )
  })

  test('колено, поднятое выше, чем достаёт бедро, — отказ, а не растянутое бедро', () => {
    expect(() => kinematics({ support: 'left', raisedKnee: 0.5 })).not.toThrow()
    expect(() => kinematics({ support: 'left', raisedKnee: 2.5 })).toThrow(/бедро/)
  })

  test('стопа, не достающая до колена опорной ноги, — отказ с подсказкой', () => {
    expect(() => kinematics({ support: 'left', footToKnee: 0.1 })).toThrow(/колена опорной ноги/)
  })

  test('боковые состояния и боковой наклон в профиль не выражаются', () => {
    expect(() => kinematics({ orientation: 'profile', nearShoulder: 'side' })).toThrow(/профил/)
    expect(() =>
      kinematics({ orientation: 'profile', nearElbow: 'bent', nearForearm: 'in' }),
    ).toThrow(/профил/)
    expect(() => kinematics({ orientation: 'profile', lean: 'lean-left' })).toThrow(/профил/)
  })
})

describe('оба потребителя берут форму отсюда', () => {
  test('кинематика ничего не знает о кадре и о рисунке', () => {
    // Ни `aspect`, ни `torso`, ни масштаб рисунка сюда не доезжают: на одном и
    // том же описании суставы одни и те же, а переводят их в свои координаты
    // потребители. Иначе у формы снова стало бы два владельца.
    const a = kinematics({ legs: 'wide', leftShoulder: 'up' })
    const b = kinematics({ legs: 'wide', leftShoulder: 'up' })
    expect(a.wrist.left).toEqual(b.wrist.left)
    expect(a.ankle.left).toEqual(b.ankle.left)
  })
})
