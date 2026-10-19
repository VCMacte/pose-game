import { describe, expect, test } from 'vitest'
import { axes, type Axis } from '../../src/core/axes'
import { CONFIG } from '../../src/core/config'
import { figure, type Figure } from '../../src/core/figure'
import { geometry } from '../../src/core/geometry'
import { LANDMARK_STRIDE, LM, pointAt } from '../../src/core/landmarks'
import { POSES } from '../../src/core/poses'
import type { Calibration, Landmarks, Pt, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Порядок звеньев в `Figure.bones` — часть контракта: первые тринадцать
 * выражены точками MediaPipe и потому читаются в скелет поимённо (см.
 * `DRAWN`), а шея упирается в окружность головы, которой у скелета нет.
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

  test('каждая зеркальная поза — отражение своего оригинала по x', () => {
    // Все зеркальные пары, а не одна: у «Наклонной башни» и «Рок-звезды»
    // корпус наклонён, и тогда плечи с бёдрами уже не симметричны
    // относительно средней линии — проверка накрест ниже только там и бьёт.
    for (const mirrored of POSES.filter((q) => q.mirror)) {
      const origin = POSES.find((q) => q.name === mirrored.name && !q.mirror)
      expect(origin, mirrored.id).toBeDefined()
      const a = figure(origin!)
      const b = figure(mirrored)
      const id = mirrored.id

      expect(b.bones, id).toHaveLength(a.bones.length)
      expect(b.head.r, id).toBeCloseTo(a.head.r, 12)
      expect(b.head.c.x, id).toBeCloseTo(1 - a.head.c.x, 12)
      expect(b.head.c.y, id).toBeCloseTo(a.head.c.y, 12)

      // Зеркало переставляет и стороны тела: левое звено оригинала отражается
      // в правое звено зеркала.
      const pairs: Array<[number, number]> = [
        [B.torso, B.torso],
        [B.leftUpperArm, B.rightUpperArm],
        [B.leftForearm, B.rightForearm],
        [B.leftThigh, B.rightThigh],
        [B.leftShin, B.rightShin],
        [B.leftFoot, B.rightFoot],
        [B.neck, B.neck],
      ]
      for (const [from, to] of pairs) {
        for (const end of [0, 1] as const) {
          expect(b.bones[to][end].x, `${id} ${from}→${to}.${end}.x`).toBeCloseTo(
            1 - a.bones[from][end].x,
            12,
          )
          expect(b.bones[to][end].y, `${id} ${from}→${to}.${end}.y`).toBeCloseTo(
            a.bones[from][end].y,
            12,
          )
        }
      }

      // Плечи и бёдра — единственные две кости, где зеркалирование
      // переставляет КОНЦЫ, а не отображает кость в кость: оба их конца лежат
      // на разных сторонах тела. Именно там и спряталась бы ошибка индекса,
      // поэтому их отдельно и накрест: конец `left` зеркала — отражение конца
      // `right` оригинала.
      for (const bone of [B.shoulders, B.hips]) {
        for (const end of [0, 1] as const) {
          const other = end === 0 ? 1 : 0
          expect(b.bones[bone][end].x, `${id} ${bone}.${end}.x накрест`).toBeCloseTo(
            1 - a.bones[bone][other].x,
            12,
          )
          expect(b.bones[bone][end].y, `${id} ${bone}.${end}.y накрест`).toBeCloseTo(
            a.bones[bone][other].y,
            12,
          )
        }
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

/**
 * Кадр, в котором судится нарисованная фигура. Числа — обычная дистанция до
 * камеры: торс 0.22 высоты кадра, тело в середине, пол под опорной стопой.
 */
const FRAME = { aspect: 16 / 9, torso: 0.22, x: 0.5, ground: 0.95 } as const

/** Калибровка по нейтральной стойке в том же кадре: ею судятся просадки приседа. */
function neutralCalibration(): Calibration {
  const lm = stick(FRAME)
  const g = geometry(lm, FRAME.aspect)
  if (g === null) throw new Error('нейтральная стойка не дала годной геометрии')
  return {
    S0: g.S,
    shoulderWidth: g.shoulderRatio * g.S,
    neutralX: g.cx,
    neutralShoulderY: g.shoulderMid.y,
    neutralHipY: g.hipMid.y,
    aspect: FRAME.aspect,
    at: 0,
  }
}

/** Пара звеньев фигуры → точка MediaPipe: чем именно нарисован каждый сустав. */
const DRAWN: Array<[number, number, 0 | 1]> = [
  [LM.leftShoulder, B.shoulders, 0],
  [LM.rightShoulder, B.shoulders, 1],
  [LM.leftHip, B.hips, 0],
  [LM.rightHip, B.hips, 1],
  [LM.leftElbow, B.leftUpperArm, 1],
  [LM.rightElbow, B.rightUpperArm, 1],
  [LM.leftWrist, B.leftForearm, 1],
  [LM.rightWrist, B.rightForearm, 1],
  [LM.leftKnee, B.leftThigh, 1],
  [LM.rightKnee, B.rightThigh, 1],
  [LM.leftAnkle, B.leftShin, 1],
  [LM.rightAnkle, B.rightShin, 1],
  [LM.leftFootIndex, B.leftFoot, 1],
  [LM.rightFootIndex, B.rightFoot, 1],
]

/**
 * Скелет, тело которого взято С КАРТИНКИ: двенадцать суставов и два носка
 * прочитаны из нарисованных звеньев и переложены в кадр.
 *
 * Перекладывается подобием, восстановленным по самой картинке: единица длины —
 * нарисованный торс, начало — нарисованная середина бёдер. Поэтому рамка
 * рисунка (её масштаб и якорь) из сравнения уходит — она и не судится, — а
 * форма остаётся ровно та, что видит ребёнок: разъехавшиеся масштабы по `x` и
 * `y`, зеркальный переворот или перепутанный сустав уедут в показания осей.
 *
 * Лицо, ладони и пятки доезжают от `stick()`: в фигуре их нет вовсе, а
 * `handsAxis` и `orientationAxis` без них не работают. Якорь по середине бёдер
 * оставляет тело там, куда его поставил скелет, — опорной стопой на полу, —
 * иначе просадки приседа судить было бы не от чего.
 */
function drawnSkeleton(p: PoseSpec): Landmarks {
  const f = figure(p)
  const out = Float32Array.from(stick({ ...FRAME, orientation: p.orientation, ...p.requires }))
  const [hipMidDrawn, shoulderMidDrawn] = f.bones[B.torso]
  const unitS = dist(hipMidDrawn, shoulderMidDrawn)
  const hipX = (out[LM.leftHip * LANDMARK_STRIDE] + out[LM.rightHip * LANDMARK_STRIDE]) / 2
  const hipY =
    (out[LM.leftHip * LANDMARK_STRIDE + 1] + out[LM.rightHip * LANDMARK_STRIDE + 1]) / 2

  for (const [lm, bone, end] of DRAWN) {
    const q = f.bones[bone][end]
    const base = lm * LANDMARK_STRIDE
    // `x` делится на отношение сторон — так его нормирует MediaPipe.
    out[base] = hipX + (((q.x - hipMidDrawn.x) / unitS) * FRAME.torso) / FRAME.aspect
    out[base + 1] = hipY + ((q.y - hipMidDrawn.y) / unitS) * FRAME.torso
  }
  return out
}

describe('картинка → скелет → приговор', () => {
  test('нарисованная фигура каждой позы читается судейством как её requires', () => {
    // Та самая цепочка, которую проходит ребёнок: он видит вырез, встаёт в
    // него, камера судит. Проверять её обязательно: сверять фигуру с
    // синтетическим скелетом стало нечем — кинематика у них одна, и такая
    // сверка сравнивала бы код с собой. Здесь же вторая сторона независима:
    // `axes()` ничего не знает о том, как поза построена, и читает только
    // картинку.
    const cal = neutralCalibration()
    let checked = 0

    for (const p of POSES) {
      const lm = drawnSkeleton(p)
      const g = geometry(lm, FRAME.aspect)
      expect(g, p.id).not.toBeNull()
      const readings = axes(lm, g!, cal, 1)

      // Ориентация в `requires` не живёт — её владелец `PoseSpec`, — но кадр не
      // с той ориентацией невалиден, и прочитаться она обязана.
      expect(readings.orientation.state, `${p.id}: ориентация`).toBe(p.orientation)
      checked += 1

      for (const [axis, want] of Object.entries(p.requires) as Array<[Axis, unknown]>) {
        const got = readings[axis]
        expect(got.state, `${p.id}: ось ${axis} (измерено ${got.measured.toFixed(2)})`).toBe(want)
        checked += 1
      }
    }

    // Сторож от вырожденного прогона: пустой `requires` или сломанный обход
    // дали бы зелёный тест, не проверив ничего.
    expect(checked).toBeGreaterThan(190)
  })
})

describe('один источник формы', () => {
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

  test('разнос колен нарисованного приседа лежит в полосе, которую поза требует', () => {
    // Со скелетом этот разнос больше не сверяется: кинематика у них одна, и
    // такая сверка сравнивала бы код с собой. Сверяется то, что НЕ выведено из
    // неё, — полосы `CONFIG.legs.knee`, по которым ось ног судит присед при
    // невидимых стопах. Разъехавшись с ними, нарисованный присед дал бы промах
    // ребёнку, повторившему его в точности.
    for (const id of ['barrier', 'crab']) {
      const f = figure(byId(id))
      const kneeGap = spanInS(f, f.bones[B.leftThigh][1], f.bones[B.rightThigh][1])
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
