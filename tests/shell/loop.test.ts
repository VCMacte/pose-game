/**
 * Два независимых такта: кадр камеры и кадр экрана.
 *
 * Главный инвариант покадрового пути, и он стоит здесь, а не в тестах экранов:
 * DOM к нему отношения не имеет вовсе.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */
import { describe, expect, test } from 'vitest'

import { CONFIG } from '../../src/core/config'
import { MAX_STEP_MS, makeLoop } from '../../src/shell/loop'
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

/*
 * Замершая страница: звонок, будильник, свёрнутое приложение. Такт экрана при
 * этом не вызывается вовсе, а потом приходит ОДИН кадр с разрывом в десятки
 * секунд. Приём перенесён из `run-game` (`js/train.js:620-628`): игровое время
 * продвигается зажатым шагом, и «замершая страница продолжится с того же
 * места». Без зажима ядро закрывает в одном тике все раунды, чьё время вышло,
 * — забег кончается мгновенно, как в живом прогоне 21.10.2026.
 */
describe('замершая страница не съедает забег', () => {
  test('разрыв между кадрами экрана продвигает игровое время ЗАЖАТЫМ шагом', () => {
    const seen: number[] = []
    const loop = makeLoop({ step: (t) => void seen.push(t) })
    loop.frame(1000)
    // Страница замерла на минуту.
    loop.frame(61_000)
    expect(seen[0]).toBe(1000)
    expect(seen[1] - seen[0]).toBeLessThanOrEqual(MAX_STEP_MS)

    /*
     * Сам зажим обязан быть осмысленным, иначе проверка выше сравнивает
     * значение с самим собой и проходит при любом: короче окна судейства (600
     * мс) — чтобы внутри окна оставалось несколько тиков, — и длиннее любого
     * настоящего кадра экрана, чтобы не замедлять игру на медленном телефоне.
     */
    expect(MAX_STEP_MS).toBeLessThan(CONFIG.judge.windowMs)
    expect(MAX_STEP_MS).toBeGreaterThan(150)
  })

  test('игровое время не идёт назад ни при каком разрыве', () => {
    // `run.tick` на времени назад бросает, и это намеренно: такое время —
    // всегда дефект оболочки.
    const seen: number[] = []
    const loop = makeLoop({ step: (t) => void seen.push(t) })
    for (const t of [1000, 1016, 90_000, 90_016, 300_000]) loop.frame(t)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })

  test('кадр, пришедший ДО разрыва, сохраняет своё игровое время', () => {
    /*
     * Главная опасность зажима: часы тика и часы кадра разъезжаются, а это тот
     * самый класс дефекта, что убил первый живой прогон. Кадр, положенный в
     * буфер до разрыва, обязан прийти в `step` с тем же временем, с каким
     * пришёл бы без разрыва вовсе.
     */
    const seen: Array<{ t: number; frames: number[] }> = []
    const loop = makeLoop({ step: (t, f) => void seen.push({ t, frames: f.map((x) => x.t) }) })
    loop.frame(1000)
    loop.sample(frame(1010))
    loop.frame(61_000)
    expect(seen[1].frames).toEqual([1010])
  })

  test('кадр, пришедший ПОСЛЕ разрыва, не уезжает в будущее на всю его длину', () => {
    /*
     * Кадры датированы настоящими часами, и после минутного разрыва их отметка
     * на минуту впереди игрового времени. Такой кадр обязан оказаться рядом с
     * тиком, а не на минуту позже него: окно судейства отбирает кадры по
     * времени, и улетевший кадр не попал бы ни в одно окно.
     */
    const seen: Array<{ t: number; frames: number[] }> = []
    const loop = makeLoop({ step: (t, f) => void seen.push({ t, frames: f.map((x) => x.t) }) })
    loop.frame(1000)
    loop.frame(61_000)
    loop.sample(frame(61_010))
    loop.frame(61_026)
    const last = seen[seen.length - 1]
    expect(last.frames[0]).toBeLessThanOrEqual(last.t)
    expect(last.t - last.frames[0]).toBeLessThan(100)
  })

  test('кадры, накопившиеся ЗА время замирания, в судейство не идут', () => {
    /*
     * Найдено код-ревью, и это худшая половина зажима. Конвейеры позы не живут
     * на `requestAnimationFrame`: воркер и цепочка таймаутов продолжают
     * слать кадры скрытой странице. Без отбора все они пришли бы одним тиком,
     * зажались ядром в ОДНУ отметку времени и перевесили бы голосование —
     * сотни кадров против обычных семи, причём снятых тогда, когда игра не
     * показывала ребёнку ничего. Это ровно «приговор за то, чего игра не
     * видела», и бюджет журнала такой всплеск тоже съел бы.
     */
    const seen: number[][] = []
    const loop = makeLoop({ step: (_t, f) => void seen.push(f.map((x) => x.t)) })
    loop.frame(1000)

    // Страница замерла на минуту, а кадры всё шли — двенадцать в секунду.
    for (let t = 1010; t <= 61_000; t += 83) loop.sample(frame(t))
    loop.frame(61_000)

    /*
     * Остаются только те, что годятся по времени: игра продолжается с того
     * места, где встала, и судит по кадрам этого места, а не всей минуты.
     */
    expect(seen[1].length).toBeLessThan(10)
  })

  test('сводка здоровья считается по РЕАЛЬНОМУ времени, а не по зажатому', () => {
    /*
     * Урок `run-game`: мера, посчитанная после зажима, слепа к провалам, ради
     * которых её и смотрят. Секунда сводки — настоящая секунда, иначе после
     * разрыва `fps` окажется сотнями.
     */
    const wrote: Array<Record<string, unknown>> = []
    const loop = makeLoop({ step: () => undefined, write: (e) => wrote.push(e) })
    loop.frame(0)
    loop.frame(30_000)
    expect(wrote.length).toBe(1)
    const data = wrote[0].data as Record<string, number>
    // Два кадра экрана за тридцать реальных секунд — это ноль fps, а не сорок.
    expect(data.fps).toBe(0)
  })
})
