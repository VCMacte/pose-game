import { CONFIG } from './config'
import type { PoseSpec } from './types'

/**
 * Такты одного раунда: превью → стена → замирание → приговор
 * (docs/judging.md «Четыре такта раунда»).
 *
 * Три правила держат этот файл:
 *
 * - **Состояния анимации нет вовсе.** Раунд — это четыре отметки времени и
 *   функция `phaseAt(t)`; фаза считается от времени на каждом кадре, чтобы
 *   просадка кадра не развела расписание с картинкой. Автомат, ХРАНЯЩИЙ фазу,
 *   отставал бы ровно на пропущенные кадры.
 * - **Замирание равно настроенной задержке тракта и своим числом не
 *   настраивается.** Приговор физически недоступен раньше
 *   `contact + latency`: окно судейства сдвинуто ВПЕРЁД от касания стены
 *   (`judge.ts`), и до `verdictT` судить ещё нечего. Ребёнку такт читается как
 *   удержание позы — удачное совпадение, а не замысел.
 * - **Время приходит аргументом.** Часов внутри ядра нет: `performance.now()`
 *   сломал бы replay журнала из node, а replay — единственный способ разобрать
 *   спорный раунд, не переигрывая его с ребёнком.
 */

export type RoundPhase = 'preview' | 'wall' | 'freeze' | 'verdict'

/**
 * Длительности тактов. Замирания здесь нет: оно равно `latencyMs` — задержке
 * тракта «камера → телевизор», которую замеряет настройка (docs/judging.md).
 */
export type Timings = {
  previewMs: number
  wallMs: number
  /** Задержка тракта. Ею же длится такт замирания. */
  latencyMs: number
  verdictMs: number
}

/** Расписание одного раунда. Значение, а не автомат: менять в нём нечего. */
export type Round = {
  spec: PoseSpec
  startT: number
  /** Игровое время касания стены: конец такта стены, начало замирания. */
  contactT: number
  /** `contactT + latencyMs` — раньше приговор недоступен физически. */
  verdictT: number
  /** Конец раунда: за ним начинается превью следующего. */
  endT: number
  phaseAt(t: number): RoundPhase
}

/**
 * Такты из `CONFIG.round` с замером задержки тракта.
 *
 * Числа длительностей живут в `config.ts`, как все числа проекта, а не в
 * оболочке: иначе «такт раунда ≈ 5 с» разъехался бы между документацией и
 * экраном настроек.
 */
export function timingsFor(latencyMs: number): Timings {
  return {
    previewMs: CONFIG.round.previewMs,
    wallMs: CONFIG.round.wallMs,
    latencyMs,
    verdictMs: CONFIG.round.verdictMs,
  }
}

/**
 * Расписание раунда от `startT`.
 *
 * Нулевые и отрицательные такты отвергаются, и это не придирчивость: раунд
 * нулевой длины зацикливает продвижение расписания забега (`run.ts`
 * закрывает раунды, пока время дошло до `endT`). Задержка — исключение:
 * `latencyMs === 0` законен, замирания тогда нет вовсе.
 */
export function makeRound(spec: PoseSpec, startT: number, timings: Timings): Round {
  check('previewMs', timings.previewMs, 1)
  check('wallMs', timings.wallMs, 1)
  check('verdictMs', timings.verdictMs, 1)
  check('latencyMs', timings.latencyMs, 0)
  if (!Number.isFinite(startT)) throw new Error('makeRound: startT обязан быть числом')

  const wallT = startT + timings.previewMs
  const contactT = wallT + timings.wallMs
  const verdictT = contactT + timings.latencyMs
  const endT = verdictT + timings.verdictMs

  return {
    spec,
    startT,
    contactT,
    verdictT,
    endT,
    // Время вне границ зажимается крайними тактами, а не роняет раунд:
    // просадка кадра не обязана ронять картинку.
    phaseAt: (t: number): RoundPhase =>
      t < wallT ? 'preview' : t < contactT ? 'wall' : t < verdictT ? 'freeze' : 'verdict',
  }
}

function check(name: keyof Timings, value: number, min: number): void {
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`makeRound: ${name} обязан быть числом не меньше ${min}, получено ${value}`)
  }
}
