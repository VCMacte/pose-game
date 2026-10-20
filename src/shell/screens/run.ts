/**
 * Экран забега: холст, кнопка паузы и меню паузы.
 *
 * **Ни одной НАСТРОЙКИ здесь нет.** Всё, что меняет правила игры, спрятано под
 * взрослого: забег — то время, когда выбирать нечего. Пауза — не настройка, а
 * управление: ребёнок вправе остановиться и отдохнуть.
 *
 * Забег начинается с КАЛИБРОВКИ, когда её нет или она устарела, и отдельной
 * кнопки для неё в меню не предусмотрено: ребёнок не должен выбирать между
 * «играть» и «сначала калибровка».
 *
 * Разбор: `docs/render-and-layout.md`, `docs/calibration.md`,
 * `docs/menu-and-settings.md`.
 */

import { button, el } from '../dom'

/** Что сейчас происходит на экране забега. */
export type RunStage = 'calibration' | 'round' | 'paused' | 'finished'

export type RunScreenOpts = {
  onPause(): void
  onResume(): void
  onMenu(): void
}

export type RunScreen = {
  root: HTMLElement
  canvas: HTMLCanvasElement
  /** Строка-подсказка поверх холста: калибровка, пауза, итог. */
  say(text: string): void
  /**
   * Показать или убрать меню паузы.
   *
   * `manual` — пауза РУЧНАЯ. Меню показывается только на ней, и это главное
   * решение экрана: на автопаузе ребёнок всего лишь вышел из кадра, таких
   * эпизодов за забег бывает несколько, и предлагать там «вернуться в меню»
   * значило бы предлагать бросить забег из-за секундной отлучки. На автопаузе
   * экран лишь говорит, что случилось, и ждёт возвращения.
   *
   * `canResume` — присутствие подтвердило возврат. Пока нет, «Продолжить»
   * показано отключённым с пояснением, а не отсутствует: кнопка, которая
   * пропала, выглядит сломанной игрой, а отключённая объясняет себя.
   */
  pauseMenu(show: boolean, canResume: boolean): void
}

export function runScreen(o: RunScreenOpts): RunScreen {
  const canvas = el('canvas', { 'data-test': 'canvas' })
  const hint = el('div', { class: 'hint', 'data-test': 'hint' })

  /*
   * Кнопка паузы — ЕДИНСТВЕННАЯ кнопка на экране забега, и она крупная: по ней
   * попадает палец ребёнка, не глядя. Ритуалов у неё нет — то же решение, что
   * и у входа на экраны взрослого.
   */
  const pauseBtn = button('⏸', o.onPause, {
    'data-test': 'pause',
    class: 'pause-btn',
    'aria-label': 'Пауза',
  })

  const resumeBtn = button('ПРОДОЛЖИТЬ', o.onResume, { 'data-test': 'resume', class: 'play' })
  const menuBtn = button('Вернуться в меню', o.onMenu, { 'data-test': 'to-menu' })

  const menu = el('div', { class: 'pause-menu', 'data-test': 'pause-menu', hidden: true }, [
    el('h1', { text: 'Пауза' }),
    el('p', { text: 'Можно передохнуть' }),
    resumeBtn,
    menuBtn,
  ])

  const root = el('div', { class: 'screen run' }, [canvas, hint, pauseBtn, menu])

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
    pauseMenu: (show, canResume) => {
      menu.hidden = !show
      // Кнопка паузы на самой паузе ни к чему: нажимать её второй раз незачем.
      pauseBtn.hidden = show
      resumeBtn.disabled = !canResume
      resumeBtn.title = canResume ? '' : 'Встань в кадр, чтобы продолжить'
    },
  }
}
