import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { figure, type Figure } from '../../src/core/figure'
import { LM, pointAt } from '../../src/core/landmarks'
import { POSES } from '../../src/core/poses'
import type { Landmarks, Pt, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Порядок звеньев в `Figure.bones` — часть контракта: первые тринадцать
 * выражены точками MediaPipe и потому сверяются с `stick()` поимённо, а шея
 * упирается в окружность головы, которой у скелета нет.
 */
const B = {
  torso: 0,
  shoulders: 1,
  hips: 2,
  leftUpperArm: 3,
  leftForearm: 4,
  rightUpperArm: 5,
  rightForearm: 6,
  leftThigh: 7,
  leftShin: 8,
  leftFoot: 9,
  rightThigh: 10,
  rightShin: 11,
  rightFoot: 12,
  neck: 13,
} as const

const BONE_COUNT = 14
/** Сколько звеньев фигуры выражено точками скелета — все, кроме шеи. */
const BONES_FROM_LANDMARKS = BONE_COUNT - 1

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Единицы `stick()`, в которых координаты точки РАВНЫ долям торса: квадратный
 * кадр (`aspect: 1`) и торс длиной 1 убирают оба масштаба проекции сразу.
 */
const S_UNITS: Partial<StickDesc> = { aspect: 1, torso: 1, x: 0, ground: 0 }

/** Скелет той же позы: требования уходят в фикстуру как есть. */
const skeleton = (p: PoseSpec): Landmarks =>
  stick({ ...S_UNITS, orientation: p.orientation, ...p.requires })

const at = (lm: Landmarks, i: number): Pt => {
  const p = pointAt(lm, i)
  return { x: p.x, y: p.y }
}

/** Те же тринадцать звеньев, собранные из точек скелета. */
function skeletonBones(lm: Landmarks): Array<[Pt, Pt]> {
  const hipMid = mid(at(lm, LM.leftHip), at(lm, LM.rightHip))
  const shoulderMid = mid(at(lm, LM.leftShoulder), at(lm, LM.rightShoulder))
  return [
    [hipMid, shoulderMid],
    [at(lm, LM.leftShoulder), at(lm, LM.rightShoulder)],
    [at(lm, LM.leftHip), at(lm, LM.rightHip)],
    [at(lm, LM.leftShoulder), at(lm, LM.leftElbow)],
    [at(lm, LM.leftElbow), at(lm, LM.leftWrist)],
    [at(lm, LM.rightShoulder), at(lm, LM.rightElbow)],
    [at(lm, LM.rightElbow), at(lm, LM.rightWrist)],
    [at(lm, LM.leftHip), at(lm, LM.leftKnee)],
    [at(lm, LM.leftKnee), at(lm, LM.leftAnkle)],
    [at(lm, LM.leftAnkle), at(lm, LM.leftFootIndex)],
    [at(lm, LM.rightHip), at(lm, LM.rightKnee)],
    [at(lm, LM.rightKnee), at(lm, LM.rightAnkle)],
    [at(lm, LM.rightAnkle), at(lm, LM.rightFootIndex)],
  ]
}

/**
 * Форма без рамки: доли торса, отсчитанные от его середины. Ровно то, что
 * обязано совпадать у фигуры и у скелета, — рамку (масштаб кадра и якорь)
 * сравнение снимает, потому что у скелета её нет вовсе.
 */
function toS(bones: Array<[Pt, Pt]>): (p: Pt) => Pt {
  const [hipMid, shoulderMid] = bones[B.torso]
  const c = mid(hipMid, shoulderMid)
  const s = dist(hipMid, shoulderMid)
  return (p: Pt): Pt => ({ x: (p.x - c.x) / s, y: (p.y - c.y) / s })
}

const pointsOf = (bones: Array<[Pt, Pt]>): Pt[] => {
  const norm = toS(bones)
  return bones.flatMap(([a, b]) => [norm(a), norm(b)])
}

/** Разнос пары точек фигуры в долях её торса. */
function spanInS(f: Figure, a: Pt, b: Pt): number {
  const [hipMid, shoulderMid] = f.bones[B.torso]
  return dist(a, b) / dist(hipMid, shoulderMid)
}

const byId = (id: string): PoseSpec => {
  const p = POSES.find((q) => q.id === id)
  if (p === undefined) throw new Error(`в наборе нет позы ${id}`)
  return p
}

/** Все нарисованные точки, включая габариты окружности головы. */
function extremes(f: Figure): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = f.bones.flatMap(([a, b]) => [a.x, b.x])
  const ys = f.bones.flatMap(([a, b]) => [a.y, b.y])
  xs.push(f.head.c.x - f.head.r, f.head.c.x + f.head.r)
  ys.push(f.head.c.y - f.head.r, f.head.c.y + f.head.r)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

/** Фигура целиком в `0..1` с запасом на половину штриха с каждой стороны. */
function withinBounds(f: Figure, stroke: number): boolean {
  const e = extremes(f)
  const pad = stroke / 2
  return e.minX >= pad && e.maxX <= 1 - pad && e.minY >= pad && e.maxY <= 1 - pad
}

describe('фигура позы', () => {
  test('«Звезда»: стопы разведены шире плеч, кисти выше плеч и разведены', () => {
    const f = figure(byId('star'))
    const leftAnkle = f.bones[B.leftShin][1]
    const rightAnkle = f.bones[B.rightShin][1]
    const [leftShoulder, rightShoulder] = f.bones[B.shoulders]
    const leftWrist = f.bones[B.leftForearm][1]
    const rightWrist = f.bones[B.rightForearm][1]
    const shoulders = Math.abs(leftShoulder.x - rightShoulder.x)

    expect(Math.abs(leftAnkle.x - rightAnkle.x)).toBeGreaterThan(shoulders)
    // `y` растёт вниз: «выше» — значит меньше.
    expect(leftWrist.y).toBeLessThan(leftShoulder.y)
    expect(rightWrist.y).toBeLessThan(rightShoulder.y)
    expect(Math.abs(leftWrist.x - rightWrist.x)).toBeGreaterThan(shoulders)
  })

  test('«Космическая ракета»: кисти сходятся выше головы', () => {
    const f = figure(byId('rocket'))
    const leftWrist = f.bones[B.leftForearm][1]
    const rightWrist = f.bones[B.rightForearm][1]

    expect(dist(leftWrist, rightWrist)).toBeLessThan(f.head.r)
    expect(leftWrist.y).toBeLessThan(f.head.c.y - f.head.r)
    expect(rightWrist.y).toBeLessThan(f.head.c.y - f.head.r)
  })

  test('«Плоский Робот» и его зеркало — отражения друг друга по x', () => {
    const origin = figure(byId('robot'))
    const mirror = figure(byId('robot-mirror'))

    expect(mirror.bones).toHaveLength(origin.bones.length)
    expect(mirror.head.r).toBeCloseTo(origin.head.r, 12)
    expect(mirror.head.c.x).toBeCloseTo(1 - origin.head.c.x, 12)
    expect(mirror.head.c.y).toBeCloseTo(origin.head.c.y, 12)

    // Зеркало переставляет и стороны тела: левое звено оригинала отражается в
    // правое звено зеркала.
    const pairs: Array<[number, number]> = [
      [B.torso, B.torso],
      [B.leftUpperArm, B.rightUpperArm],
      [B.leftForearm, B.rightForearm],
      [B.leftThigh, B.rightThigh],
      [B.leftShin, B.rightShin],
      [B.leftFoot, B.rightFoot],
      [B.neck, B.neck],
    ]
    for (const [a, b] of pairs) {
      for (const end of [0, 1] as const) {
        expect(mirror.bones[b][end].x, `${a}→${b}.${end}.x`).toBeCloseTo(
          1 - origin.bones[a][end].x,
          12,
        )
        expect(mirror.bones[b][end].y, `${a}→${b}.${end}.y`).toBeCloseTo(origin.bones[a][end].y, 12)
      }
    }
  })

  test('профильная поза рисуется в профиль: плечи сходятся по x', () => {
    const front = figure(byId('tee'))
    const frontGap = spanInS(front, front.bones[B.shoulders][0], front.bones[B.shoulders][1])

    for (const p of POSES.filter((q) => q.orientation === 'profile')) {
      const f = figure(p)
      const [left, right] = f.bones[B.shoulders]
      const gap = spanInS(f, left, right)
      expect(gap, p.id).toBeCloseTo(frontGap * CONFIG.figure.profileLateral, 6)
      expect(gap, p.id).toBeLessThan(frontGap / 2)
    }
  })

  test('профильная поза смотрит в +x: носки вперёд, вынос руки и наклон — туда же', () => {
    // Зеркала у профильной позы нет, поэтому сторона выбрана, а не выведена:
    // рисуется поворот в `+x`, принимается любой. Ближняя к камере сторона при
    // взгляде в `+x` — правая.
    for (const p of POSES.filter((q) => q.orientation === 'profile')) {
      const f = figure(p)
      expect(f.bones[B.leftFoot][1].x, p.id).toBeGreaterThan(f.bones[B.leftFoot][0].x)
      expect(f.bones[B.rightFoot][1].x, p.id).toBeGreaterThan(f.bones[B.rightFoot][0].x)
    }

    // «Египетский рисунок»: ближняя рука вынесена ВПЕРЁД (`nearShoulder: front`).
    const egypt = figure(byId('egypt'))
    expect(egypt.bones[B.rightForearm][1].x).toBeGreaterThan(egypt.bones[B.shoulders][1].x)

    // «Острый угол»: корпус наклонён горизонтально — вперёд, в сторону взгляда.
    const arrow = figure(byId('arrow'))
    expect(arrow.bones[B.torso][1].x).toBeGreaterThan(arrow.bones[B.torso][0].x)
    expect(arrow.head.c.x).toBeGreaterThan(arrow.bones[B.torso][0].x)
  })

  test('фигура любой позы целиком внутри 0..1 с запасом на штрих', () => {
    for (const p of POSES) {
      const f = figure(p)
      expect(withinBounds(f, CONFIG.figure.stroke), p.id).toBe(true)
      // Одних границ мало: нижнюю фигура задевает по построению (ею она
      // поставлена на пол), и уехавший вниз масштаб прошёл бы проверку тем,
      // что рисует фигуру размером с точку. Поэтому заодно — что она занимает
      // область, а не выродилась.
      const e = extremes(f)
      expect(e.maxY - e.minY, p.id).toBeGreaterThan(0.5)
      expect(e.maxX - e.minX, p.id).toBeGreaterThan(0.1)
    }
  })

  test('у каждой позы ровно четырнадцать звеньев, и шея упирается в голову', () => {
    for (const p of POSES) {
      const f = figure(p)
      expect(f.bones, p.id).toHaveLength(BONE_COUNT)
      const [shoulderMid, headBottom] = f.bones[B.neck]
      expect(shoulderMid, p.id).toEqual(f.bones[B.torso][1])
      expect(dist(headBottom, f.head.c), p.id).toBeCloseTo(f.head.r, 12)
    }
  })
})

describe('один источник формы', () => {
  test('форма фигуры совпадает с синтетическим скелетом звено в звено', () => {
    for (const p of POSES) {
      const got = pointsOf(figure(p).bones.slice(0, BONES_FROM_LANDMARKS))
      const want = pointsOf(skeletonBones(skeleton(p)))
      expect(got.length, p.id).toBe(want.length)
      // Точнее сверить нельзя: скелет отдаёт точки во Float32Array, и его
      // собственная точность — около 1e-7. Разъехавшееся соглашение видно на
      // порядок 0.1 S, то есть этот допуск строже нужного в десятки тысяч раз.
      for (let i = 0; i < want.length; i++) {
        expect(got[i].x, `${p.id} точка ${i}.x`).toBeCloseTo(want[i].x, 5)
        expect(got[i].y, `${p.id} точка ${i}.y`).toBeCloseTo(want[i].y, 5)
      }
    }
  })

  test('окружность головы накрывает лицо скелета', () => {
    const FACE = [
      LM.nose,
      LM.leftEyeInner,
      LM.leftEye,
      LM.leftEyeOuter,
      LM.rightEyeInner,
      LM.rightEye,
      LM.rightEyeOuter,
      LM.leftEar,
      LM.rightEar,
      LM.mouthLeft,
      LM.mouthRight,
    ]
    for (const p of POSES) {
      const f = figure(p)
      const normFigure = toS(f.bones)
      const headC = normFigure(f.head.c)
      const headR = f.head.r / dist(f.bones[B.torso][0], f.bones[B.torso][1])

      const lm = skeleton(p)
      const normSkeleton = toS(skeletonBones(lm))
      for (const i of FACE) {
        const q = normSkeleton(at(lm, i))
        expect(dist(q, headC), `${p.id} точка ${i}`).toBeLessThanOrEqual(headR)
      }
    }
  })

  test('разнос колен приседающей фигуры — тот же, что у скелета, и в своей полосе', () => {
    for (const id of ['barrier', 'crab']) {
      const p = byId(id)
      const f = figure(p)
      const kneeGap = spanInS(f, f.bones[B.leftThigh][1], f.bones[B.rightThigh][1])

      const bones = skeletonBones(skeleton(p))
      const want =
        dist(bones[B.leftThigh][1], bones[B.rightThigh][1]) /
        dist(bones[B.torso][0], bones[B.torso][1])

      expect(kneeGap, id).toBeCloseTo(want, 5)
      // Полосы `legs.knee` выведены из этой же кинематики: нарисованный присед
      // обязан попадать в ту полосу, которую поза требует (`legs: wide`).
      expect(kneeGap, id).toBeGreaterThanOrEqual(CONFIG.legs.knee.wideMin)
      expect(kneeGap, id).toBeLessThanOrEqual(CONFIG.legs.knee.wideMax)
    }
  })
})

describe('CONFIG.figure', () => {
  test('несёт геометрию фигуры и толщину штриха', () => {
    expect(CONFIG.figure.thigh).toBe(CONFIG.figure.shin)
    expect(CONFIG.figure.stroke).toBeGreaterThan(0)
    expect(CONFIG.figure.scale).toBeGreaterThan(0)
    expect(CONFIG.figure.profileLateral).toBeGreaterThan(0)
    expect(CONFIG.figure.profileLateral).toBeLessThan(1)
  })
})
