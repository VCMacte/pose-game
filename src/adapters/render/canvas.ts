/**
 * Рендер: один кадр сцены на Canvas 2D.
 *
 * Сцена приходит ГОТОВОЙ — рендер ничего не решает и ничего не помнит. Ни
 * одного обращения к часам здесь нет: что рисовать, решили автоматы раунда и
 * забега, а рендер только рисует. Иначе разбор спорного раунда по журналу
 * требовал бы ещё и совпадения времени отрисовки.
 *
 * Three.js и WebGL нет вовсе: единственный Adreno 619 уже поделён между
 * инференсом MediaPipe и кодировщиком Miracast.
 *
 * Разбор: `docs/render-and-layout.md`.
 */

import type { Landmarks, PoseSpec } from '../../core/types'
import type { PresenceReason } from '../../core/presence'
import type { RoundPhase } from '../../core/round'
import { LANDMARK_COUNT, pointAt } from '../../core/landmarks'
import { RENDER, safeArea } from './figure'
import { drawHud } from './hud'
import { PALETTE, drawFloor, drawPreview, drawWall, wallBox } from './wall'

export type Scene = {
  phase: RoundPhase
  spec: PoseSpec
  /** Приближение стены: 0 у горизонта, 1 у экрана. */
  wallZ: number
  verdict?: 'hit' | 'miss' | 'skip'
  score: number
  leftMs: number
  /** Живой скелет игрока — отключаемая опция, по умолчанию выключена. */
  silhouette?: Landmarks | null
  paused?: { why: PresenceReason }
}

export type Renderer = {
  render(s: Scene): void
}

/**
 * Готовит canvas и отдаёт рендер.
 *
 * Буфер выставляется ЗДЕСЬ и фиксированно: DPR игнорируется намеренно —
 * картинка уезжает зеркалированием на телевизор 16:9, и платить за буфер по
 * плотности телефона нечем.
 *
 * Нет контекста — ошибка наружу, а не рендер в пустоту: молча не рисующая игра
 * на штативе неотличима от мёртвой камеры.
 */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  canvas.width = RENDER.width
  canvas.height = RENDER.height

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) throw new Error('canvas 2d недоступен')

  return {
    render: (s: Scene): void => {
      drawFloor(ctx, s.wallZ)

      if (s.phase === 'preview') {
        // Превью занимает центральную область: это единственное, что ребёнок
        // должен сейчас разглядеть.
        const safe = safeArea()
        drawPreview(ctx, s.spec, {
          x: safe.x + safe.w * 0.25,
          y: safe.y + safe.h * 0.1,
          w: safe.w * 0.5,
          h: safe.h * 0.8,
        })
      } else {
        drawWall(ctx, s.spec, s.wallZ, s.verdict)
        if (s.silhouette) drawSilhouette(ctx, s.silhouette, s.wallZ)
      }

      drawHud(ctx, {
        score: s.score,
        leftMs: s.leftMs,
        poseName: s.phase === 'preview' ? s.spec.name : undefined,
        verdict: s.verdict,
        paused: s.paused,
      })
    },
  }
}

/**
 * Живой скелет игрока поверх выреза — подсказка, куда доворачивать.
 *
 * Рисуется точками, а не костями: кости требуют знания схемы соединений, то
 * есть второй копии анатомии рядом с `kinematics()`. Точки её не требуют, а
 * подсказку «я вижу тебя вот так» дают не хуже.
 */
function drawSilhouette(ctx: CanvasRenderingContext2D, lm: Landmarks, wallZ: number): void {
  const box = wallBox(wallZ)
  ctx.save()
  ctx.fillStyle = PALETTE.figure
  ctx.globalAlpha = 0.55
  const r = Math.max(2, box.w * 0.01)
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = pointAt(lm, i)
    ctx.beginPath()
    ctx.arc(box.x + p.x * box.w, box.y + p.y * box.h, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()
}
