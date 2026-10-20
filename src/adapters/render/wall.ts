/**
 * Стена с вырезом и пол, по которому видно движение.
 *
 * Разбор: `docs/render-and-layout.md`.
 */

import { figure } from '../../core/figure'
import type { PoseSpec } from '../../core/types'
import { RENDER, paintFigure, placeFigure } from './figure'
import type { Box } from './figure'

/** Цвета. Плоские и контрастные: зеркалирование съедает полутона. */
export const PALETTE = Object.freeze({
  far: '#0b1020',
  floor: '#172038',
  floorLine: '#2a3a63',
  wall: '#8d96b5',
  /**
   * Цвета приговора. `skip` НЕЙТРАЛЕН намеренно и не похож на `miss`: ребёнок,
   * получивший цвет провала за раунд, который игра не судила, не понимает,
   * почему проиграл, — а это худший класс дефекта здесь.
   */
  hit: '#3ddc84',
  miss: '#ff5a5a',
  skip: '#8d96b5',
  figure: '#ffffff',
  text: '#ffffff',
})

/** Горизонт: доля высоты буфера, выше которой — дальняя тьма. */
const HORIZON = 0.42

/** Сколько поперечных линий пола. Зазор у горизонта — минимальный из конфига. */
const FLOOR_LINES = 10

/**
 * Пол с поперечными линиями. Ощущение движения несут именно они: персонажа на
 * экране нет, вид от первого лица, и двигаться визуально больше нечему.
 *
 * `phase` сдвигает линии: стоящий пол при едущей стене читается как «стена
 * летит сама», а не «я иду».
 */
export function drawFloor(ctx: CanvasRenderingContext2D, wallZ: number): void {
  const hy = RENDER.height * HORIZON

  ctx.fillStyle = PALETTE.far
  ctx.fillRect(0, 0, RENDER.width, hy)
  ctx.fillStyle = PALETTE.floor
  ctx.fillRect(0, hy, RENDER.width, RENDER.height - hy)

  ctx.strokeStyle = PALETTE.floorLine
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let i = 0; i < FLOOR_LINES; i++) {
    /*
     * Квадратичный шаг, а не равномерный: равномерные линии в перспективе
     * читаются как лестница, а не как уходящий пол. Сдвиг на `wallZ` даёт
     * линиям ехать на игрока вместе со стеной.
     */
    const f = (i + (wallZ % 1)) / FLOOR_LINES
    const y = hy + (RENDER.height - hy) * f * f
    ctx.moveTo(0, y)
    ctx.lineTo(RENDER.width, y)
  }
  ctx.stroke()
}

/** Прямоугольник стены при приближении `wallZ` ∈ (0, 1]. */
export function wallBox(wallZ: number): Box {
  /*
   * `wallZ` — доля пути до игрока: 0 у горизонта, 1 у экрана. Стена растёт от
   * маленького прямоугольника у горизонта до полного экрана, и рост этот
   * НЕЛИНЕЙНЫЙ — перспектива ускоряется к концу, иначе последние метры
   * выглядят медленнее первых, хотя стена идёт равномерно.
   */
  const z = Math.max(0, Math.min(1, wallZ))
  const k = 0.08 + 0.92 * z * z
  const w = RENDER.width * k
  const h = RENDER.height * k
  const hy = RENDER.height * HORIZON
  // Центр стены съезжает от горизонта к центру экрана вместе с приближением.
  const cy = hy + (RENDER.height / 2 - hy) * z
  return { x: (RENDER.width - w) / 2, y: cy - h / 2, w, h }
}

/**
 * Стена с вырезом по фигуре позы.
 *
 * Вырез делается `destination-out` по ТОЙ ЖЕ фигуре, что рисует превью. Залить
 * вырез цветом фона было бы проще и неверно: стена приезжает поверх пола, и
 * «фон» под ней разный на каждом кадре.
 */
export function drawWall(
  ctx: CanvasRenderingContext2D,
  spec: PoseSpec,
  wallZ: number,
  verdict?: 'hit' | 'miss' | 'skip',
): void {
  const box = wallBox(wallZ)

  ctx.save()
  ctx.fillStyle = verdict ? PALETTE[verdict] : PALETTE.wall
  ctx.fillRect(box.x, box.y, box.w, box.h)

  /*
   * Вырез — только внутри прямоугольника стены: без отсечения `destination-out`
   * прогрыз бы и пол с дальней тьмой, и на экране получилась бы дыра в мире.
   */
  ctx.beginPath()
  ctx.rect(box.x, box.y, box.w, box.h)
  ctx.clip()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.strokeStyle = '#000'
  paintFigure(ctx, placeFigure(figure(spec), box))
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
}

/** Превью позы: та же фигура, нарисованная штрихом, без стены. */
export function drawPreview(ctx: CanvasRenderingContext2D, spec: PoseSpec, box: Box): void {
  ctx.save()
  ctx.fillStyle = PALETTE.figure
  ctx.strokeStyle = PALETTE.figure
  paintFigure(ctx, placeFigure(figure(spec), box))
  ctx.restore()
}
