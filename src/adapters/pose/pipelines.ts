/**
 * Лестница конвейеров — ЯВНЫМ СПИСКОМ попыток.
 *
 * Не «попробовать и если что упасть», а перечисленный массив: порядок виден
 * глазами, принудительный выбор берётся из того же списка, и каждая
 * сошедшая ступень попадает в журнал. Запасной путь, который проверяется
 * только на телефоне ребёнка, — это запасной путь, который не работает;
 * поэтому любой из них включается принудительно через `?pipeline=`.
 *
 * Разбор: `docs/camera-and-pose.md`.
 */

import type { Delegate } from './pack'

/**
 * Три пути доставки кадров до MediaPipe, по убыванию желательности:
 *
 * - `stream` — дорожка клонируется, `MediaStreamTrackProcessor` отдаёт поток
 *   воркеру. Копий кадра нет, главный поток на кадр не делает ничего.
 * - `bitmap` — кадр снимается на главном потоке и передаётся воркеру; поток
 *   управления — по подтверждению от воркера. Стоит копии и синхронизации
 *   GPU, то есть частично возвращает ту работу, которую мы и выносили.
 * - `main` — инференс на главном потоке цепочкой таймаутов, а НЕ из `rAF`:
 *   синхронный блок внутри кадра превращает потерю одного кадра в потерю двух.
 */
export type PipelineMode = 'stream' | 'bitmap' | 'main'

export type Pipeline = { mode: PipelineMode; delegate: Delegate }

/**
 * Объявленный порядок попыток. Заморожен: лестница — это описание, которое
 * читают глазами и журналом, а не состояние, которое правят на ходу.
 *
 * `main` стоит последним и только с GPU: он и так последний запасной путь, и
 * `main/CPU` на Snapdragon 695 не даёт игровой частоты ни в каком виде —
 * ступень, которая заведомо не работает, честнее не обещать.
 */
export const PIPELINES: readonly Pipeline[] = Object.freeze([
  Object.freeze({ mode: 'stream', delegate: 'GPU' }),
  Object.freeze({ mode: 'stream', delegate: 'CPU' }),
  Object.freeze({ mode: 'bitmap', delegate: 'GPU' }),
  Object.freeze({ mode: 'main', delegate: 'GPU' }),
] as const) as readonly Pipeline[]

/** Имя конвейера для журнала и для `?pipeline=`. */
export const pipelineId = (p: Pipeline): string => `${p.mode}/${p.delegate}`

/**
 * Ошибок инференса ПОДРЯД, после которых текущий конвейер считается сошедшим.
 * Одиночная ошибка бывает и на живом конвейере (кадр пришёл закрытым,
 * например), а пять подряд — это уже не кадр.
 */
export const ERRORS_BEFORE_NEXT = 5

/** Что делать после отказа: остаться, перейти к следующей попытке, сдаться. */
export type LadderStep = 'stay' | 'next' | 'exhausted'

export type Ladder = {
  /** Текущая попытка, либо `null`, если лестница исчерпана. */
  current(): Pipeline | null
  /** Одна ошибка инференса. Пятая подряд переводит на следующую попытку. */
  onError(): LadderStep
  /** Кадр посчитан: счётчик ошибок обнуляется — ошибки должны быть ПОДРЯД. */
  onSuccess(): void
  /** Конвейер не открылся вовсе (не завёлся воркер, нет ответа `ready`). */
  onDown(): LadderStep
  /** Номер текущей ступени, для журнала. */
  index(): number
}

/**
 * Состояние лестницы. Чистое: ни таймеров, ни журнала — сюда приходят
 * сообщения об отказах, отсюда уходит решение. Поэтому проверяется тестом,
 * в отличие от самих конвейеров.
 */
export function makeLadder(list: readonly Pipeline[] = PIPELINES): Ladder {
  let i = 0
  let errors = 0

  /** Шаг вниз по лестнице. Исчерпание называется явно, а не молчит. */
  const advance = (): LadderStep => {
    errors = 0
    i++
    return i < list.length ? 'next' : 'exhausted'
  }

  return {
    current: () => list[i] ?? null,
    onError: () => (++errors >= ERRORS_BEFORE_NEXT ? advance() : 'stay'),
    onSuccess: () => {
      errors = 0
    },
    onDown: advance,
    index: () => i,
  }
}

/**
 * Разбор `?pipeline=` в лестницу принудительных попыток, либо `null`, если
 * флага нет или в нём мусор.
 *
 * Принимает и целую строку запроса (`'?pipeline=stream'`), и само значение
 * (`'stream'`).
 *
 * `?pipeline=stream` — это «проверь путь stream», а не «запрети ему CPU»:
 * отладочный экран включает ПУТЬ, а делегат врёт сам по себе, и права
 * перейти с GPU на CPU внутри выбранного пути лестница не теряет.
 * `?pipeline=stream/CPU` — ровно одна попытка, когда проверяют именно её.
 */
export function parsePipelineFlag(input: string | null | undefined): readonly Pipeline[] | null {
  if (!input) return null

  let value = input
  if (input.includes('=')) {
    const found = new URLSearchParams(input.startsWith('?') ? input.slice(1) : input).get('pipeline')
    if (!found) return null
    value = found
  }

  const [mode, delegate] = value.split('/')
  const picked = PIPELINES.filter(
    (p) => p.mode === mode && (delegate === undefined || p.delegate === delegate),
  )
  return picked.length ? picked : null
}
