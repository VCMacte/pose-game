/**
 * Чистые части источника позы: часы инференса, упаковка точек и лестница
 * конвейеров.
 *
 * Воркер и камера здесь НЕ проверяются, и это решение, а не пробел. Воркер
 * живёт поверх `importScripts`, wasm и `MediaStreamTrackProcessor`, которых в
 * node нет; тест, изображающий их заглушкой, проверил бы заглушку, а не
 * MediaPipe. Живая проверка воркера — на телефоне (задача 23), и единственный
 * её аппарат — журнал.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */
import { describe, expect, test } from 'vitest'

import { makeClock, packLandmarks } from '../../src/adapters/pose/pack'
import {
  ERRORS_BEFORE_NEXT,
  PIPELINES,
  makeLadder,
  parsePipelineFlag,
  pipelineId,
} from '../../src/adapters/pose/pipelines'
import { LANDMARK_COUNT, LANDMARK_STRIDE, pointAt } from '../../src/core/landmarks'

/** Результат MediaPipe с одним человеком из `n` точек. */
function result(points: Array<Record<string, number>>): { landmarks: Array<Array<Record<string, number>>> } {
  return { landmarks: [points] }
}

/** 33 точки, все одинаковые — удобная заготовка, в которую правят нужную. */
function full(p: Record<string, number> = { x: 0.5, y: 0.5, z: 0, visibility: 1 }) {
  return Array.from({ length: LANDMARK_COUNT }, () => ({ ...p }))
}

describe('makeClock — строго возрастающие целые миллисекунды', () => {
  test('одинаковый вход всё равно даёт возрастание', () => {
    const clock = makeClock()
    // Два кадра с одной меткой роняют wasm abort'ом НАВСЕГДА, до перезагрузки
    // страницы: ни ошибки наружу, ни возможности восстановиться.
    expect([clock(100), clock(100), clock(100)]).toEqual([100, 101, 102])
  })

  test('убывающий вход всё равно даёт возрастание', () => {
    const clock = makeClock()
    expect(clock(1000)).toBe(1000)
    expect(clock(900)).toBe(1001)
    expect(clock(0)).toBe(1002)
    expect(clock(-5000)).toBe(1003)
  })

  test('отдаёт целые числа при дробном входе', () => {
    const clock = makeClock()
    const out = [clock(10.4), clock(10.6), clock(11.2)]
    expect(out.every(Number.isInteger)).toBe(true)
    expect(out).toEqual([10, 11, 12])
  })

  test('нечисловая метка не ломает монотонность', () => {
    // `performance.now()` не отдаёт NaN, но метка приходит и от кадра
    // (`frame.timestamp`), где отсутствующее поле даёт NaN. Пропустить его
    // значит отдать NaN в wasm — то есть тот же abort.
    const clock = makeClock()
    expect(clock(50)).toBe(50)
    expect(clock(Number.NaN)).toBe(51)
    expect(clock(Number.POSITIVE_INFINITY)).toBe(52)
  })

  test('часы независимы друг от друга', () => {
    const a = makeClock()
    const b = makeClock()
    a(5000)
    expect(b(10)).toBe(10)
  })
})

describe('packLandmarks — 33×4 плоско', () => {
  test('кладёт 33 точки по четыре поля', () => {
    const lm = packLandmarks(result(full()))
    expect(lm).toBeInstanceOf(Float32Array)
    expect(lm?.length).toBe(LANDMARK_COUNT * LANDMARK_STRIDE)
  })

  test('точки кладутся по порядку и читаются ядром', () => {
    const points = full()
    points[0] = { x: 0.25, y: 0.5, z: -0.125, visibility: 0.75 }
    points[32] = { x: 0.75, y: 0.25, z: 0.5, visibility: 0.5 }
    const lm = packLandmarks(result(points))!

    expect(pointAt(lm, 0)).toEqual({ x: 0.25, y: 0.5, z: -0.125, visibility: 0.75 })
    expect(pointAt(lm, 32)).toEqual({ x: 0.75, y: 0.25, z: 0.5, visibility: 0.5 })
  })

  test('visibility ?? presence ?? 1 — поле зовётся по-разному в разных версиях', () => {
    const points = full()
    points[1] = { x: 0, y: 0, z: 0, presence: 0.25 }
    points[2] = { x: 0, y: 0, z: 0 }
    points[3] = { x: 0, y: 0, z: 0, visibility: 0.5, presence: 0.125 }

    const lm = packLandmarks(result(points))!

    expect(pointAt(lm, 1).visibility).toBe(0.25)
    // Отсутствие поля даёт не ноль: ноль прочитался бы как «ребёнка не видно»,
    // то есть молчаливый отказ судить там, где модель точку нашла.
    expect(pointAt(lm, 2).visibility).toBe(1)
    expect(pointAt(lm, 3).visibility).toBe(0.5)
  })

  test('отсутствующий z — ноль, а не NaN', () => {
    const points = full()
    points[5] = { x: 0.5, y: 0.5, visibility: 1 }
    expect(pointAt(packLandmarks(result(points))!, 5).z).toBe(0)
  })

  test('нет позы — null, а не массив нулей', () => {
    expect(packLandmarks(null)).toBeNull()
    expect(packLandmarks(undefined)).toBeNull()
    expect(packLandmarks({})).toBeNull()
    expect(packLandmarks({ landmarks: [] })).toBeNull()
    expect(packLandmarks(result([]))).toBeNull()
  })

  test('неполный скелет — null: судить по дырявому нельзя', () => {
    expect(packLandmarks(result(full().slice(0, 32)))).toBeNull()
  })

  test('берётся первый человек', () => {
    const mine = full({ x: 0.25, y: 0.25, z: 0, visibility: 1 })
    const other = full({ x: 0.75, y: 0.75, z: 0, visibility: 1 })
    const lm = packLandmarks({ landmarks: [mine, other] })!
    expect(pointAt(lm, 0).x).toBe(0.25)
  })
})

describe('лестница конвейеров', () => {
  test('перечисляет попытки в объявленном порядке', () => {
    expect(PIPELINES.map(pipelineId)).toEqual(['stream/GPU', 'stream/CPU', 'bitmap/GPU', 'main/GPU'])
  })

  test('лестница заморожена: подправить её на ходу нельзя', () => {
    expect(Object.isFrozen(PIPELINES)).toBe(true)
  })

  test('пять ошибок подряд переводят на следующую попытку', () => {
    const ladder = makeLadder()
    expect(pipelineId(ladder.current()!)).toBe('stream/GPU')

    for (let i = 1; i < ERRORS_BEFORE_NEXT; i++) {
      expect(ladder.onError()).toBe('stay')
      expect(pipelineId(ladder.current()!)).toBe('stream/GPU')
    }
    expect(ladder.onError()).toBe('next')
    expect(pipelineId(ladder.current()!)).toBe('stream/CPU')
  })

  test('успешный кадр обнуляет счётчик: ошибки должны быть ПОДРЯД', () => {
    const ladder = makeLadder()
    for (let i = 1; i < ERRORS_BEFORE_NEXT; i++) ladder.onError()
    ladder.onSuccess()
    for (let i = 1; i < ERRORS_BEFORE_NEXT; i++) expect(ladder.onError()).toBe('stay')
    expect(pipelineId(ladder.current()!)).toBe('stream/GPU')
  })

  test('отказ открытия конвейера переводит сразу, без счёта ошибок', () => {
    const ladder = makeLadder()
    expect(ladder.onDown()).toBe('next')
    expect(pipelineId(ladder.current()!)).toBe('stream/CPU')
  })

  test('исчерпание лестницы называется явно', () => {
    const ladder = makeLadder()
    expect(ladder.onDown()).toBe('next')
    expect(ladder.onDown()).toBe('next')
    expect(ladder.onDown()).toBe('next')
    expect(ladder.onDown()).toBe('exhausted')
    expect(ladder.current()).toBeNull()
  })

  test('принудительный выбор режима оставляет ему смену делегата', () => {
    // `?pipeline=stream` — это «проверь путь stream», а не «запрети ему CPU»:
    // отладочный экран включает ПУТЬ, а делегат врёт сам по себе.
    expect(parsePipelineFlag('stream')!.map(pipelineId)).toEqual(['stream/GPU', 'stream/CPU'])
    expect(parsePipelineFlag('?pipeline=bitmap')!.map(pipelineId)).toEqual(['bitmap/GPU'])
  })

  test('принудительный выбор с делегатом — ровно одна попытка', () => {
    expect(parsePipelineFlag('stream/CPU')!.map(pipelineId)).toEqual(['stream/CPU'])
    expect(parsePipelineFlag('?pipeline=main%2FGPU')!.map(pipelineId)).toEqual(['main/GPU'])
  })

  test('нет флага или мусор в нём — полная лестница', () => {
    expect(parsePipelineFlag(null)).toBeNull()
    expect(parsePipelineFlag('')).toBeNull()
    expect(parsePipelineFlag('?debug=1')).toBeNull()
    expect(parsePipelineFlag('?pipeline=stream/TPU')).toBeNull()
    expect(parsePipelineFlag('?pipeline=вертолёт')).toBeNull()
  })

  test('принудительная лестница исчерпывается, а не зацикливается', () => {
    const ladder = makeLadder(parsePipelineFlag('main')!)
    expect(pipelineId(ladder.current()!)).toBe('main/GPU')
    expect(ladder.onDown()).toBe('exhausted')
    expect(ladder.current()).toBeNull()
  })
})
