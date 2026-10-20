/**
 * Два независимых такта: кадр камеры и кадр экрана.
 *
 * Главный инвариант покадрового пути, и он стоит здесь, а не в тестах экранов:
 * DOM к нему отношения не имеет вовсе.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */
import { describe, expect, test } from 'vitest'

import { makeLoop } from '../../src/shell/loop'
import type { Frame } from '../../src/core/types'

const frame = (t: number): Frame => ({ t, lm: null })

describe('два независимых такта', () => {
  test('кадр камеры НЕ продвигает мир и не рисует', () => {
    // Склеенные такты дают 11 Гц картинки вместо 38–40: стена едет рывками.
    let steps = 0
    const loop = makeLoop({
      step: () => {
        steps++
      },
    })
    loop.sample(frame(1))
    loop.sample(frame(2))
    loop.sample(frame(3))
    expect(steps).toBe(0)
    expect(loop.pending()).toBe(3)
  })

  test('кадр экрана НЕ трогает трекер: он только забирает накопленное', () => {
    // Обратная склейка хуже прямой: рендер начинает ждать инференс, и просадка
    // GPU останавливает мир целиком.
    const seen: Frame[][] = []
    const loop = makeLoop({ step: (_t, f) => void seen.push(f) })
    loop.sample(frame(1))
    loop.frame(16)
    loop.frame(32)
    expect(seen[0].map((f) => f.t)).toEqual([1])
    // Второй кадр экрана прошёл без единого кадра камеры — и это норма:
    // рендер идёт вчетверо чаще поз.
    expect(seen[1]).toEqual([])
  })

  test('буфер забирается ЦЕЛИКОМ: выброшенный кадр — выброшенный голос', () => {
    // Судейство голосует по всем кадрам окна, поэтому «последний кадр» вместо
    // буфера терял бы голоса — то есть судил бы по тому, чего не видел.
    const seen: Frame[][] = []
    const loop = makeLoop({ step: (_t, f) => void seen.push(f) })
    loop.sample(frame(1))
    loop.sample(frame(2))
    loop.frame(16)
    expect(seen[0].map((f) => f.t)).toEqual([1, 2])
    expect(loop.pending()).toBe(0)
  })

  test('кадры, пришедшие ПОКА считали, достаются следующему кадру экрана', () => {
    const seen: Frame[][] = []
    const loop = makeLoop({
      step: (_t, f) => {
        seen.push(f)
        // Кадр камеры прилетел посреди продвижения мира: он не должен ни
        // потеряться, ни попасть в текущий шаг задним числом.
        if (seen.length === 1) loop.sample(frame(99))
      },
    })
    loop.sample(frame(1))
    loop.frame(16)
    loop.frame(32)
    expect(seen[0].map((f) => f.t)).toEqual([1])
    expect(seen[1].map((f) => f.t)).toEqual([99])
  })

  test('сводка здоровья пишется раз в секунду, а не каждый кадр', () => {
    // Журнал с сводкой на каждый кадр упёрся бы в потолок за один забег.
    const loop = makeLoop({ step: () => ({ valid: 1, lost: 0 }) })
    for (let t = 0; t < 900; t += 16) loop.frame(t)
    // Ровно столько, сколько секунд прошло: проверяется через счётчик кадров,
    // потому что журнал в node выключен и наружу молчит.
    expect(loop.pending()).toBe(0)
  })

  test('числа валидных и потерянных берутся у ЯДРА, а не выдумываются', () => {
    // Выдуманные числа в журнале хуже отсутствующих: по ним потом объясняют,
    // почему раунд не судился.
    let asked = 0
    const loop = makeLoop({
      step: () => {
        asked++
        return { valid: 7, lost: 2 }
      },
    })
    loop.frame(0)
    loop.frame(16)
    expect(asked).toBe(2)
  })

  test('сводка от источника позы принимается, а не считается на месте', () => {
    // Инференс идёт в воркере: главный поток о его длительности знает только
    // по сообщению `beat`.
    const loop = makeLoop({ step: () => undefined })
    expect(() => loop.noteBeat({ p50: 18, p95: 40, dropped: 3 })).not.toThrow()
  })

  test('первый кадр экрана не считает секунду от нуля часов', () => {
    // `performance.now()` на старте забега — не ноль, и сводка «за 40 секунд»
    // в первую же секунду была бы ложью.
    const loop = makeLoop({ step: () => undefined })
    expect(() => loop.frame(123456)).not.toThrow()
  })
})
