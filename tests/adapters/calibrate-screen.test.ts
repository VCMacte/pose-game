/**
 * Экран калибровки: силуэт, область, где надо стоять, и поза, в которой надо
 * стоять.
 *
 * Прежде стадия калибровки не рисовала НИЧЕГО — `step` отдавал `scene: null`,
 * и ребёнок пять секунд смотрел в тёмный экран с одной строчкой текста. Трижды
 * подряд 22.10.2026 калибровка на телефоне так и не прошла, и по журналу
 * невозможно было понять, стоял ли кто-нибудь перед камерой вообще: взрослому
 * нечем было это увидеть.
 *
 * Проверяется через ПРОКСИ над контекстом: в node Canvas2D нет, а проверять
 * надо не пиксели, а то, что нарисовано и чем — ровно так же, как проверяется
 * запрет теней и градиентов в покадровом пути.
 *
 * Разбор: `docs/render-and-layout.md`, `docs/calibration.md`.
 */
import { describe, expect, test } from 'vitest'

import { drawCalibration } from '../../src/adapters/render/calibrate'
import { RENDER } from '../../src/adapters/render/figure'
import { CAMERA } from '../../src/adapters/camera'
import { stick } from '../../src/fake/stick'

const ASPECT = 16 / 9

/** Записывающий контекст: что рисовали и какими свойствами. */
function spy() {
  const calls: Array<{ op: string; args: unknown[] }> = []
  const props: Record<string, unknown[]> = {}
  const ctx = new Proxy(
    {},
    {
      get: (_t, key: string) => {
        if (key === 'canvas') return { width: RENDER.width, height: RENDER.height }
        return (...args: unknown[]) => void calls.push({ op: key, args })
      },
      set: (_t, key: string, value: unknown) => {
        ;(props[key] ??= []).push(value)
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D
  return { ctx, calls, props, did: (op: string) => calls.filter((c) => c.op === op).length }
}

const scene = (over: Partial<Parameters<typeof drawCalibration>[1]> = {}) => ({
  silhouette: stick({ aspect: ASPECT }),
  aspect: ASPECT,
  framing: { fill: (CAMERA.fillMin + CAMERA.fillMax) / 2, ok: true },
  progress: 0.5,
  ...over,
})

describe('экран калибровки', () => {
  test('рисует область, где надо стоять, фигуру и силуэт', () => {
    const s = spy()
    drawCalibration(s.ctx, scene())

    // Рамка области — обведённый прямоугольник.
    expect(s.did('strokeRect')).toBeGreaterThan(0)
    // Фигура нейтральной стойки — та же `paintFigure`, что у превью: линии и
    // окружность головы.
    expect(s.did('stroke') + s.did('fill')).toBeGreaterThan(0)
    expect(s.did('arc')).toBeGreaterThan(0)
  })

  test('без отношения сторон силуэт НЕ рисуется, а область — рисуется', () => {
    /*
     * Тот же запрет, что у силуэта в забеге и у геометрии: раскладывать точки
     * без поправки — показывать уверенную неправду. Но область и поза от
     * кадра не зависят, и показать их надо даже до первого кадра: иначе
     * ребёнок опять смотрит в темноту.
     */
    const withAspect = spy()
    drawCalibration(withAspect.ctx, scene())
    const without = spy()
    drawCalibration(without.ctx, scene({ aspect: null }))

    expect(without.did('strokeRect')).toBeGreaterThan(0)
    expect(without.did('arc')).toBeLessThan(withAspect.did('arc'))
  })

  test('нет скелета — рисуются только область и поза', () => {
    const s = spy()
    drawCalibration(s.ctx, scene({ silhouette: null }))
    expect(s.did('strokeRect')).toBeGreaterThan(0)
  })

  test('годное кадрирование и негодное различаются ЦВЕТОМ', () => {
    // Взрослому у штатива нужна обратная связь без чтения: встал правильно —
    // рамка сменила цвет.
    const good = spy()
    drawCalibration(good.ctx, scene({ framing: { fill: 0.6, ok: true } }))
    const bad = spy()
    drawCalibration(bad.ctx, scene({ framing: { fill: 0.2, ok: false } }))

    expect(JSON.stringify(good.props.strokeStyle)).not.toBe(JSON.stringify(bad.props.strokeStyle))
  })

  test('полоса ожидания растёт вместе с прогрессом', () => {
    /*
     * «Смотреть на тёмный экран и ждать неприятно и непонятно»: сколько ещё
     * стоять, видно по полосе, а не по догадке.
     */
    const width = (progress: number): number => {
      const s = spy()
      drawCalibration(s.ctx, scene({ progress }))
      // ПОСЛЕДНИЙ `fillRect` — заполненная часть полосы: пол рисуется раньше
      // и во всю ширину буфера, так что максимум по всем прямоугольникам
      // поймал бы его, а не полосу.
      const rects = s.calls.filter((c) => c.op === 'fillRect')
      return Number(rects[rects.length - 1].args[2])
    }
    expect(width(0.8)).toBeGreaterThan(width(0.2))
  })

  test('в покадровом пути нет ни теней, ни градиентов, ни фильтров', () => {
    // Тот же инвариант, что у стены: зеркалирование их съедает, а кадровый
    // бюджет они едят.
    const s = spy()
    drawCalibration(s.ctx, scene())
    expect(s.props.shadowBlur).toBeUndefined()
    expect(s.props.shadowColor).toBeUndefined()
    expect(s.props.filter).toBeUndefined()
    expect(s.did('createLinearGradient')).toBe(0)
  })
})
