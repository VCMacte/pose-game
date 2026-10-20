/**
 * Оболочка: три экрана, их переключение и два независимых такта забега.
 *
 * Всё, что трогает браузер, приходит ЗАВИСИМОСТЬЮ — камера, звук, источник
 * позы, часы, `requestAnimationFrame`. Не ради тестов (хотя и ради них тоже), а
 * потому что ядро обязано запускаться из node над записанным журналом: иначе
 * разбор спорного раунда требует переигрывания с ребёнком.
 * → `docs/architecture.md`
 *
 * **Ориентация задаётся поэкранно, не манифестом:** меню портретное, забег
 * горизонтальный. Манифест задал бы одну на всё приложение.
 *
 * Разбор: `docs/menu-and-settings.md`, `docs/render-and-layout.md`.
 */

import type { Audio } from '../adapters/audio'
import { createRenderer } from '../adapters/render/canvas'
import type { Renderer } from '../adapters/render/canvas'
import { makeSettings, timingsFor, toggleBlocked } from '../adapters/settings'
import type { Settings } from '../adapters/settings'
import type { PoseTag } from '../core/types'
import { makeLoop } from './loop'
import type { Loop } from './loop'
import { menuScreen } from './screens/menu'
import { runScreen } from './screens/run'
import type { RunScreen, RunStage } from './screens/run'
import { serviceScreen } from './screens/service'
import type { Debug, ServiceInfo } from './screens/service'
import { settingsScreen } from './screens/settings'

export type ScreenName = 'menu' | 'run' | 'settings' | 'service'

export type AppDeps = {
  settings?: Settings
  audio?: Audio
  /** `requestAnimationFrame` и его отмена. Подменяются в тестах. */
  raf?: (cb: (t: number) => void) => number
  cancelRaf?: (id: number) => void
  now?: () => number
  /** Рендер по холсту. Подменяется в тестах: Canvas2D в node нет. */
  renderer?: (c: HTMLCanvasElement) => Renderer
  /** Сводка для служебного экрана. Собирается снаружи: журнал — адаптер. */
  serviceInfo?: () => ServiceInfo
  /** Лучшие результаты. Снаружи же, по той же причине. */
  best?: () => { allTime: number; last: number }
}

export type App = {
  screen(): ScreenName
  go(s: ScreenName): void
  /** Ориентация текущего экрана — поэкранно, не манифестом. */
  orientation(): 'portrait' | 'landscape'
  /** На какой стадии забег. Вне забега — `null`. */
  runStage(): RunStage | null
  /** Заблокирован ли тумблер словаря: то же, что показывает интерфейс. */
  blockedToggle(tag: string): boolean
  readonly settings: Settings
  stop(): void
}

const EMPTY_INFO: ServiceInfo = {
  log: { sessions: 0, events: 0, bytes: 0, broken: false },
  latency: null,
  build: { version: 'dev', date: '—', modelCached: false },
}

export function startApp(root: HTMLElement, deps: AppDeps = {}): App {
  const settings = deps.settings ?? makeSettings()
  const raf = deps.raf ?? ((cb) => requestAnimationFrame(cb))
  const cancelRaf = deps.cancelRaf ?? ((id) => cancelAnimationFrame(id))
  const makeRenderer = deps.renderer ?? createRenderer
  const serviceInfo = deps.serviceInfo ?? ((): ServiceInfo => EMPTY_INFO)
  const best = deps.best ?? ((): { allTime: number; last: number } => ({ allTime: 0, last: 0 }))

  let screen: ScreenName = 'menu'
  let stopped = false
  let rafId: number | null = null
  let stage: RunStage | null = null
  let loop: Loop | null = null
  let rs: RunScreen | null = null
  const debug: Debug = { source: 'камера', pipeline: 'авто' }

  /** Гасит такт экрана. Иначе два забега подряд дают два живых цикла rAF. */
  const stopFrames = (): void => {
    if (rafId !== null) {
      cancelRaf(rafId)
      rafId = null
    }
    loop = null
    rs = null
    stage = null
  }

  function startFrames(): void {
    const screenRun = runScreen()
    rs = screenRun
    /*
     * Калибровка — ПЕРВАЯ стадия забега, а не отдельный экран и не кнопка в
     * меню. Нет калибровки или она устарела — забег начинается с неё сам.
     */
    stage = 'calibration'
    screenRun.say('Встань прямо и постой пять секунд')

    let renderer: Renderer | null = null
    try {
      renderer = makeRenderer(screenRun.canvas)
    } catch {
      /*
       * Нет Canvas2D — сказать вслух и остаться на экране: молча не рисующая
       * игра на штативе неотличима от мёртвой камеры.
       */
      screenRun.say('Рисовать нечем: холст недоступен')
    }

    const theLoop = makeLoop({
      step: () => {
        /*
         * Здесь встанет `run.tick(t, frames)` и `renderer.render(scene)`, когда
         * забег подключат к источнику позы (задача 21). Разделение такта уже
         * на месте и уже под тестом: кадр камеры только кладёт кадр в буфер,
         * кадр экрана его забирает.
         */
        void renderer
        return { valid: 0, lost: 0 }
      },
    })
    loop = theLoop

    const tick = (t: number): void => {
      if (stopped || screen !== 'run') return
      theLoop.frame(t)
      rafId = raf(tick)
    }
    rafId = raf(tick)

    root.replaceChildren(screenRun.root)
  }

  function draw(): void {
    if (stopped) return

    if (screen === 'run') {
      // Экран забега рисуется один раз: дальше его двигает такт экрана, а не
      // перерисовка DOM.
      if (!rs) startFrames()
      return
    }

    stopFrames()

    if (screen === 'menu') {
      root.replaceChildren(
        menuScreen({
          settings,
          best: best(),
          onPlay: () => go('run'),
          onAdult: () => go('settings'),
          refresh: draw,
        }),
      )
      return
    }

    if (screen === 'settings') {
      root.replaceChildren(
        settingsScreen({ settings, onBack: () => go('menu'), refresh: draw }),
      )
      return
    }

    root.replaceChildren(
      serviceScreen({
        settings,
        info: serviceInfo(),
        debug,
        onDebug: (patch) => Object.assign(debug, patch),
        onBack: () => go('menu'),
        onMeasureLatency: () => {},
        onShareLog: () => {},
        onClearLog: () => {},
        onRecalibrate: () => {},
        refresh: draw,
      }),
    )
  }

  function go(next: ScreenName): void {
    if (stopped) return
    screen = next
    draw()
  }

  draw()

  return {
    screen: () => screen,
    go,
    orientation: () => (screen === 'run' ? 'landscape' : 'portrait'),
    runStage: () => stage,
    blockedToggle: (tag) => toggleBlocked(settings, tag as PoseTag),
    settings,
    stop: () => {
      if (stopped) return
      stopped = true
      stopFrames()
    },
  }
}

/** Такт, которым пойдёт забег. Читается ЖИВО, на каждом раунде. */
export { timingsFor }
