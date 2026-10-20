/**
 * HUD: очки, остаток времени, название позы, причина паузы.
 *
 * Весь критичный HUD живёт внутри центральной области 16:9 с запасом на
 * overscan: за её пределами очки и остаток времени на телевизоре окажутся в
 * полосе, и на телефоне этого не увидеть вовсе.
 *
 * Разбор: `docs/render-and-layout.md`.
 */

import type { PresenceReason } from '../../core/presence'
import { RENDER, safeArea } from './figure'
import { PALETTE } from './wall'

/**
 * Начертание. Вес 700 и ничего тоньше: зеркалирование Miracast съедает тонкие
 * линии, а HUD — то, что обязано читаться с дивана.
 */
const font = (px: number): string => `700 ${px}px system-ui, sans-serif`

/** Крупный кегль — от 4vmin по меньшей стороне буфера. */
const BIG = Math.round(RENDER.height * 0.09)
const MID = Math.round(RENDER.height * 0.055)

/** `мм:сс` — ребёнок 7 лет читает часы, а не миллисекунды. */
export function clockText(leftMs: number): string {
  const s = Math.max(0, Math.ceil(leftMs / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Почему пауза — словами для ребёнка, а не кодом причины. */
export function pauseText(why: PresenceReason): string {
  switch (why) {
    case 'lowvis':
      return 'Тебя не видно'
    case 'jump':
      return 'Кто-то ещё в кадре'
    case 'scale':
      return 'Встань как раньше'
    case 'orientation':
      return 'Повернись к камере'
    case 'edge':
      return 'Встань в середину'
    default:
      return 'Пауза'
  }
}

export type HudScene = {
  score: number
  leftMs: number
  poseName?: string
  verdict?: 'hit' | 'miss' | 'skip'
  paused?: { why: PresenceReason }
}

/** Прибавка очков словами приговора. `skip` не показывает ничего. */
const delta = (kind: 'hit' | 'miss' | 'skip'): string | null =>
  kind === 'hit' ? '+3' : kind === 'miss' ? '−2' : null

export function drawHud(ctx: CanvasRenderingContext2D, s: HudScene): void {
  const safe = safeArea()

  ctx.save()
  ctx.fillStyle = PALETTE.text
  ctx.textBaseline = 'top'

  ctx.font = font(MID)
  ctx.textAlign = 'left'
  ctx.fillText(String(s.score), safe.x, safe.y)

  ctx.textAlign = 'right'
  ctx.fillText(clockText(s.leftMs), safe.x + safe.w, safe.y)

  if (s.poseName) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(s.poseName, safe.x + safe.w / 2, safe.y + safe.h)
  }

  if (s.verdict) {
    const d = delta(s.verdict)
    if (d !== null) {
      ctx.font = font(BIG)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(d, safe.x + safe.w / 2, safe.y + safe.h / 2)
    }
  }

  if (s.paused) {
    ctx.font = font(MID)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(pauseText(s.paused.why), safe.x + safe.w / 2, safe.y + safe.h * 0.3)
  }

  ctx.restore()
}
