/**
 * Главное меню — единственный экран, который видит ребёнок.
 *
 * Только четыре вещи крупными кнопками: играть, результаты, длина забега,
 * сложность. Всё остальное спрятано под взрослого: цель «ребёнок играет сам»
 * ломается первым же выбором, которого он не понимает.
 *
 * **Кнопки «Тренировка» нет** — это не-цель первой версии. Силуэт включается
 * тумблером в настройках забега.
 *
 * **Отдельной кнопки калибровки тоже нет**: забег начинается с неё сам, когда
 * калибровки нет или она устарела. Ребёнок не должен выбирать между «играть» и
 * «сначала калибровка» — он не знает, что такое калибровка.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */

import { OPTIONS } from '../../adapters/settings'
import type { Settings } from '../../adapters/settings'
import { button, choice, el } from '../dom'

export type MenuOpts = {
  settings: Settings
  best: { allTime: number; last: number }
  onPlay(): void
  /** Вход на экраны взрослого. */
  onAdult(): void
  /** Перерисовать меню: выбор кнопкой меняет подсветку ряда. */
  refresh(): void
}

export function menuScreen(o: MenuOpts): HTMLElement {
  const s = o.settings

  return el('div', { class: 'screen menu' }, [
    el('div', { class: 'top' }, [
      /*
       * Вход на экраны взрослого — ПРОСТАЯ КНОПКА. Прежний приём (долгое
       * удержание правого верхнего угла) снят по решению заказчика; разбор
       * разворота и его цена — в docs/menu-and-settings.md.
       */
      button('⚙', o.onAdult, { 'data-test': 'adult', class: 'adult', 'aria-label': 'Настройки' }),
    ]),

    button('ИГРАТЬ', o.onPlay, { 'data-test': 'play', class: 'play' }),

    el('div', { class: 'best', 'data-test': 'best' }, [
      el('div', { text: `Лучший результат: ${o.best.allTime}` }),
      el('div', { text: `Прошлый забег: ${o.best.last}` }),
    ]),

    el('div', { class: 'row' }, [
      el('h2', { text: 'Длина забега' }),
      choice('duration', OPTIONS.durationSec, s.get('durationSec'), String, (v) => {
        s.set('durationSec', v)
        o.refresh()
      }),
    ]),

    el('div', { class: 'row' }, [
      el('h2', { text: 'Сложность' }),
      choice('tier', OPTIONS.tier, s.get('tier'), String, (v) => {
        s.set('tier', v)
        o.refresh()
      }),
    ]),
  ])
}
