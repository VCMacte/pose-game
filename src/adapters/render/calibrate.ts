/**
 * Экран калибровки: область, где надо стоять, поза, в которой надо стоять, и
 * живой силуэт игрока.
 *
 * **Почему он вообще есть.** Стадия калибровки не рисовала НИЧЕГО: `step`
 * отдавал `scene: null`, и пять секунд ребёнок смотрел в тёмный экран с одной
 * строкой текста. 22.10.2026 калибровка на телефоне трижды подряд не прошла, и
 * по журналу нельзя было установить даже того, стоял ли кто-нибудь перед
 * камерой: взрослому было нечем это увидеть. Смотреть в темноту и ждать —
 * непонятно и неприятно, а для ребёнка 7 лет это ещё и «игра не работает».
 *
 * **Силуэт здесь рисуется в координатах КАДРА, а не в долях торса** — и это
 * отличие от силуэта поверх выреза (`canvas.ts`), где вопрос другой: «как ты
 * стоишь относительно выреза». Здесь вопрос «ГДЕ ты в кадре», и ответ на него
 * имеет смысл только в кадре. Поэтому область, в которую надо встать, рисуется
 * тем же преобразованием: встать внутрь рамки на экране и значит попасть в
 * кадр так, как ждёт судейство.
 *
 * Картинка уходит на телевизор зеркалированием, поэтому никаких теней,
 * градиентов и фильтров — их съедает трансляция, а бюджет кадра они едят.
 *
 * Разбор: `docs/render-and-layout.md`, `docs/calibration.md`.
 */

import { CAMERA } from '../camera'
import type { Framing } from '../camera'
import { NEUTRAL_SPEC } from '../../core/poses'
import { figure } from '../../core/figure'
import type { Landmarks } from '../../core/types'
import { LANDMARK_COUNT, pointAt } from '../../core/landmarks'
import { RENDER, paintFigure, placeFigure, safeArea } from './figure'
import { PALETTE, drawFloor } from './wall'

export type CalibScene = {
  /** Живой скелет: что видит камера прямо сейчас. `null` — позы нет. */
  silhouette: Landmarks | null
  /** Отношение сторон кадра; без него силуэт не раскладывается. */
  aspect: number | null
  /** Кадрирование: заполнение кадра и годность — ими красится рамка. */
  framing: Framing
  /** Доля набранного времени стойки, `0..1`. */
  progress: number
}

/**
 * Цвета экрана калибровки.
 *
 * Годное кадрирование и негодное различаются ЦВЕТОМ рамки: взрослому у штатива
 * нужна обратная связь без чтения, да и ребёнок цвет замечает раньше текста.
 * Цвета берутся из общей палитры — второй набор разошёлся бы с игрой.
 */
const OK_COLOR = PALETTE.hit
const WAIT_COLOR = PALETTE.wall

/**
 * Доля ВЫСОТЫ области, которую должен занимать игрок.
 *
 * Та же полоса, по которой `framing()` судит кадрирование
 * (`CAMERA.fillMin..fillMax`), только нарисованная. Берётся середина полосы:
 * рамка показывает, куда встать, а не где граница допуска.
 */
const TARGET_FILL = (CAMERA.fillMin + CAMERA.fillMax) / 2

/** Прямоугольник-цель: куда встать, чтобы судейство видело игрока целиком. */
function targetBox(): { x: number; y: number; w: number; h: number } {
  const safe = safeArea()
  /*
   * Высота считается от БЕЗОПАСНОЙ области, а не от буфера, потому что точки
   * силуэта раскладываются по ней же: иначе «встал в рамку» и «заполнил кадр
   * как надо» были бы разными утверждениями, и рамка обещала бы не то, что
   * проверяет `framing()`.
   */
  const h = safe.h * TARGET_FILL
  /*
   * Ширина — по фигуре, а не по кадру: ребёнок встаёт в полный рост, и
   * вытянутые в стороны руки «Звезды» в эту рамку умещаться не обязаны. Доля
   * взята от высоты, чтобы рамка оставалась вертикальной на любом буфере.
   */
  const w = h * 0.62
  return { x: safe.x + (safe.w - w) / 2, y: safe.y + (safe.h - h) / 2, w, h }
}

export function drawCalibration(ctx: CanvasRenderingContext2D, s: CalibScene): void {
  // Тот же пол, что в забеге: экран калибровки — не другая игра.
  drawFloor(ctx, 0)

  const box = targetBox()
  const color = s.framing.ok ? OK_COLOR : WAIT_COLOR

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, RENDER.height * 0.008)
  ctx.strokeRect(box.x, box.y, box.w, box.h)
  ctx.restore()

  /*
   * Поза, в которой надо стоять, — нейтральная стойка, построенная ТОЙ ЖЕ
   * `figure()`, что и превью с вырезом. Второй рисунок «как стоять» разошёлся
   * бы с тем, по чему судят, а здесь он ещё и обещание: встань так — и забег
   * начнётся.
   */
  ctx.save()
  ctx.globalAlpha = 0.45
  ctx.fillStyle = PALETTE.figure
  ctx.strokeStyle = PALETTE.figure
  paintFigure(ctx, placeFigure(figure(NEUTRAL_SPEC), box))
  ctx.restore()

  drawFramePoints(ctx, s)
  drawProgress(ctx, s.progress, box, color)
}

/**
 * Живой силуэт точками, в координатах КАДРА.
 *
 * Без отношения сторон не рисуется вовсе — `x` нормирован по ширине, `y` по
 * высоте, и раскладка без поправки показывала бы уверенную неправду. Точками, а
 * не костями: схема соединений была бы второй копией анатомии рядом с
 * `kinematics()`.
 */
function drawFramePoints(ctx: CanvasRenderingContext2D, s: CalibScene): void {
  const lm = s.silhouette
  if (!lm || typeof s.aspect !== 'number') return

  ctx.save()
  ctx.fillStyle = PALETTE.figure
  ctx.globalAlpha = 0.9
  const r = Math.max(3, RENDER.height * 0.008)
  const safe = safeArea()
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = pointAt(lm, i)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    /*
     * Кадр раскладывается на ВСЮ область экрана, а рамка-цель — её часть:
     * тогда «попасть в рамку» на экране и значит «встать так, как ждёт
     * судейство». Зеркальность при фронтальной камере получается сама и
     * ребёнку привычна: он видит себя как в зеркале.
     */
    ctx.beginPath()
    ctx.arc(safe.x + p.x * safe.w, safe.y + p.y * safe.h, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Полоса ожидания: сколько ещё стоять. */
function drawProgress(
  ctx: CanvasRenderingContext2D,
  progress: number,
  box: { x: number; y: number; w: number; h: number },
  color: string,
): void {
  const p = Math.max(0, Math.min(1, progress))
  const h = Math.max(6, RENDER.height * 0.02)
  const y = box.y + box.h + h
  ctx.save()
  ctx.fillStyle = PALETTE.floorLine
  ctx.fillRect(box.x, y, box.w, h)
  ctx.fillStyle = color
  ctx.fillRect(box.x, y, box.w * p, h)
  ctx.restore()
}
