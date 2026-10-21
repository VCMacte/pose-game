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
   * Аварийная строка: что СЛОМАЛОСЬ. Живёт, пока её не снимут `alarm(null)`.
   *
   * Отдельно от `say` она не из любви к слоям. `say` зовётся КАЖДЫЙ кадр
   * экрана, и аварийное сообщение, написанное через него, жило ~16 мс: в
   * первом живом прогоне на телефоне не было видно ни одного отказа — ни
   * «камеры нет», ни «источник не запустился», — хотя все три писались в код
   * честно. Телефон стоит на штативе, консоли у него нет; строка на экране —
   * единственный способ узнать, что случилось.
   */
  alarm(text: string | null): void
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
  /**
   * Меню законченного забега: только выход.
   *
   * Отдельно от `pauseMenu` — потому что это не пауза. Меню паузы на
   * законченном забеге не показывается по построению, и выхода с экрана не
   * оставалось вовсе: кнопка паузы видна и мертва (`pauseManual` молчит вне
   * `running`), возвращаться некуда. Ровно это на телефоне и прочли как
   * «кнопка паузы не работает».
   */
  finishMenu(show: boolean): void
}

export function runScreen(o: RunScreenOpts): RunScreen {
  const canvas = el('canvas', { 'data-test': 'canvas' })
  const hint = el('div', { class: 'hint', 'data-test': 'hint' })
  const alarm = el('div', { class: 'alarm', 'data-test': 'alarm', hidden: true })

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

  const menuTitle = el('h1', { text: 'Пауза' })
  const menuNote = el('p', { text: 'Можно передохнуть' })

  const menu = el('div', { class: 'pause-menu', 'data-test': 'pause-menu', hidden: true }, [
    menuTitle,
    menuNote,
    resumeBtn,
    menuBtn,
  ])

  const root = el('div', { class: 'screen run' }, [canvas, hint, alarm, pauseBtn, menu])

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
    alarm: (text) => {
      alarm.textContent = text ?? ''
      alarm.hidden = text === null
    },
    pauseMenu: (show, canResume) => {
      menu.hidden = !show
      menuTitle.textContent = 'Пауза'
      menuNote.textContent = 'Можно передохнуть'
      resumeBtn.hidden = false
      // Кнопка паузы на самой паузе ни к чему: нажимать её второй раз незачем.
      pauseBtn.hidden = show
      resumeBtn.disabled = !canResume
      resumeBtn.title = canResume ? '' : 'Встань в кадр, чтобы продолжить'
    },
    finishMenu: (show) => {
      menu.hidden = !show
      if (!show) return
      menuTitle.textContent = 'Забег окончен'
      menuNote.textContent = 'Можно сыграть ещё раз'
      // Продолжать нечего: забег доигран. Кнопка не отключается, а убирается —
      // отключённая объясняла бы себя подсказкой, которой здесь не бывает.
      resumeBtn.hidden = true
      // Кнопка паузы на законченном забеге только путает: нажимать нечего.
      pauseBtn.hidden = true
    },
  }
}
