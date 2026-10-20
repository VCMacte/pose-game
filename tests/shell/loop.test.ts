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
    /*
     * Проверяется ЧЕРЕЗ ЖУРНАЛ, который для этого и подменяется. Прошлая
     * версия утверждала то же, а проверяла `pending() === 0` — то есть
     * проходила и при записи на каждом кадре, и при полном её отсутствии.
     */
    const wrote: Array<Record<string, unknown>> = []
    const loop = makeLoop({ step: () => ({ valid: 1, lost: 0 }), write: (e) => wrote.push(e) })
    /*
     * Две с половиной секунды кадров по 16 мс. Запись приходится на первый
     * кадр, у которого от прошлой записи прошла секунда (≈1008 и ≈2016 мс),
     * поэтому ровно две за этот отрезок — и ни одной лишней.
     */
    for (let t = 0; t <= 2500; t += 16) loop.frame(t)
    expect(wrote.length).toBe(2)
    expect(wrote[0].type).toBe('health')
  })

  test('числа валидных и потерянных попадают в журнал, а не выдумываются', () => {
    // Выдуманные числа в журнале хуже отсутствующих: по ним потом объясняют,
    // почему раунд не судился. Прошлая версия считала лишь ВЫЗОВЫ `step`.
    const wrote: Array<Record<string, unknown>> = []
    const loop = makeLoop({ step: () => ({ valid: 7, lost: 2 }), write: (e) => wrote.push(e) })
    for (let t = 0; t <= 1000; t += 100) loop.frame(t)
    expect(wrote.length).toBe(1)
    const data = wrote[0].data as Record<string, number>
    expect(data.valid).toBe(7 * 11)
    expect(data.lost).toBe(2 * 11)
  })

  test('сводка от источника позы попадает в журнал, а не теряется', () => {
    // Инференс идёт в воркере: главный поток о его длительности знает только
    // по сообщению `beat`. Прошлая версия проверяла лишь `not.toThrow()`.
    const wrote: Array<Record<string, unknown>> = []
    const loop = makeLoop({ step: () => undefined, write: (e) => wrote.push(e) })
    loop.noteBeat({ p50: 18, p95: 40, dropped: 3 })
    loop.noteBeat({ p50: 21, p95: 44, dropped: 2 })
    for (let t = 0; t <= 1000; t += 100) loop.frame(t)
    const data = wrote[0].data as Record<string, number>
    expect(data.inferP50).toBe(21)
    expect(data.inferP95).toBe(44)
    // Отбросы СКЛАДЫВАЮТСЯ за секунду, а не затираются последним сообщением.
    expect(data.drops).toBe(5)
  })

  test('первый кадр экрана не считает секунду от НУЛЯ часов', () => {
    /*
     * `performance.now()` на старте забега — не ноль. Если отсчёт секунды
     * ведётся от нуля, первый же кадр «опаздывает» на всё время работы
     * страницы и сводка пишется немедленно, за якобы сотни секунд. Прошлая
     * версия проверяла лишь `not.toThrow()`.
     */
    const wrote: Array<Record<string, unknown>> = []
    const loop = makeLoop({ step: () => undefined, write: (e) => wrote.push(e) })
    loop.frame(123456)
    expect(wrote.length).toBe(0)
    loop.frame(123456 + 500)
    expect(wrote.length).toBe(0)
    loop.frame(123456 + 1000)
    expect(wrote.length).toBe(1)
  })
})
