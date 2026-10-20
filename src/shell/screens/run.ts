/**
 * Экран забега: один холст и ничего больше.
 *
 * **Ни одной настройки здесь нет.** Всё, что ребёнок мог бы нажать посреди
 * забега, спрятано под взрослого: забег — это то время, когда выбирать нечего.
 *
 * Забег начинается с КАЛИБРОВКИ, когда её нет или она устарела, и отдельной
 * кнопки для неё в меню не предусмотрено: ребёнок не должен выбирать между
 * «играть» и «сначала калибровка».
 *
 * Разбор: `docs/render-and-layout.md`, `docs/calibration.md`.
 */

import { el } from '../dom'

/** Что сейчас происходит на экране забега. */
export type RunStage = 'calibration' | 'round' | 'paused' | 'finished'

export type RunScreen = {
  root: HTMLElement
  canvas: HTMLCanvasElement
  /** Строка-подсказка поверх холста: калибровка, пауза, итог. */
  say(text: string): void
}

export function runScreen(): RunScreen {
  const canvas = el('canvas', { 'data-test': 'canvas' })
  const hint = el('div', { class: 'hint', 'data-test': 'hint' })
  const root = el('div', { class: 'screen run' }, [canvas, hint])

  return {
    root,
    canvas,
    say: (text) => {
      /*
       * Подсказка — DOM, а не Canvas, и это не непоследовательность. На Canvas
       * идёт покадровый путь, где запрещены тени, фильтры и всё, что стоит
       * кадров; текст подсказки меняется раз в несколько секунд, и платить за
       * него перерисовкой кадра нечем.
       */
      hint.textContent = text
    },
  }
}
