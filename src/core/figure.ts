import { CONFIG } from './config'
import { kinematics } from './kinematics'
import type { Pt, PoseSpec } from './types'

/**
 * Схематичная фигура позы: окружность головы и звенья скелета.
 *
 * Координаты нормированы в `0..1` и лежат в КВАДРАТНОЙ области: масштаб по
 * обеим осям один, иначе фигура растягивалась бы вместе с рамкой. `y` растёт
 * вниз — как у кадра MediaPipe и у холста. Куда положить этот квадрат, решает
 * тот, кто рисует (превью или маска выреза).
 *
 * Порядок `bones` — часть контракта: торс, плечи, бёдра, левая рука (плечо,
 * предплечье), правая рука, левая нога (бедро, голень, стопа), правая нога,
 * шея. Первые тринадцать выражены теми же точками, что MediaPipe, — на этом
 * стоит проверка «картинка → скелет → приговор»; шея упирается в окружность
 * головы.
 */
export type Figure = {
  head: { c: Pt; r: number }
  bones: Array<[Pt, Pt]>
}

const F = CONFIG.figure

/**
 * Куда смотрит профильная фигура: в `+x`, то есть вправо по кадру.
 *
 * Сторона выбрана, а не выведена: зеркала у профильной позы нет, потому что
 * `near`/`far` отсчитываются ОТ КАМЕРЫ, и повёрнутая в другую сторону поза
 * даёт судейству те же показания осей. Следствие принято сознательно —
 * профильная поза РИСУЕТСЯ в одну сторону, а ПРИНИМАЕТСЯ в любую.
 */
const PROFILE_FACING = 'right'

/**
 * Фигура позы: та же кинематика ядра, переведённая в координаты рисования.
 *
 * **Единственный источник формы — и для превью, и для маски выреза.** Две
 * копии геометрии разъехались бы, и ребёнок не попадал бы в вырез, который
 * видит; у препятствия ровно тот же инвариант — число, по которому судят, и
 * форма, которую рисуют, берутся из одного места.
 *
 * Сама форма здесь не считается: её считает `kinematics()` в долях торса, и
 * оттуда же её берёт синтетический скелет `fake/stick.ts`. Поэтому второго
 * места, где записана длина бедра, в игре нет вовсе — ни соглашения о сгибе
 * колена, ни о сведении кистей дублировать больше нечем. Этой функции
 * остаётся рамка: масштаб и якорь.
 *
 * Ось, которую поза не требует, берётся в нейтральном состоянии: ноги вместе,
 * опора на двух, корпус прямо, колени прямые, плечи вниз, локти прямые.
 */
export function figure(spec: PoseSpec): Figure {
  const j = kinematics({
    ...spec.requires,
    orientation: spec.orientation,
    facing: PROFILE_FACING,
  })

  // --- голова и шея -------------------------------------------------------
  const headCenter = j.head(F.headUp, 0, 0)
  /** Низ окружности головы: в него упирается шея. */
  const headBottom = {
    x: headCenter.x - j.up.x * F.headRadius,
    y: headCenter.y - j.up.y * F.headRadius,
  }

  const bones: Array<[Pt, Pt]> = [
    [j.hipMid, j.shoulderMid],
    [j.shoulder.left, j.shoulder.right],
    [j.hip.left, j.hip.right],
    [j.shoulder.left, j.elbow.left],
    [j.elbow.left, j.wrist.left],
    [j.shoulder.right, j.elbow.right],
    [j.elbow.right, j.wrist.right],
    [j.hip.left, j.knee.left],
    [j.knee.left, j.ankle.left],
    [j.ankle.left, j.toe.left],
    [j.hip.right, j.knee.right],
    [j.knee.right, j.ankle.right],
    [j.ankle.right, j.toe.right],
    [j.shoulderMid, headBottom],
  ]

  // --- рамка --------------------------------------------------------------
  // Масштаб ОДИН для всех поз, поэтому рамка только сдвигает фигуру: по
  // горизонтали — центром тела (той же точкой, по которой камера судит
  // центровку игрока) в середину, по вертикали — самой нижней точкой на пол.
  const bodyCenter = {
    x: (j.hipMid.x + j.shoulderMid.x) / 2,
    y: (j.hipMid.y + j.shoulderMid.y) / 2,
  }
  const lowest = Math.max(headCenter.y + F.headRadius, ...bones.flatMap(([a, b]) => [a.y, b.y]))
  const pad = F.stroke / 2
  const place = (p: Pt): Pt => ({
    x: 0.5 + (p.x - bodyCenter.x) * F.scale,
    y: 1 - pad - (lowest - p.y) * F.scale,
  })

  return {
    head: { c: place(headCenter), r: F.headRadius * F.scale },
    bones: bones.map(([a, b]) => [place(a), place(b)]),
  }
}
