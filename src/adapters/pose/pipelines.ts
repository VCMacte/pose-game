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
 *
 * **Порог ровно один на весь источник позы,** и это требование, а не удобство.
 * Считают ошибки ДВА разных исполнителя — воркер (`worker.ts`) и путь на
 * главном потоке (`source.ts`), — и раньше второй держал порог числом `5` в
 * коде, не импортируя эту константу вовсе. Тест при этом стоял над третьим,
 * никем не вызываемым счётчиком внутри лестницы: правка этой строки на `3`
 * ничего в бою не меняла, а прогон оставался зелёным. Поэтому счётчик здесь
 * один (`makeErrorRun`), им пользуются оба исполнителя, и он же проверяется
 * тестом — проверяемый автомат и есть рабочий.
 */
export const ERRORS_BEFORE_NEXT = 5

/**
 * Счётчик ошибок ПОДРЯД для одной ступени. `onError()` отдаёт `true` ровно на
 * той ошибке, после которой ступень считается сошедшей, и сам обнуляется:
 * отказ объявляется один раз, а не на каждом следующем кадре.
 *
 * Обнуление успехом обязательно: без него ступень съезжала бы от пяти редких
 * одиночных сбоев, разнесённых по минутам, — ошибки должны быть ПОДРЯД.
 */
export type ErrorRun = {
  /** Одна ошибка инференса. `true` — ступень сошла. */
  onError(): boolean
  /** Кадр посчитан: счётчик обнуляется. */
  onSuccess(): void
}

export function makeErrorRun(limit: number = ERRORS_BEFORE_NEXT): ErrorRun {
  let errors = 0
  return {
    onError: () => {
      if (++errors < limit) return false
      errors = 0
      return true
    },
    onSuccess: () => {
      errors = 0
    },
  }
}

/** Что делать после отказа ступени: следующая попытка или конец лестницы. */
export type LadderStep = 'next' | 'exhausted'

export type Ladder = {
  /** Текущая попытка, либо `null`, если лестница исчерпана. */
  current(): Pipeline | null
  /**
   * Ступень сошла — не открылась или умерла после `ready`. Счёта ошибок здесь
   * НЕТ намеренно: его ведёт `makeErrorRun` там, где кадры и считаются, а
   * второй счётчик в лестнице был бы ровно тем сторожем, который сторожит сам
   * себя.
   */
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

  return {
    current: () => list[i] ?? null,
    onDown: (): LadderStep => {
      i++
      return i < list.length ? 'next' : 'exhausted'
    },
    index: () => i,
  }
}

/**
 * Само значение `?pipeline=`, как его написали, либо `null`, если флага нет.
 *
 * Отдельно от разбора, потому что «флага нет» и «флаг не совпал ни с чем» —
 * РАЗНЫЕ случаи, а `parsePipelineFlag` отдаёт на оба один `null`. На штативе
 * опечатка (или намеренно отсутствующий `main/CPU`) без этой строки выглядит
 * как «мой принудительный выбор молча проигнорировали», и понять, почему
 * поехала полная лестница, не из чего. Отвергнутое значение называется в
 * журнале — см. `pose.source` в `source.ts`.
 */
export function pipelineFlagValue(input: string | null | undefined): string | null {
  if (!input) return null
  if (!input.includes('=')) return input
  return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input).get('pipeline')
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
  const value = pipelineFlagValue(input)
  if (value === null) return null

  const [mode, delegate] = value.split('/')
  const picked = PIPELINES.filter(
    (p) => p.mode === mode && (delegate === undefined || p.delegate === delegate),
  )
  return picked.length ? picked : null
}
