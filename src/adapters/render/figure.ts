/**
 * Укладка фигуры позы в прямоугольник экрана — ОДНА для превью и для маски
 * выреза.
 *
 * Форму считает ядро (`core/figure.ts` поверх `core/kinematics.ts`) в долях
 * торса; здесь она только переводится в пиксели. Второго места, где фигура
 * строится, в игре нет: две копии разъехались бы, и ребёнок не попадал бы в
 * вырез, который видит.
 *
 * Разбор: `docs/render-and-layout.md`, `docs/poses-and-figure.md`.
 */

import type { Figure } from '../../core/figure'
import type { Pt } from '../../core/types'

/** Числа рендера. В `CONFIG` им не место: ядро об экране не знает. */
export const RENDER = Object.freeze({
  /**
   * Буфер фиксированный, DPR игнорируется: картинка всё равно уезжает
   * зеркалированием на телевизор 16:9, и платить за буфер по плотности
   * телефона нечем.
   */
  width: 1280,
  height: 720,

  /**
   * Толщина штриха фигуры в долях ТОРСА, а не в пикселях: фигура вписывается в
   * разные прямоугольники (маленькое превью, стена во весь экран), и штрих
   * обязан расти вместе с ней. В пикселях он был бы волоском на большой стене
   * и кляксой на превью.
   *
   * Значение выбрано толще конечности ребёнка (рука около 0.15 S), чтобы вырез
   * был проходим, и тоньше торса (0.86 S в плечах), чтобы фигура осталась
   * фигурой, а не пятном.
   */
  strokeS: 0.3,

  /** Доля отведённого прямоугольника, которую занимает фигура. */
  figureFill: 0.9,

  /**
   * Запас на overscan телевизора: критичный HUD живёт внутри центральной
   * области 16:9, уменьшенной на эту долю с каждой стороны. За её пределами
   * очки и остаток времени окажутся в полосе.
   */
  overscan: 0.05,
})

export type Box = { x: number; y: number; w: number; h: number }

/** Фигура в пикселях: та же форма, что у ядра, только уложенная. */
export type Placed = {
  head: { c: Pt; r: number }
  bones: Array<[Pt, Pt]>
  /** Толщина штриха в пикселях — ею же рисуется и маска выреза. */
  stroke: number
  /**
   * Укладывает точку, заданную В ДОЛЯХ ТОРСА от середины бёдер: `(0,0)` — сами
   * бёдра, `(0,−1)` — середина плеч.
   *
   * Нужна силуэту игрока: живой скелет обязан лечь НА вырез, то есть пройти
   * ровно то же преобразование, что и фигура. Своя арифметика у силуэта — это
   * уже допущенный однажды дефект: точки раскладывались прямо по прямоугольнику
   * стены, и подсказка «куда доворачивать» показывала не туда.
   *
   * Доли торса, а не координаты фигуры: `figure()` отдаёт кадрово-нормированные
   * числа со своим началом и масштабом, и снаружи их знать незачем. Доли торса
   * же — единственная система, общая у фигуры и у живого скелета.
   */
  torsoToPx(p: Pt): Pt
}

/**
 * Центральная область 16:9 с запасом на overscan.
 *
 * Буфер уже 16:9, так что область — это он сам, уменьшенный на запас. Отдельная
 * функция, а не два числа в HUD, потому что её проверяет тест: HUD, уехавший в
 * полосу, на телефоне не виден вовсе — виден он только на телевизоре.
 */
export function safeArea(): Box {
  const dx = RENDER.width * RENDER.overscan
  const dy = RENDER.height * RENDER.overscan
  return { x: dx, y: dy, w: RENDER.width - dx * 2, h: RENDER.height - dy * 2 }
}

/**
 * Вписывает фигуру в `box`, сохраняя пропорции.
 *
 * Масштаб считается по габаритам фигуры ВМЕСТЕ со штрихом и радиусом головы:
 * иначе рука, уложенная ровно по краю, вылезала бы за прямоугольник на
 * половину штриха и рисовалась бы поверх HUD.
 */
export function placeFigure(f: Figure, box: Box): Placed {
  // Габариты в долях торса, уже с запасом на штрих и голову.
  const half = RENDER.strokeS / 2
  let minX = f.head.c.x - f.head.r
  let maxX = f.head.c.x + f.head.r
  let minY = f.head.c.y - f.head.r
  let maxY = f.head.c.y + f.head.r
  for (const [a, b] of f.bones) {
    minX = Math.min(minX, a.x - half, b.x - half)
    maxX = Math.max(maxX, a.x + half, b.x + half)
    minY = Math.min(minY, a.y - half, b.y - half)
    maxY = Math.max(maxY, a.y + half, b.y + half)
  }

  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const k = (Math.min(box.w / spanX, box.h / spanY) * RENDER.figureFill) / 1

  // Центрируем по прямоугольнику: фигура — предмет внимания, а не угловой знак.
  const offX = box.x + box.w / 2 - ((minX + maxX) / 2) * k
  const offY = box.y + box.h / 2 - ((minY + maxY) / 2) * k
  const to = (p: Pt): Pt => ({ x: offX + p.x * k, y: offY + p.y * k })

  /*
   * Торс самой фигуры: `bones[0]` — это `[середина бёдер, середина плеч]` (см.
   * порядок костей в `core/figure.ts`). Из него берутся начало и масштаб для
   * пересчёта долей торса.
   */
  const [figHip, figShoulder] = f.bones[0]
  const figS = Math.hypot(figShoulder.x - figHip.x, figShoulder.y - figHip.y) || 1

  return {
    head: { c: to(f.head.c), r: f.head.r * k },
    bones: f.bones.map(([a, b]): [Pt, Pt] => [to(a), to(b)]),
    stroke: RENDER.strokeS * k,
    torsoToPx: (p) => to({ x: figHip.x + p.x * figS, y: figHip.y + p.y * figS }),
  }
}

/**
 * Рисует фигуру: голову — ЗАЛИВКОЙ, кости — толстым штрихом с круглыми
 * концами.
 *
 * Два разных действия, а не один путь: голова — диск, и обведённая по контуру
 * она дала бы в вырезе кольцо, через которое не пройти. Цвета берутся
 * выставленными снаружи — в маске выреза они не значат ничего
 * (`destination-out` стирает), а в превью это цвет фигуры.
 *
 * ОДНА функция на превью и на вырез — здесь и держится инвариант «форма одна».
 */
export function paintFigure(ctx: CanvasRenderingContext2D, p: Placed): void {
  ctx.lineWidth = p.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.beginPath()
  for (const [a, b] of p.bones) {
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
  }
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(p.head.c.x, p.head.c.y, p.head.r, 0, Math.PI * 2)
  ctx.fill()
}
