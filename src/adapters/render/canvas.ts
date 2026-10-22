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
import type { Placed } from './figure'
import { geometry } from '../../core/geometry'
import { drawHud } from './hud'
import { drawCalibration } from './calibrate'
import type { CalibScene } from './calibrate'
import { PALETTE, drawFloor, drawPreview, drawWall } from './wall'
import type { Layer } from './wall'

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
  /**
   * Отношение сторон кадра. Без него силуэт НЕ рисуется: `x` нормирован по
   * ширине, `y` по высоте, и раскладывать точки без поправки значит показывать
   * уверенную неправду — ту же, из-за которой геометрия отказывается считать.
   */
  aspect?: number | null
  paused?: { why: PresenceReason }
}

export type Renderer = {
  render(s: Scene): void
  /**
   * Экран КАЛИБРОВКИ: область, куда встать, поза и живой силуэт.
   *
   * Необязателен по типу намеренно: рендер подменяется в десятке тестов, и
   * обязательный метод заставил бы каждый из них рисовать то, что они не
   * проверяют. Настоящий рендер его реализует, а оболочка зовёт через `?.` —
   * отсутствие даёт прежнее поведение (пустой экран), и это та же цена, что
   * была до появления экрана.
   */
  calibration?(c: CalibScene): void
}

export type RendererDeps = {
  /**
   * Слой с альфой для стены с вырезом. Приходит зависимостью: Canvas2D в node
   * нет, а собрать вырез иначе чем на слое с альфой невозможно — см. `drawWall`.
   */
  makeLayer?: (w: number, h: number) => Layer
}

/** Слой по умолчанию — ещё один canvas того же размера, с альфой. */
function defaultLayer(w: number, h: number): Layer {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  // Альфа здесь ОБЯЗАТЕЛЬНА и потому не отключается: на слое без неё
  // `destination-out` не делает прозрачности, а даёт чёрное.
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d для слоя стены недоступен')
  return { canvas, ctx }
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
export function createRenderer(canvas: HTMLCanvasElement, deps: RendererDeps = {}): Renderer {
  canvas.width = RENDER.width
  canvas.height = RENDER.height

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) throw new Error('canvas 2d недоступен')

  // Слой создаётся ОДИН раз: по слою на кадр их было бы сорок в секунду.
  const layer = (deps.makeLayer ?? defaultLayer)(RENDER.width, RENDER.height)

  return {
    calibration: (c: CalibScene): void => drawCalibration(ctx, c),

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
        const placed = drawWall(ctx, layer, s.spec, s.wallZ, s.verdict)
        if (s.silhouette) drawSilhouette(ctx, s.silhouette, placed, s.aspect)
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
 * **Точки проходят ТО ЖЕ преобразование, что и фигура выреза** (`placed.toPx`),
 * а для этого сперва переводятся в доли торса — ровно в ту систему, в которой
 * кинематика строит фигуру: начало в середине бёдер, единица — длина торса.
 *
 * Это уже допущенный однажды дефект: точки раскладывались прямо по
 * прямоугольнику стены (`box.x + lm.x * box.w`), тогда как вырез в том же
 * прямоугольнике строится по долям торса, по центру и с запасом. Совпасть эти
 * две системы не могли ни при каком кадре — замерено 47 пикселей расхождения
 * по вертикали и 13% по ширине плеч уже на полном экране, а на подъезжающей
 * (то есть маленькой) стене силуэт вдобавок сжимался вместе с ней, хотя
 * настоящий ребёнок на экране не уменьшается. Подсказка, показывающая не туда,
 * хуже отсутствующей.
 *
 * Рисуется точками, а не костями: кости требуют схемы соединений, то есть
 * второй копии анатомии рядом с `kinematics()`.
 */
function drawSilhouette(
  ctx: CanvasRenderingContext2D,
  lm: Landmarks,
  placed: Placed,
  aspect: number | null | undefined,
): void {
  if (typeof aspect !== 'number') return
  const g = geometry(lm, aspect)
  // Нет годной геометрии — нет и силуэта: та же причина, по которой её нет у
  // судейства.
  if (!g) return

  ctx.save()
  ctx.fillStyle = PALETTE.figure
  ctx.globalAlpha = 0.55
  const r = Math.max(2, placed.stroke * 0.12)
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = pointAt(lm, i)
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    // В доли торса: начало — середина бёдер, единица — длина торса, `x` с
    // поправкой на отношение сторон.
    const torso = { x: (p.x * aspect - g.hipMid.x) / g.S, y: (p.y - g.hipMid.y) / g.S }
    const q = placed.torsoToPx(torso)
    ctx.beginPath()
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  ctx.restore()
}
