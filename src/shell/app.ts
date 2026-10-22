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
import { browserOrientation, lockOrientation as lockScreenOrientation } from '../adapters/orientation'
import type { LockResult } from '../adapters/orientation'
import type { AspectSource } from '../adapters/camera'
import { alarm as alarmEvent } from '../adapters/log/events'
import { write as journalWrite } from '../adapters/log/store'
import type { LogEvent } from '../adapters/log/store'
import { makeSettings, timingsFor, toggleBlocked } from '../adapters/settings'
import type { Settings } from '../adapters/settings'
import type { Calibration, Frame, PoseTag } from '../core/types'
import { DEFAULT_FAKE_SCRIPT, fakeFlagValue, fakeScript } from '../fake/flag'
import type { FakeScript } from '../fake/flag'
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
  /**
   * Закрепление ориентации экрана. Приходит зависимостью: `screen.orientation`
   * в node нет, а проверяется именно поведение при ОТКАЗЕ — на iOS замка нет
   * вовсе, и игра обязана играться и там.
   */
  lockOrientation?: (want: 'portrait' | 'landscape') => Promise<LockResult>
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
  /**
   * Строка запроса для разбора `?fake=`. По умолчанию — `location.search`;
   * подменяется в тестах, где `location` принадлежит всему прогону сразу.
   */
  search?: string | null
}

/** Что оболочка требует от источника позы. Подмножество `PoseSourceOpts`. */
export type StartPoseOpts = {
  source: 'camera' | 'fake'
  onSample(f: Frame, meta: { w: number | null; h: number | null }): void
  onStatus(s: { kind: string }): void
  /**
   * Камера открылась и назвала себя. Приходит ПОЗЖЕ старта забега — камера
   * открывается не мгновенно, — поэтому опознание спрашивается в момент съёма
   * калибровки, а не передаётся забегу значением.
   *
   * Им живёт половина `isStale()`, та, что ловит смену камеры. Без него в
   * калибровке стоял `'unknown'`, и сторож сравнивал `'unknown'` с
   * `'unknown'`: в журнале живого забега 22.10.2026 так и записано.
   */
  onCamera?(info: { deviceId: string | null }): void
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

  /*
   * Синтетический игрок грузится ТОЛЬКО когда его просят, отдельным
   * динамическим импортом: в обычном запуске с камерой этот модуль не
   * разбирается вовсе. Прежде его не подключали никуда, и режим «фейк»,
   * выбранный на служебном экране, честно отвечал «синтетический игрок не
   * подключён» — то есть не работал ни разу.
   */
  const fakeFrames =
    opts.source === 'fake'
      ? await import('../fake/player').then(
          ({ fakeSource }) =>
            (script: string, hz: number) =>
              fakeSource(script as FakeScript, hz, (m) => journalWrite(m)),
        )
      : undefined

  return startPoseSource({
    source: opts.source,
    onSample: (f, meta) => opts.onSample(f, meta),
    onStatus: (st) => opts.onStatus(st),
    /*
     * Камера открывается ЗДЕСЬ, и здесь же единственное место, где видно её
     * опознание: `openCamera` отдаёт поток, а `deviceId` живёт в настройках
     * дорожки. Дальше оно уходит в оболочку и попадает в калибровку.
     */
    openCamera: async () => {
      const cam = await openCamera()
      const id = cam.stream.getVideoTracks()[0]?.getSettings().deviceId ?? null
      opts.onCamera?.({ deviceId: id })
      return cam
    },
    ...(fakeFrames ? { fakeFrames } : {}),
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
/** Замок ориентации по умолчанию — браузерный, см. `adapters/orientation.ts`. */
const defaultLock = (want: 'portrait' | 'landscape'): Promise<LockResult> =>
  lockScreenOrientation(want, browserOrientation())

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
  /** Чем кончился отказавший замер. `null` — отказа не было. */
  let latencyFailed: string | null = null
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
  /** Опознание камеры нынешнего забега. `null` — она ещё не назвалась. */
  let cameraId: string | null = null

  /**
   * Тревога идёт НА ЭКРАН И В ЖУРНАЛ одной дорогой.
   *
   * Консоли на штативе нет, экран живёт ровно столько, сколько на него
   * смотрят, и тревога, не попавшая в журнал, для разбора не существует: в
   * живом забеге 22.10.2026 вертикальный кадр камеры был виден на экране, а в
   * журнале его нет — и установить, показалось ли предупреждение, оказалось
   * нечем.
   *
   * Запись по СМЕНЕ текста: кадры идут пятьдесят раз в секунду, и повтор одной
   * и той же строки вытеснил бы из журнала сам забег. Снятая тревога (`null`)
   * забывается — та же строка через минуту снова новость. Забег сбрасывает
   * память о тревогах в `startFrames`.
   *
   * Живёт на уровне приложения, а не забега: о неудавшемся замке ориентации
   * надо сказать на переходе экранов, когда экрана забега ещё нет. Экран
   * получит текст, если он есть (`rs`), а журнал — всегда.
   * → `docs/log-and-storage.md`
   */
  /**
   * Просьба повернуть телефон НЕ перебивает уже показанную тревогу.
   *
   * Замок ориентации отвечает микрозадачей позже перехода экрана, то есть
   * позже, чем успевает сказать своё источник позы, — и «Поверни телефон»
   * затирало «Камеры нет». Из двух это менее срочное: боком игра всё-таки
   * играется, без камеры — нет.
   */
  const askToRotate = (): void => {
    if (alarmed === null) alarm('Поверни телефон горизонтально')
  }

  let alarmed: string | null = null
  const alarm = (text: string | null): void => {
    rs?.alarm(text)
    if (text === null) {
      alarmed = null
      return
    }
    if (text === alarmed) return
    alarmed = text
    ;(deps.write ?? journalWrite)(alarmEvent({ text }))
  }
  /** Ступень, которая сошла, либо `null`. Переживает `ready`: см. `onStatus`. */
  let fellPipeline: string | null = null
  const debug: Debug & { rawAlways?: boolean } = { source: 'камера', pipeline: 'авто' }

  /*
   * `?fake=<сценарий>` — вход в локальную проверку без камеры. Адрес сильнее
   * служебного экрана: по ссылке проверку воспроизводит кто угодно, ничего не
   * перещёлкивая, и той же ссылкой она попадает в отчёт о дефекте.
   *
   * Неизвестное имя сценария НЕ откатывается на умолчание молча — опечатка
   * прошла бы незамеченной, и проверяли бы не то, что собирались.
   */
  /*
   * `!== undefined`, а не `??`: `search: null` означает «строки запроса нет»,
   * и `??` подменил бы это настоящей `location.search` — объявленный тип и
   * поведение разошлись бы молча.
   */
  const askedFake = fakeFlagValue(
    deps.search !== undefined
      ? deps.search
      : typeof location === 'undefined'
        ? null
        : location.search,
  )
  let fakeScriptName: FakeScript = DEFAULT_FAKE_SCRIPT
  let fakeRejected: string | null = null
  if (askedFake !== null) {
    const picked = fakeScript(askedFake)
    if (picked === null) fakeRejected = askedFake
    else {
      debug.source = 'фейк'
      fakeScriptName = picked
    }
  }

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
     * Отношение сторон и опознание камеры ЗАБЫВАЮТСЯ на каждом забеге, и это
     * не гигиена, а защита калибровки.
     *
     * Забег стартует раньше, чем открывается камера, и прежде источники
     * отношения сторон жили один раз на всё приложение. На живом телефоне
     * 22.10.2026 это отдало в живой забег калибровку СИНТЕТИЧЕСКОГО игрока:
     * `aspect()` вернул 1.7778 от прошлого источника, `isStale()` сравнил его
     * сам с собой и признал калибровку свежей, а камера потом дала 360×640,
     * то есть 0.5625. Все промахи того забега недостоверны.
     *
     * Пустые источники означают «кадра ещё не было»: забег на них ничего не
     * считает и ждёт — `SEARCHING_HINT` в `play.ts`.
     * → `docs/calibration.md`
     */
    aspectSource.frame = null
    aspectSource.video = null
    aspectSource.track = null
    cameraId = null

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

    /*
     * Тревога идёт НА ЭКРАН И В ЖУРНАЛ одной дорогой.
     *
     * Консоли на штативе нет, экран живёт ровно столько, сколько на него
     * смотрят, и тревога, не попавшая в журнал, для разбора не существует:
     * в живом забеге 22.10.2026 вертикальный кадр камеры был виден на экране,
     * а в журнале его нет — и установить, показалось ли предупреждение,
     * оказалось нечем.
     *
     * Запись по СМЕНЕ текста: кадры идут пятьдесят раз в секунду, и повтор
     * одной и той же строки вытеснил бы из журнала сам забег. Снятая тревога
     * (`null`) забывается — та же строка через минуту снова новость.
     * → `docs/log-and-storage.md`
     */
    alarmed = null

    let renderer: Renderer | null = null
    try {
      renderer = makeRenderer(screenRun.canvas)
    } catch {
      /*
       * Нет Canvas2D — сказать вслух и остаться на экране: молча не рисующая
       * игра на штативе неотличима от мёртвой камеры.
       */
      alarm('Рисовать нечем: холст недоступен')
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
      cameraId: () => cameraId,
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
      ...(debug.source === 'фейк' ? { script: fakeScriptName } : {}),
      onSample: (f, meta) => {
        // Размер кадра — самый достоверный источник отношения сторон: именно
        // по этому кадру и судили.
        if (meta.w && meta.h) {
          aspectSource.frame = { w: meta.w, h: meta.h }
          /*
           * Экран забега горизонтальный, а камера способна отдать вертикальный
           * кадр: в первом живом прогоне она дала 360×640. Геометрия на таком
           * кадре считается — `x` честно домножается на отношение сторон, — и
           * калибровка проходит, так что расхождение нигде не всплывает: в
           * журнале остаётся `aspect: 0.5625`, и прочесть по нему «телефон
           * держали вертикально» можно, только зная, что так бывает.
           */
          if (meta.h > meta.w) alarm('Кадр камеры вертикальный — поверни телефон')
        }
        theLoop.sample(f)
      },
      onCamera: (info) => {
        cameraId = info.deviceId
      },
      onStatus: (st) => {
        if (st.kind === 'exhausted') alarm('Камеры нет: позы не будет')
        if (st.kind === 'camera-lost') alarm('Камера пропала')
        /*
         * Просевшая ступень лестницы конвейеров раньше не говорила ничего:
         * «не завёлся GPU», «нет MediaStreamTrackProcessor», «воркер умер» —
         * всё это выглядело на экране как «ищу камеру». Ступень ниже обычно
         * медленнее, и знать об этом взрослому полезнее, чем не знать.
         */
        if (st.kind === 'down') {
          const d = st as unknown as { pipeline?: string }
          fellPipeline = d.pipeline ?? 'верхняя'
          alarm(`Распознавание просело: ступень ${fellPipeline} сошла`)
        }
        if (st.kind === 'ready') {
          const r = st as unknown as { pipeline?: string }
          /*
           * Кадры пошли — жалоба на камеру больше не про нынешнее положение
           * дел. Но просадка конвейера `ready`-ем НЕ снимается: ступень ниже
           * поднимается через секунду-другую, и сообщение, написанное на
           * `down`, взрослый не успевал прочесть ни разу. Оно сменяется тем,
           * что есть на самом деле: на чём игра в итоге работает.
           */
          alarm(
            fellPipeline === null
              ? null
              : `Распознавание просело: работает ${r.pipeline ?? 'запасная ступень'}`,
          )
        }
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
      () => alarm('Источник позы не запустился'),
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
    if (debug.source === 'фейк') {
      marks.push(`источник: СИНТЕТИКА (${fakeScriptName}), камера не работает`)
    }
    if (fakeRejected !== null) marks.push(`?fake=${fakeRejected} — нет такого сценария`)
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
    /*
     * Законченный забег выпускает с экрана САМ. Прежде выход был только через
     * меню ручной паузы, а на законченном забеге пауза не встаёт: экран
     * запирался насовсем — кнопка паузы видна и мертва, возвращаться некуда.
     */
    if (stage === 'finished') {
      rs.finishMenu(true)
      return
    }
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
        info: { ...serviceInfo(), latency, latencyFailed },
        debug,
        onDebug: (patch) => Object.assign(debug, patch),
        onBack: () => go('menu'),
        /*
         * Кнопки служебного экрана ДЕЛАЮТ дело, а не стоят заглушками: кнопка,
         * которая нажимается и ничего не меняет, выглядит сломанной игрой — и
         * отличить её от сломанной нечем, консоли на штативе нет.
         */
        onMeasureLatency: () => {
          void (deps.measureLatency ?? (() => Promise.resolve(null)))().then(
            (r) => {
              latency = r
              latencyFailed = null
              draw()
            },
            /*
             * Отказ замера — штатный исход, а не поломка: телевизор приглушён,
             * микрофон без разрешения, выстрелы разбежались. Необработанное
             * обещание молчало бы, а молчание здесь неотличимо от «не мерили».
             */
            (e: unknown) => {
              latency = null
              latencyFailed = e instanceof Error ? e.message : String(e)
              draw()
            },
          )
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

    /*
     * Ориентация ЗАКРЕПЛЯЕТСЯ, а не объявляется: забег уходит на телевизор
     * 16:9, меню ребёнок читает с телефона в руках. Прежде `orientation()`
     * только отвечал на вопрос, и потребителя у ответа не было — телефон
     * стоял как поставили, и в живом прогоне 22.10.2026 это был портрет.
     *
     * Просьба идёт на КАЖДОМ переходе, и это не расточительство: замок
     * требует жеста, а переход экрана и есть нажатие ребёнка.
     */
    const want = next === 'run' ? 'landscape' : 'portrait'
    void (deps.lockOrientation ?? defaultLock)(want).then(
      (r) => {
        /*
         * Не закрепилось на забеге — просим повернуть руками. Молча играть
         * боком нельзя: на телевизоре это картинка в две полосы, и ребёнок не
         * поймёт, почему. На меню молчим: портрет там удобство, а не условие.
         */
        if (!r.locked && next === 'run') askToRotate()
      },
      // Отказ самого обещания — тот же случай, что `locked: false`.
      () => {
        if (next === 'run') askToRotate()
      },
    )
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
