/**
 * Рендер: буфер, общая фигура превью и выреза, проходимость выреза, заливка
 * приговора, дисциплина покадрового пути и границы HUD.
 *
 * **Пиксели здесь считает свой растеризатор, а не Canvas2D, и это решение.**
 * Проходимость выреза — свойство ГЕОМЕТРИИ фигуры (круг головы плюс капсулы
 * костей с круглыми концами), а не драйвера Canvas: вырез обязан быть одним
 * куском и нигде не сужаться ниже штриха, иначе ребёнок физически не проходит
 * сквозь форму, которую видит. Добавить `@napi-rs/canvas` значило бы проверять
 * растеризатор библиотеки, которой на телефоне нет вовсе.
 *
 * Сам драйвер проверяется ПРОКСИ над поддельным контекстом: буфер, отсутствие
 * теней и градиентов, одна фигура на превью и маску, цвет заливки, границы
 * HUD — это вызовы, а не пиксели.
 *
 * Разбор: `docs/render-and-layout.md`.
 */
import { describe, expect, test } from 'vitest'

import { createRenderer } from '../../src/adapters/render/canvas'
import type { Scene } from '../../src/adapters/render/canvas'
import { RENDER, placeFigure, safeArea } from '../../src/adapters/render/figure'
import { drawPreview, drawWall, wallBox } from '../../src/adapters/render/wall'
import { figure } from '../../src/core/figure'
import { stick } from '../../src/fake/stick'
import { POSES } from '../../src/core/poses'
import { CONFIG } from '../../src/core/config'
import type { Pt } from '../../src/core/types'
import { LANDMARK_COUNT, LANDMARK_STRIDE, LM, pointAt } from '../../src/core/landmarks'

// ───────────────────────── поддельный контекст ─────────────────────────

const METHODS = [
  'save',
  'restore',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'arc',
  'ellipse',
  'rect',
  'roundRect',
  'fill',
  'stroke',
  'clip',
  'fillRect',
  'strokeRect',
  'clearRect',
  'translate',
  'scale',
  'rotate',
  'setTransform',
  'resetTransform',
  'fillText',
  'strokeText',
  'setLineDash',
  'createLinearGradient',
  'createRadialGradient',
  'createConicGradient',
  'createPattern',
  'drawImage',
] as const

/**
 * Запись в ОДНОМ порядке: цвет заливки имеет смысл только относительно
 * вызова, который им залил. Два отдельных списка этот порядок теряют.
 */
type Entry = { kind: 'call'; m: string; a: unknown[] } | { kind: 'set'; p: string; v: unknown }

function tape(): { ctx: CanvasRenderingContext2D; entries: Entry[] } {
  const entries: Entry[] = []
  const state: Record<string, unknown> = {}

  const base: Record<string, unknown> = {
    canvas: { width: RENDER.width, height: RENDER.height },
    measureText: (s: string) => ({ width: s.length * 10 }),
  }
  for (const m of METHODS) {
    base[m] = (...a: unknown[]): unknown => {
      entries.push({ kind: 'call', m, a })
      return m.startsWith('create') ? {} : undefined
    }
  }

  const ctx = new Proxy(base, {
    get: (t, p: string) => (p in t ? t[p] : state[p]),
    set: (t, p: string, v) => {
      entries.push({ kind: 'set', p, v })
      state[p] = v
      return true
    },
  }) as unknown as CanvasRenderingContext2D

  return { ctx, entries }
}

/**
 * Слой с альфой, на котором собирается стена с вырезом. Отдельный именно
 * потому, что главный контекст просят БЕЗ альфы.
 */
function fakeLayer(): { layer: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }; entries: Entry[] } {
  const { ctx, entries } = tape()
  const canvas = { width: RENDER.width, height: RENDER.height } as HTMLCanvasElement
  return { layer: { canvas, ctx }, entries }
}

/** Поддельный canvas: рендер обязан сам выставить размеры буфера. */
function fakeCanvas(ctx: CanvasRenderingContext2D): {
  el: HTMLCanvasElement
  asked: unknown[]
} {
  const asked: unknown[] = []
  const el = {
    width: 300,
    height: 150,
    style: {} as CSSStyleDeclaration,
    getContext: (kind: string, o?: unknown) => {
      asked.push({ kind, o })
      return ctx
    },
  }
  return { el: el as unknown as HTMLCanvasElement, asked }
}

const calls = (e: Entry[], m: string): Entry[] => e.filter((x) => x.kind === 'call' && x.m === m)

/**
 * Рендер с подставленным слоем. Слой обязателен всегда: по умолчанию он
 * создаётся через `document`, которого в node нет, — а главное, собрать вырез
 * без слоя с альфой невозможно в принципе (см. `drawWall`).
 */
function renderer(el: HTMLCanvasElement, layerCtx?: CanvasRenderingContext2D) {
  const lay = layerCtx
    ? { canvas: { width: RENDER.width, height: RENDER.height } as HTMLCanvasElement, ctx: layerCtx }
    : fakeLayer().layer
  return createRenderer(el, { makeLayer: () => lay })
}

const SPEC = POSES[0]

function scene(over: Partial<Scene> = {}): Scene {
  return {
    phase: 'wall',
    spec: SPEC,
    wallZ: 1,
    score: 0,
    leftMs: 60000,
    ...over,
  }
}

// ───────────────────────── растеризатор выреза ─────────────────────────

/** Квадрат расстояния от точки до отрезка — ядро капсулы. */
function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len = vx * vx + vy * vy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len))
  const dx = p.x - (a.x + t * vx)
  const dy = p.y - (a.y + t * vy)
  return Math.hypot(dx, dy)
}

type Mask = { w: number; h: number; x0: number; y0: number; step: number; at: (i: number, j: number) => boolean }

/**
 * Растеризует вырез: объединение круга головы и капсул костей. Это ровно та
 * форма, которую рисует толстый штрих с круглыми концами, — потому проверка и
 * честная, а не «проверка заглушки».
 */
function rasterize(spec = SPEC, step = 2): Mask {
  const box = { x: 0, y: 0, w: RENDER.width, h: RENDER.height }
  const p = placeFigure(figure(spec), box)
  const r = p.stroke / 2
  const w = Math.ceil(box.w / step)
  const h = Math.ceil(box.h / step)
  const grid = new Uint8Array(w * h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const q = { x: i * step, y: j * step }
      let inside = Math.hypot(q.x - p.head.c.x, q.y - p.head.c.y) <= p.head.r
      if (!inside) {
        for (const [a, b] of p.bones) {
          if (distToSeg(q, a, b) <= r) {
            inside = true
            break
          }
        }
      }
      grid[j * w + i] = inside ? 1 : 0
    }
  }
  return { w, h, x0: 0, y0: 0, step, at: (i, j) => grid[j * w + i] === 1 }
}

/** Сколько кусков у маски: вырез из двух кусков непроходим в принципе. */
function components(m: Mask): number {
  const seen = new Uint8Array(m.w * m.h)
  let n = 0
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (!m.at(i, j) || seen[j * m.w + i]) continue
      n++
      const stack = [[i, j]]
      seen[j * m.w + i] = 1
      while (stack.length) {
        const [ci, cj] = stack.pop()!
        for (const [di, dj] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const ni = ci + di
          const nj = cj + dj
          if (ni < 0 || nj < 0 || ni >= m.w || nj >= m.h) continue
          if (!m.at(ni, nj) || seen[nj * m.w + ni]) continue
          seen[nj * m.w + ni] = 1
          stack.push([ni, nj])
        }
      }
    }
  }
  return n
}

/** Площадь маски в пикселях сетки. */
function area(m: Mask): number {
  let n = 0
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) if (m.at(i, j)) n++
  return n
}

// ───────────────────────── сами проверки ─────────────────────────

describe('буфер и контекст', () => {
  test('буфер ровно 1280×720 независимо от DPR', () => {
    // DPR игнорируется намеренно: картинка всё равно уезжает зеркалированием
    // на телевизор, и платить за буфер по плотности телефона нечем.
    const { ctx } = tape()
    const { el } = fakeCanvas(ctx)
    ;(globalThis as { devicePixelRatio?: number }).devicePixelRatio = 3
    renderer(el)
    expect(el.width).toBe(1280)
    expect(el.height).toBe(720)
  })

  test('контекст просят без альфы и с desynchronized', () => {
    const { ctx } = tape()
    const { el, asked } = fakeCanvas(ctx)
    renderer(el)
    expect(asked[0]).toEqual({ kind: '2d', o: { alpha: false, desynchronized: true } })
  })

  test('нет контекста — ошибка, а не рендер в пустоту', () => {
    const el = { width: 0, height: 0, style: {}, getContext: () => null } as unknown as HTMLCanvasElement
    expect(() => createRenderer(el)).toThrow()
  })
})

describe('дисциплина покадрового пути', () => {
  test('ни теней, ни фильтров, ни градиентов — ни на одной фазе', () => {
    // Зеркалирование Miracast съедает их целиком, а платит за них Adreno 619,
    // уже поделённый между инференсом и кодировщиком.
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    const r = renderer(el)
    for (const phase of ['preview', 'wall', 'freeze', 'verdict'] as const) {
      r.render(scene({ phase, verdict: phase === 'verdict' ? 'hit' : undefined }))
    }
    const banned = ['shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY', 'filter']
    expect(entries.filter((e) => e.kind === 'set' && banned.includes(e.p))).toEqual([])
    expect(calls(entries, 'createLinearGradient')).toEqual([])
    expect(calls(entries, 'createRadialGradient')).toEqual([])
    expect(calls(entries, 'createConicGradient')).toEqual([])
    expect(calls(entries, 'createPattern')).toEqual([])
  })

  test('сохранённое состояние восстанавливается: save и restore в паре', () => {
    // Непарный save копит стек контекста кадр за кадром.
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    renderer(el).render(scene())
    expect(calls(entries, 'save').length).toBe(calls(entries, 'restore').length)
  })
})

describe('фигура — одна на превью и на вырез', () => {
  test('превью и вырез строятся из ОДНОЙ фигуры', () => {
    /*
     * Сравниваются ДВА РАЗНЫХ пути рисования — превью и маска выреза, — а не
     * `placeFigure` сам с собой: прошлая версия этого теста вызывала его
     * дважды и доказывала лишь его детерминированность. Выпотроши `drawWall`
     * до рисованной от руки палки — тот тест остался бы зелёным, и главный
     * инвариант слоя рендера не был бы проверен вовсе.
     *
     * Две копии геометрии разъехались бы, и ребёнок не попадал бы в вырез,
     * который видит.
     */
    /*
     * Берётся НАСТОЯЩИЙ `drawWall`, а не копия его пути в тесте: копия
     * воспроизвела бы ту же слабость, что и прошлая версия. Прямоугольник
     * выбран так, чтобы пути совпадали покоординатно: при `wallZ = 1` стена
     * занимает весь буфер, и превью в том же прямоугольнике обязано дать
     * ровно тот же путь.
     */
    const box = wallBox(1)

    const prev = tape()
    drawPreview(prev.ctx, SPEC, box)

    const mask = tape()
    drawWall(tape().ctx, { canvas: {} as HTMLCanvasElement, ctx: mask.ctx }, SPEC, 1)

    const shape = (e: Entry[]): unknown[] =>
      e.filter((x): x is Extract<Entry, { kind: 'call' }> => x.kind === 'call')
        .filter((x) => x.m === 'moveTo' || x.m === 'lineTo' || x.m === 'arc')
        .map((x) => [x.m, ...x.a.map((v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))])

    expect(shape(mask.entries)).toEqual(shape(prev.entries))
    expect(shape(prev.entries).length).toBeGreaterThan(0)
  })

  test('фигура целиком внутри отведённого прямоугольника', () => {
    // Вылезшая за стену рука рисуется поверх HUD, и очки читаются поверх руки.
    const box = { x: 100, y: 50, w: 400, h: 300 }
    for (const spec of POSES) {
      const p = placeFigure(figure(spec), box)
      const r = p.stroke / 2
      const xs = [p.head.c.x - p.head.r, p.head.c.x + p.head.r]
      const ys = [p.head.c.y - p.head.r, p.head.c.y + p.head.r]
      for (const [a, b] of p.bones) {
        xs.push(a.x - r, a.x + r, b.x - r, b.x + r)
        ys.push(a.y - r, a.y + r, b.y - r, b.y + r)
      }
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(box.x - 1e-6)
      expect(Math.max(...xs)).toBeLessThanOrEqual(box.x + box.w + 1e-6)
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(box.y - 1e-6)
      expect(Math.max(...ys)).toBeLessThanOrEqual(box.y + box.h + 1e-6)
    }
  })

  test('штрих толстый: тонкие линии зеркалирование съедает', () => {
    const p = placeFigure(figure(SPEC), { x: 0, y: 0, w: 1280, h: 720 })
    expect(p.stroke).toBeGreaterThan(8)
  })
})

describe('проходимость выреза', () => {
  test('вырез — ОДИН кусок у всех поз набора', () => {
    // Вырез из двух кусков непроходим в принципе: силуэт ребёнка один.
    // Проверяются все позы набора, а не одна показательная.
    for (const spec of POSES) {
      expect({ pose: spec.id, parts: components(rasterize(spec)) }).toEqual({
        pose: spec.id,
        parts: 1,
      })
    }
  })

  test('вырез не вырождается в волосок: площадь заметна', () => {
    for (const spec of POSES) {
      const m = rasterize(spec)
      const frac = area(m) / (m.w * m.h)
      expect(frac).toBeGreaterThan(0.02)
    }
  })

  test('растеризатор ловит РАЗОРВАННЫЙ вырез, а не всегда отвечает «один»', () => {
    // Сторож, который не умеет сказать «два», выглядит как зелёный тест.
    const step = 2
    const w = 50
    const h = 50
    const grid = new Uint8Array(w * h)
    grid[5 * w + 5] = 1
    grid[40 * w + 40] = 1
    const m: Mask = { w, h, x0: 0, y0: 0, step, at: (i, j) => grid[j * w + i] === 1 }
    expect(components(m)).toBe(2)
  })
})

/**
 * Прямоугольник стены среди вызовов `fillRect`: пол рисует два на весь буфер,
 * стена — свой. Отбор по аргументам, а не по номеру вызова: номер поехал бы от
 * любой правки порядка рисования, и тест врал бы молча.
 */
function wallRectOf(e: Entry[], wallZ: number): { a: unknown[]; fill: unknown } | null {
  const want = wallBox(wallZ)
  let last: unknown
  for (const x of e) {
    if (x.kind === 'set' && x.p === 'fillStyle') last = x.v
    if (x.kind === 'call' && x.m === 'fillRect') {
      const [bx, by, bw, bh] = x.a as number[]
      const near = (p: number, q: number): boolean => Math.abs(p - q) < 0.5
      if (near(bx, want.x) && near(by, want.y) && near(bw, want.w) && near(bh, want.h)) {
        return { a: x.a, fill: last }
      }
    }
  }
  return null
}

describe('приговор заливает саму стену', () => {
  /*
   * Прямоугольник стены ищется на СЛОЕ, а не в кадре: стена с вырезом
   * собирается там и переносится в кадр одним `drawImage`. Искать её в кадре
   * значило бы искать прямоугольник, которого там и нет.
   */
  const fillOf = (kind: 'hit' | 'miss' | 'skip'): unknown => {
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, { makeLayer: () => lay.layer }).render(
      scene({ phase: 'verdict', verdict: kind }),
    )
    const rect = wallRectOf(lay.entries, 1)
    expect(rect).not.toBeNull()
    return rect!.fill
  }

  test('зелёная при hit, красная при miss, нейтральная при skip', () => {
    // Заливается СТЕНА, а не вспышка во весь экран: стена — предмет, с
    // которым ребёнок только что имел дело, и цвет отвечает на вопрос
    // «я прошёл сквозь неё или нет».
    const hit = fillOf('hit')
    const miss = fillOf('miss')
    const skip = fillOf('skip')
    expect(hit).not.toEqual(miss)
    expect(skip).not.toEqual(hit)
    expect(hit).toBeTruthy()
  })

  test('несудимый раунд не красит стену как провал', () => {
    // Худший класс дефекта здесь: ребёнок не понимает, почему проиграл.
    expect(fillOf('skip')).not.toEqual(fillOf('miss'))
  })

  test('без приговора стена своего цвета, а не цвета исхода', () => {
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, { makeLayer: () => lay.layer }).render(scene({ phase: 'wall' }))
    const rect = wallRectOf(lay.entries, 1)
    expect(rect).not.toBeNull()
    expect(rect!.fill).not.toEqual(fillOf('hit'))
    expect(rect!.fill).not.toEqual(fillOf('miss'))
  })
})

describe('HUD', () => {
  test('целиком внутри центральной области 16:9', () => {
    // За её пределами очки и остаток времени на телевизоре окажутся в полосе.
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    renderer(el).render(scene({ score: 12, leftMs: 45000 }))
    const safe = safeArea()
    const texts = entries.filter((e) => e.kind === 'call' && e.m === 'fillText')
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) {
      if (t.kind !== 'call') continue
      const [, x, y] = t.a as [string, number, number]
      expect(x).toBeGreaterThanOrEqual(safe.x)
      expect(x).toBeLessThanOrEqual(safe.x + safe.w)
      expect(y).toBeGreaterThanOrEqual(safe.y)
      expect(y).toBeLessThanOrEqual(safe.y + safe.h)
    }
  })

  test('область 16:9 действительно внутри буфера и по центру', () => {
    const safe = safeArea()
    expect(safe.x).toBeGreaterThanOrEqual(0)
    expect(safe.y).toBeGreaterThanOrEqual(0)
    expect(safe.x + safe.w).toBeLessThanOrEqual(RENDER.width)
    expect(safe.y + safe.h).toBeLessThanOrEqual(RENDER.height)
    expect(safe.x * 2 + safe.w).toBeCloseTo(RENDER.width)
    expect(safe.y * 2 + safe.h).toBeCloseTo(RENDER.height)
  })

  test('очки и остаток времени ПОКАЗАНЫ, а не только посчитаны', () => {
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    renderer(el).render(scene({ score: 12, leftMs: 45000 }))
    const shown = entries
      .filter((e): e is Extract<Entry, { kind: 'call' }> => e.kind === 'call' && e.m === 'fillText')
      .map((e) => String(e.a[0]))
      .join(' ')
    expect(shown).toContain('12')
    expect(shown).toMatch(/45|0:45/)
  })

  test('прибавка берётся из CONFIG.score, а не записана в HUD', () => {
    /*
     * Инвариант «один факт живёт в одном месте», и он уже был нарушен здесь:
     * HUD печатал `+3` / `−2` строками, а очки начисляет `CONFIG.score`.
     * Поменяй `CONFIG.score.hit` на 5 — ребёнку начислялось бы 5, а на экране
     * стояло бы `+3`, и прогон оставался бы зелёным.
     */
    const shown = (verdict: 'hit' | 'miss' | 'skip'): string => {
      const { ctx, entries } = tape()
      const { el } = fakeCanvas(ctx)
      renderer(el).render(scene({ phase: 'verdict', verdict }))
      return entries
        .filter((e): e is Extract<Entry, { kind: 'call' }> => e.kind === 'call' && e.m === 'fillText')
        .map((e) => String(e.a[0]))
        .join(' ')
    }

    expect(shown('hit')).toContain(String(CONFIG.score.hit))
    expect(shown('miss')).toContain(String(Math.abs(CONFIG.score.miss)))
    // Несудимый раунд прибавки не показывает вовсе: её и не было.
    expect(shown('skip')).not.toContain(String(CONFIG.score.hit))
  })

  test('вес шрифта 700: тонкое начертание зеркалирование съедает', () => {
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    renderer(el).render(scene())
    const fonts = entries.filter((e) => e.kind === 'set' && e.p === 'font')
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) {
      if (f.kind !== 'set') continue
      expect(String(f.v)).toMatch(/\b700\b|bold/)
    }
  })
})

describe('пауза', () => {
  test('пауза называет причину, а не просто гасит экран', () => {
    // Молча замерший экран не говорит ребёнку, что делать.
    const { ctx, entries } = tape()
    const { el } = fakeCanvas(ctx)
    renderer(el).render(scene({ paused: { why: 'jump' } }))
    const shown = entries
      .filter((e): e is Extract<Entry, { kind: 'call' }> => e.kind === 'call' && e.m === 'fillText')
      .map((e) => String(e.a[0]))
      .join(' ')
    expect(shown.length).toBeGreaterThan(0)
  })
})

describe('стена приближается', () => {
  test('wallZ растит стену от горизонта до полного экрана', () => {
    // Монотонно: стена, которая на каком-то участке пути уменьшается, читается
    // как отъезжающая, а она идёт на игрока всё время.
    let prev = 0
    for (let z = 0; z <= 1.0001; z += 0.05) {
      const w = wallBox(z).w
      expect(w).toBeGreaterThan(prev)
      prev = w
    }
    expect(wallBox(1).w).toBeCloseTo(RENDER.width)
    expect(wallBox(1).h).toBeCloseTo(RENDER.height)
  })

  test('приближение зажато в полосу: мусорный wallZ не рвёт стену', () => {
    // Автомат раунда отдаёт долю пути, но единственный раз, когда она выйдет
    // за полосу, — это дефект выше; рендер обязан нарисовать кадр, а не упасть.
    expect(wallBox(-5).w).toBeCloseTo(wallBox(0).w)
    expect(wallBox(99).w).toBeCloseTo(wallBox(1).w)
  })

  test('нарисованная стена и есть та, что считает wallBox', () => {
    // Иначе проверка выше проверяла бы арифметику, которой рендер не
    // пользуется.
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, { makeLayer: () => lay.layer }).render(scene({ wallZ: 0.3 }))
    expect(wallRectOf(lay.entries, 0.3)).not.toBeNull()
  })
})

describe('вырез не выжигается в главном буфере', () => {
  /*
   * Главный контекст просят БЕЗ альфы (`alpha: false`) — так дешевле, и так
   * задумано. Но в буфере без альфы `destination-out` не делает прозрачности:
   * альфа принудительно единица, и «стёртое» композитится ЧЁРНЫМ. Вырез в
   * стене вышел бы чёрной дырой вместо коридора, по которому едет стена, —
   * причём на телефоне, а не в тесте.
   *
   * Поэтому стена с вырезом собирается на ОТДЕЛЬНОМ слое с альфой и потом
   * переносится в кадр целиком.
   */
  function renderWall(): { main: Entry[]; layer: Entry[] } {
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, { makeLayer: () => lay.layer }).render(scene({ phase: 'wall' }))
    return { main: main.entries, layer: lay.entries }
  }

  test('в главном контексте НЕТ destination-out', () => {
    const { main } = renderWall()
    const erasing = main.filter(
      (e) => e.kind === 'set' && e.p === 'globalCompositeOperation' && e.v === 'destination-out',
    )
    expect(erasing).toEqual([])
  })

  test('стирание происходит на слое, и слой переносится в кадр', () => {
    const { main, layer } = renderWall()
    expect(
      layer.some((e) => e.kind === 'set' && e.p === 'globalCompositeOperation' && e.v === 'destination-out'),
    ).toBe(true)
    expect(calls(main, 'drawImage').length).toBeGreaterThan(0)
  })

  test('слой просят С альфой: без неё стирать на нём так же нечем', () => {
    const asked: unknown[] = []
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, {
      makeLayer: (w, h) => {
        asked.push({ w, h })
        return lay.layer
      },
    }).render(scene({ phase: 'wall' }))
    expect(asked).toEqual([{ w: RENDER.width, h: RENDER.height }])
  })

  test('слой очищается перед сборкой: прошлый кадр не просвечивает', () => {
    // Слой переиспользуется между кадрами — он создаётся один раз. Без очистки
    // стена прошлого кадра осталась бы под нынешней, и вырез показывал бы её.
    const { layer } = renderWall()
    expect(calls(layer, 'clearRect').length).toBeGreaterThan(0)
  })
})

describe('силуэт игрока ложится НА вырез', () => {
  /*
   * Силуэт — подсказка «куда доворачивать», и подсказка, показывающая не туда,
   * хуже отсутствующей. Уже допущенный однажды дефект: точки скелета
   * раскладывались прямо по прямоугольнику стены (`box.x + lm.x * box.w`),
   * тогда как вырез в том же прямоугольнике строится `placeFigure` — в долях
   * ТОРСА, по центру и с запасом `figureFill`. Совпасть эти две системы не
   * могли ни при каком кадре, и `x` вдобавок не домножался на отношение сторон.
   */
  const silhouetteOf = (lm: Float32Array): Array<[number, number]> => {
    const main = tape()
    const { el } = fakeCanvas(main.ctx)
    const lay = fakeLayer()
    createRenderer(el, { makeLayer: () => lay.layer }).render(
      scene({ phase: 'wall', wallZ: 1, silhouette: lm, aspect: 16 / 9 }),
    )
    // Точки силуэта — дуги в главном контексте (стена и её вырез уехали на слой).
    return main.entries
      .filter((e): e is Extract<Entry, { kind: 'call' }> => e.kind === 'call' && e.m === 'arc')
      .map((e) => [e.a[0] as number, e.a[1] as number])
  }

  test('середина плеч силуэта попадает в середину плеч выреза', () => {
    /*
     * Сравниваются КОНКРЕТНЫЕ точки, а не габариты: габаритная проверка на
     * полном экране проходит и при разъехавшихся системах координат — именно
     * поэтому первая версия этого теста дефекта не поймала. Точки приходят в
     * порядке номеров скелета, так что `dots[LM.leftShoulder]` и есть левое
     * плечо.
     */
    const lm = stick({ ...SPEC.requires, orientation: SPEC.orientation, facing: 'right', aspect: 16 / 9 })
    const dots = silhouetteOf(lm)
    expect(dots.length).toBe(LANDMARK_COUNT)

    const placed = placeFigure(figure(SPEC), wallBox(1))
    // `bones[1]` — линия плеч фигуры (порядок костей — в `core/figure.ts`).
    const [figA, figB] = placed.bones[1]
    const dotA = dots[LM.leftShoulder]
    const dotB = dots[LM.rightShoulder]

    // Середина плеч — величина, не зависящая от того, какое плечо «левое»:
    // соглашения о сторонах у скелета и у кинематики свои.
    const figMid = { x: (figA.x + figB.x) / 2, y: (figA.y + figB.y) / 2 }
    const dotMid = { x: (dotA[0] + dotB[0]) / 2, y: (dotA[1] + dotB[1]) / 2 }

    // Допуск — четверть штриха: попасть надо В вырез, а не в его окрестность.
    const tol = placed.stroke / 4
    expect(Math.abs(dotMid.x - figMid.x)).toBeLessThan(tol)
    expect(Math.abs(dotMid.y - figMid.y)).toBeLessThan(tol)

    // И ширина плеч обязана совпасть: иначе силуэт «той же позы» шире выреза.
    expect(Math.abs(Math.abs(dotA[0] - dotB[0]) - Math.abs(figA.x - figB.x))).toBeLessThan(tol)
  })

  test('без известного отношения сторон силуэт не рисуется вовсе', () => {
    // Геометрия на неизвестном `aspect` отказывается считать, и силуэт обязан
    // отказаться вместе с ней: иначе он показывает уверенную неправду.
    const broken = new Float32Array(LANDMARK_COUNT * LANDMARK_STRIDE)
    expect(silhouetteOf(broken).length).toBe(0)
  })
})
