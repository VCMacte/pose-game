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
import { dropCaches } from '../adapters/sw'
import { frameAspect } from '../adapters/camera'
import type { AspectSource } from '../adapters/camera'
import { write as journalWrite } from '../adapters/log/store'
import type { LogEvent } from '../adapters/log/store'
import { makeSettings, timingsFor, toggleBlocked } from '../adapters/settings'
import type { Settings } from '../adapters/settings'
import type { Calibration, Frame, PoseTag } from '../core/types'
import { makeLoop } from './loop'
import { makePlay } from './play'
import type { Play } from './play'
import type { Loop } from './loop'
import { menuScreen } from './screens/menu'
import type { MenuInfo } from './screens/menu'
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
  /** Куда писать журнал. По умолчанию — журнал приложения. */
  write?: (e: LogEvent) => void
  /** Генератор случайных чисел забега. По умолчанию `Math.random`. */
  rnd?: () => number
  /** Замер задержки тракта — кнопка служебного экрана. */
  measureLatency?: () => Promise<{ medianMs: number; spreadMs: number } | null>
  /** Выгрузка и очистка журнала — кнопки служебного экрана. */
  saveLog?: () => Promise<void>
  clearLog?: () => Promise<void>
  /** Сброс офлайн-кэша и перезагрузка — кнопка меню. */
  refreshCache?: () => Promise<void>
  /**
   * Запуск источника позы. Приходит зависимостью и по умолчанию грузится
   * ДИНАМИЧЕСКИ: этим семнадцать мегабайт вендора MediaPipe остаются за
   * границей начального бандла, и меню открывается, не дожидаясь их.
   */
  startPose?: (opts: StartPoseOpts) => Promise<() => Promise<void>>
}

/** Что оболочка требует от источника позы. Подмножество `PoseSourceOpts`. */
export type StartPoseOpts = {
  source: 'camera' | 'fake'
  onSample(f: Frame, meta: { w: number | null; h: number | null }): void
  onStatus(s: { kind: string }): void
  script?: string
}

/**
 * Источник позы по умолчанию: динамический импорт вместе с камерой.
 *
 * Камера приходит в источник ЗАВИСИМОСТЬЮ (`openCamera`), а не импортом внутри
 * него: источник знает, как ею пользоваться, но не решает, подключать ли её.
 */
async function defaultStartPose(opts: StartPoseOpts): Promise<() => Promise<void>> {
  const [{ startPoseSource }, { openCamera }] = await Promise.all([
    import('../adapters/pose/source'),
    import('../adapters/camera'),
  ])
  return startPoseSource({
    source: opts.source,
    onSample: (f, meta) => opts.onSample(f, meta),
    onStatus: (st) => opts.onStatus(st),
    openCamera: () => openCamera(),
    ...(opts.script !== undefined ? { script: opts.script } : {}),
  })
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
  /** Последний замер задержки, если он был: его показывает служебный экран. */
  readonly latency: { medianMs: number; spreadMs: number } | null
  stop(): void
}

/**
 * Сброс кэша по умолчанию: снять кэши и регистрацию, затем перезагрузиться.
 *
 * Перезагрузка ЗДЕСЬ, а не в адаптере: куда идти после сброса — решение
 * оболочки. Без неё страницей до конца её жизни продолжает управлять прежний
 * worker, и кнопка выглядела бы не сработавшей.
 */
async function defaultRefreshCache(): Promise<void> {
  await dropCaches()
  location.reload()
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
  let latency: { medianMs: number; spreadMs: number } | null = null
  let stopped = false
  let rafId: number | null = null
  let stage: RunStage | null = null
  let loop: Loop | null = null
  let rs: RunScreen | null = null
  let play: Play | null = null
  /**
   * Время последнего кадра экрана. Им ставится ручная пауза: нажатие кнопки
   * происходит между кадрами, а ядру нужен момент в той же шкале, что и `tick`.
   */
  let lastFrameT = 0
  /** Как погасить источник позы. `null` — он ещё не поднялся или уже погашен. */
  let stopPose: (() => Promise<void>) | null = null
  /**
   * Калибровка ПЕРЕЖИВАЕТ забег и живёт в оболочке, а не в забеге: ребёнок не
   * должен сдавать её каждый раз. Устаревание решает `makePlay`.
   */
  let calibration: Calibration | null = null
  /** Источники отношения сторон кадра. Пополняются источником позы. */
  const aspectSource: AspectSource = {}
  const debug: Debug & { rawAlways?: boolean } = { source: 'камера', pipeline: 'авто' }

  /** Гасит такт экрана. Иначе два забега подряд дают два живых цикла rAF. */
  const stopFrames = (): void => {
    if (rafId !== null) {
      cancelRaf(rafId)
      rafId = null
    }
    // Источник позы гасится ВМЕСТЕ с тактом экрана: оставленный жить, он
    // держит камеру занятой, а индикатор — горящим при погашенной игре.
    if (stopPose) {
      void stopPose()
      stopPose = null
    }
    loop = null
    rs = null
    play = null
    stage = null
  }

  function startFrames(): void {
    /*
     * Часы берутся те же, по которым идёт такт экрана: ручная пауза ставится в
     * ИГРОВОЕ время, и взять их из другого источника значило бы попросить ядро
     * остановиться в момент, которого оно не видело.
     */
    const screenRun = runScreen({
      onPause: () => {
        play?.pauseManual(lastFrameT)
        refreshPause()
      },
      onResume: () => {
        // `false` — возврат не подтверждён: меню остаётся, кнопка отключена.
        play?.resume(lastFrameT)
        refreshPause()
      },
      /*
       * Выход в меню ПРЕРЫВАЕТ забег, и это намеренно: продолжать с середины
       * нечего — ребёнок уже ушёл от камеры, а половина забега без конца
       * результатом не является. Решение `run-game`, и здесь оно то же.
       */
      onMenu: () => {
        play?.abort('pause')
        go('menu')
      },
    })
    rs = screenRun

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

    /*
     * Калибровка — ПЕРВАЯ стадия забега, а не отдельный экран и не кнопка в
     * меню. Решает это `makePlay`: нет калибровки или она устарела — забег
     * начинается с неё сам, и оболочка о сроках устаревания не знает.
     */
    // Громкость — живая настройка, как и всё остальное: применяется на забеге.
    deps.audio?.setVolume(settings.get('volume'))

    const thePlay = makePlay({
      settings,
      cal: calibration,
      aspect: () => frameAspect(aspectSource),
      write: deps.write ?? journalWrite,
      rnd: deps.rnd ?? Math.random,
      source: debug.source === 'фейк' ? 'fake' : 'camera',
      ...(deps.audio ? { audio: deps.audio } : {}),
      ...(debug.rawAlways ? { rawAlways: true } : {}),
    })
    play = thePlay
    stage = thePlay.stage()

    /*
     * Источник позы поднимается ОДИН раз на забег и гасится вместе с ним.
     * Кадры идут в буфер (`loop.sample`) и больше никуда: кадр камеры не
     * рисует — это тот самый инвариант двух независимых тактов.
     */
    const startPose = deps.startPose ?? defaultStartPose
    void startPose({
      source: debug.source === 'фейк' ? 'fake' : 'camera',
      onSample: (f, meta) => {
        // Размер кадра — самый достоверный источник отношения сторон: именно
        // по этому кадру и судили.
        if (meta.w && meta.h) aspectSource.frame = { w: meta.w, h: meta.h }
        theLoop.sample(f)
      },
      onStatus: (st) => {
        if (st.kind === 'exhausted') screenRun.say('Камеры нет: позы не будет')
        if (st.kind === 'camera-lost') screenRun.say('Камера пропала')
        if (st.kind === 'beat') {
          const b = st as unknown as { busyFrac: number; dropped: number; p50: number; p95: number }
          theLoop.noteBeat({ p50: b.p50, p95: b.p95, dropped: b.dropped })
        }
      },
    }).then(
      (stop) => {
        stopPose = stop
        // Забег уже кончился, пока источник поднимался: гасим сразу, иначе
        // камера осталась бы занятой при погашенном экране.
        if (stopped || screen !== 'run') void stop()
      },
      () => screenRun.say('Источник позы не запустился'),
    )

    const theLoop = makeLoop({
      step: (t, frames) => {
        lastFrameT = t
        const got = thePlay.step(t, frames)
        stage = thePlay.stage()
        screenRun.say(thePlay.hint())
        refreshPause()
        // Сцена `null` — рисовать нечего (идёт калибровка или нет кадра).
        if (got.scene && renderer) renderer.render(got.scene)
        // Снятая калибровка переживает забег: ребёнок не сдаёт её каждый раз.
        calibration = thePlay.calibration()
        return got.counts
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

  /**
   * Строка информации меню: версия сборки и то, что меняет поведение.
   *
   * Пометки — не украшение: включённый синтетический источник или
   * принудительный конвейер однажды дадут «камера ни на что не влияет», и
   * искать причину будут в камере. Модель взята из `run-game`.
   */
  function menuInfo(): MenuInfo {
    const marks: string[] = []
    if (debug.source === 'фейк') marks.push('источник: СИНТЕТИКА, камера не работает')
    if (debug.pipeline !== 'авто') marks.push(`конвейер: ${debug.pipeline}`)
    if (debug.rawAlways === true) marks.push('сплошная запись скелета')

    const info = serviceInfo()
    if (info.log.broken) marks.push('журнал выключен')
    // Про отсутствие модели в кэше надо знать ДО того, как выйдешь из сети.
    if (!info.build.modelCached) marks.push('модель не в кэше: офлайн не выйдет')

    /*
     * Версия берётся из ТОЙ ЖЕ сводки, что и остальное, а не своим вызовом
     * `buildInfo()`: два источника разъехались бы, и строка показывала бы одну
     * версию, а служебный экран — другую.
     */
    return { version: info.build.version, date: info.build.date, marks }
  }

  /**
   * Меню паузы — только на РУЧНОЙ паузе.
   *
   * На автопаузе ребёнок всего лишь вышел из кадра, и предлагать там «вернуться
   * в меню» значило бы предлагать бросить забег из-за секундной отлучки.
   */
  function refreshPause(): void {
    if (!rs || !play) return
    const manual = play.manual()
    rs.pauseMenu(manual, play.state()?.canResume ?? false)
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
          info: menuInfo(),
          onPlay: () => go('run'),
          onAdult: () => go('settings'),
          onRefreshCache: () => {
            void (deps.refreshCache ?? defaultRefreshCache)()
          },
          refresh: draw,
        }),
      )
      return
    }

    if (screen === 'settings') {
      root.replaceChildren(
        settingsScreen({
        settings,
        onBack: () => go('menu'),
        onService: () => go('service'),
        refresh: draw,
      }),
      )
      return
    }

    root.replaceChildren(
      serviceScreen({
        settings,
        info: { ...serviceInfo(), latency },
        debug,
        onDebug: (patch) => Object.assign(debug, patch),
        onBack: () => go('menu'),
        /*
         * Кнопки служебного экрана ДЕЛАЮТ дело, а не стоят заглушками: кнопка,
         * которая нажимается и ничего не меняет, выглядит сломанной игрой — и
         * отличить её от сломанной нечем, консоли на штативе нет.
         */
        onMeasureLatency: () => {
          void (deps.measureLatency ?? (() => Promise.resolve(null)))().then((r) => {
            latency = r
            draw()
          })
        },
        onShareLog: () => void (deps.saveLog ?? (() => Promise.resolve()))().then(draw),
        onClearLog: () => void (deps.clearLog ?? (() => Promise.resolve()))().then(draw),
        onRecalibrate: () => {
          // Пересдача — это просто забытая калибровка: следующий забег начнётся
          // со стадии калибровки сам.
          calibration = null
          draw()
        },
        refresh: draw,
      }),
    )
  }

  function go(next: ScreenName): void {
    if (stopped) return
    /*
     * Уход с забега НЕ ЧЕРЕЗ меню паузы — тоже прерывание, и оно обязано быть
     * записано: иначе забег выглядел бы в журнале оборванным без причины.
     * Случай настоящий: взрослый нажимает кнопку телефона «назад».
     */
    if (screen === 'run' && next !== 'run' && play && play.state()?.phase === 'running') {
      play.abort('menu')
    }
    screen = next
    draw()
  }

  draw()

  return {
    screen: () => screen,
    get latency() {
      return latency
    },
    go,
    orientation: () => (screen === 'run' ? 'landscape' : 'portrait'),
    runStage: () => play?.stage() ?? stage,
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
