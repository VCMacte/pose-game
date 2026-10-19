import { LANDMARK_COUNT, LANDMARK_STRIDE, LM, pointAt } from './landmarks'
import type { Landmarks, Pt } from './types'

/**
 * Нормализованный кадр: всё, из чего считаются оси, в единицах, не зависящих
 * ни от роста игрока, ни от дистанции до камеры.
 * См. docs/camera-and-pose.md «Нормализация: всё в долях торса».
 */
export type Geometry = {
  /** Длина торса — единица измерения всего судейства. В единицах `y` кадра. */
  S: number
  /** Центр тела по горизонтали, в долях ШИРИНЫ кадра: им судят присутствие и центровку. */
  cx: number
  /** То же, но в единицах `y`: им считают расстояния вместе с `S`. */
  cxh: number
  /** Средняя `visibility` плеч и бёдер. */
  vis: number
  /** Ширина плеч в долях торса: ею отличают фронт от профиля. */
  shoulderRatio: number
  shoulderMid: Pt
  hipMid: Pt
  /** Дискриминант: `geometry()` либо вернула годный кадр, либо `null`. */
  ok: true
}

/** Опорные четыре точки: центр тела и уверенность считаются по ним и только по ним. */
const ANCHORS = [LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip] as const

/**
 * Приводит сырые точки MediaPipe к долям торса.
 *
 * Возвращает `null`, если считать нечем: нет позы, неизвестно отношение сторон
 * кадра (считать углы без поправки значит считать их неверно и молча) или торс
 * выродился в точку. Низкая `visibility` на `null` НЕ отображается — она
 * приезжает в `vis`, а «не знаю» вместо промаха решается осями и судьёй.
 */
export function geometry(lm: Landmarks | null, aspect: number | null): Geometry | null {
  if (lm === null || aspect === null) return null
  if (!Number.isFinite(aspect) || aspect <= 0) return null
  if (lm.length !== LANDMARK_COUNT * LANDMARK_STRIDE) return null

  let sumX = 0
  let sumVis = 0
  for (const i of ANCHORS) {
    const p = pointAt(lm, i)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    sumX += p.x
    sumVis += p.visibility
  }

  const ls = pointAt(lm, LM.leftShoulder)
  const rs = pointAt(lm, LM.rightShoulder)
  const lh = pointAt(lm, LM.leftHip)
  const rh = pointAt(lm, LM.rightHip)

  // `x` домножается на отношение сторон: MediaPipe нормирует x по ширине, y по высоте.
  const shoulderMid: Pt = { x: ((ls.x + rs.x) / 2) * aspect, y: (ls.y + rs.y) / 2 }
  const hipMid: Pt = { x: ((lh.x + rh.x) / 2) * aspect, y: (lh.y + rh.y) / 2 }

  const S = Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y)
  if (!(S > 0)) return null

  const shoulderWidth = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y)
  const cx = sumX / ANCHORS.length

  return {
    S,
    cx,
    cxh: cx * aspect,
    vis: sumVis / ANCHORS.length,
    shoulderRatio: shoulderWidth / S,
    shoulderMid,
    hipMid,
    ok: true,
  }
}
