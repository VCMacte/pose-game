/**
 * Стена с вырезом и пол, по которому видно движение.
 *
 * Разбор: `docs/render-and-layout.md`.
 */

import { figure } from '../../core/figure'
import type { PoseSpec } from '../../core/types'
import { RENDER, paintFigure, placeFigure } from './figure'
import type { Box, Placed } from './figure'

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

/** Слой с альфой, на котором собирается стена с вырезом. */
export type Layer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }

/**
 * Стена с вырезом по фигуре позы.
 *
 * **Вырез собирается на ОТДЕЛЬНОМ слое, а не выжигается в кадре, и это не
 * перестраховка.** Главный контекст просят без альфы (`alpha: false`) — так
 * дешевле, и так задумано, — а в буфере без альфы `destination-out` не делает
 * прозрачности вовсе: альфа принудительно единица, и «стёртое» композитится
 * ЧЁРНЫМ. Вырез вышел бы чёрной дырой вместо коридора, по которому едет стена.
 * Хуже того, стирание в кадре съело бы и уже нарисованный пол: отсечение по
 * прямоугольнику стены удерживает `destination-out` лишь от того, чтобы грызть
 * ВНЕ стены, а внутри него пол исчезает вместе со стеной.
 *
 * Это уже допущенный однажды дефект; отменяемое рассуждение гласило, что
 * заливать вырез цветом фона «проще и неверно, потому что фон под стеной
 * разный на каждом кадре». Верно в нём только то, что заливать фоном нельзя;
 * неверен вывод, будто поэтому годится стирание в кадре.
 *
 * Слой создаётся ОДИН раз на рендер и переиспользуется: по кадру на забег их
 * было бы сорок в секунду. Поэтому перед сборкой он очищается — иначе стена
 * прошлого кадра осталась бы под нынешней и просвечивала бы в вырезе.
 */
export function drawWall(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  spec: PoseSpec,
  wallZ: number,
  verdict?: 'hit' | 'miss' | 'skip',
): Placed {
  const box = wallBox(wallZ)
  const lx = layer.ctx
  // Укладка считается ОДИН раз и отдаётся наружу: силуэт игрока обязан лечь
  // тем же преобразованием, а не своим.
  const placed = placeFigure(figure(spec), box)

  lx.save()
  // Очищается только прямоугольник стены: чистить весь буфер каждый кадр
  // незачем, за его пределами слой и не рисуется.
  lx.clearRect(box.x, box.y, box.w, box.h)
  lx.fillStyle = verdict ? PALETTE[verdict] : PALETTE.wall
  lx.fillRect(box.x, box.y, box.w, box.h)

  // Отсечение по стене оставлено: оно удерживает штрих фигуры, выходящий за
  // край прямоугольника, от стирания соседних областей слоя.
  lx.beginPath()
  lx.rect(box.x, box.y, box.w, box.h)
  lx.clip()
  lx.globalCompositeOperation = 'destination-out'
  lx.fillStyle = '#000'
  lx.strokeStyle = '#000'
  paintFigure(lx, placed)
  lx.globalCompositeOperation = 'source-over'
  lx.restore()

  // Готовая стена переносится в кадр поверх пола: сквозь вырез виден пол, а не
  // чёрное.
  ctx.drawImage(layer.canvas, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h)
  return placed
}

/** Превью позы: та же фигура, нарисованная штрихом, без стены. */
export function drawPreview(ctx: CanvasRenderingContext2D, spec: PoseSpec, box: Box): void {
  ctx.save()
  ctx.fillStyle = PALETTE.figure
  ctx.strokeStyle = PALETTE.figure
  paintFigure(ctx, placeFigure(figure(spec), box))
  ctx.restore()
}
