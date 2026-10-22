/**
 * Забег целиком: калибровка, раунды, журнал и сцена для рендера.
 *
 * Здесь сходятся ядро и адаптеры, и здесь же живёт **порядок записи в
 * журнал** — он часть контракта, а не вкус: к моменту появления исхода раунда
 * N забег уже перешёл к раунду N+1, и превью N+1, записанное раньше
 * `round.wall` раунда N, заставило бы replay судить данные раунда N позой
 * раунда N+1. Это уже допущенная однажды ошибка, и она давала восемнадцать
 * расхождений из девятнадцати при полностью исправном судействе.
 * → `docs/judging.md`
 *
 * Время приходит АРГУМЕНТОМ, журнал и генератор случайных чисел —
 * зависимостями. Поэтому весь забег проигрывается из node над синтетическим
 * игроком, и сквозной тест проверяет именно этот код, а не свою копию его.
 *
 * Разбор: `docs/judging.md`, `docs/calibration.md`, `docs/render-and-layout.md`.
 */

import { CONFIG } from '../core/config'
import { geometry } from '../core/geometry'
import type { Geometry } from '../core/geometry'
import { isStale, makeCalibrator } from '../core/calibration'
import type { Calibrator } from '../core/calibration'
import { makeRun } from '../core/run'
import type { Run, RunState } from '../core/run'
import type { Calibration, Frame, Landmarks } from '../core/types'
import { calibDone, calibNeed, pause as pauseEvent, pauseStuck, resume as resumeEvent } from '../adapters/log/events'
import { roundJudge, roundPreview, roundSkip, roundWall, runAbort, runFinish, runStart } from '../adapters/log/events'
import type { LogEvent, RawWhy } from '../adapters/log/store'
import { rawBurst, rawPush, rawReset } from '../adapters/log/store'
import { timingsFor } from '../adapters/settings'
import type { Settings } from '../adapters/settings'
import type { Audio } from '../adapters/audio'
import type { Scene } from '../adapters/render/canvas'
import type { CalibScene } from '../adapters/render/calibrate'
import { framing } from '../adapters/camera'
import type { StepCounts } from './loop'
import type { RunStage } from './screens/run'

/**
 * Что просят у ребёнка, пока идёт калибровка.
 *
 * Строка одна на два места — начальное значение и возврат после «Ищу камеру»,
 * — потому что разошедшиеся копии дали бы две разные просьбы на одном экране.
 */
const CALIBRATION_HINT = 'Встань прямо и постой пять секунд'

/**
 * Раз в сколько жаловаться в журнал на незаконченную калибровку.
 *
 * Две секунды: достаточно редко, чтобы не съесть бюджет журнала (кадров
 * двенадцать в секунду), и достаточно часто, чтобы по журналу было видно, что
 * стадия тянется, а не прошла с первой попытки.
 */
const CALIB_TELL_MS = 2000

/**
 * Сколько сверх собственной длительности стадии ждать, прежде чем считать
 * калибровку просроченной. Запас на то, что кадры идут не идеально ровно и
 * первые отсчёты могли не сойтись.
 */
const CALIB_GRACE_MS = 2000

/** Сколько живёт последний кадр силуэта на экране калибровки. */
const CALIB_SILHOUETTE_TTL_MS = 1000

/** Пока отношения сторон нет: ни одного кадра ещё не пришло. */
const SEARCHING_HINT = 'Ищу камеру'

export type PlayDeps = {
  settings: Settings
  /** Уже снятая калибровка, если она есть и ещё годится. */
  cal?: Calibration | null
  /** Отношение сторон кадра; `null`, пока ни один источник не ответил. */
  aspect: () => number | null
  write: (e: LogEvent) => void
  /** Генератор случайных чисел для выбора поз: чистота забега держится на нём. */
  rnd: () => number
  /** Часы СТЕНЫ — только для `takenAtMs` калибровки, переживающего перезапуск. */
  wall?: () => number
  /**
   * Опознание камеры, чтобы калибровка знала, на какой она снята.
   *
   * ФУНКЦИЯ, а не строка: камера открывается позже старта забега, и значением
   * сюда приходило бы «её ещё нет». В журнале живого забега 22.10.2026 так и
   * вышло — `cameraId: 'unknown'` при живой камере с честным `deviceId`, и
   * половина `isStale()` не работала ни разу.
   */
  cameraId?: () => string | null
  /**
   * Откуда кадры. **Обязателен, а не по умолчанию `camera`:** журнал —
   * единственный вход калибровки порогов, и синтетический забег, записанный
   * как живой, делает такую калибровку хуже отсутствующей — она выглядит
   * доказательством. Значение по умолчанию здесь означало бы, что забыть
   * пометку МОЖНО, а забытая пометка неотличима от правды.
   */
  source: 'camera' | 'fake'
  /**
   * Звук исходов. Необязателен: беззвучная игра хуже звучащей, но несравнимо
   * лучше упавшей, и `createAudio` сам уже молчит, когда WebAudio нет.
   */
  audio?: Pick<Audio, 'cue' | 'hit' | 'miss' | 'neutral'>
  /** Куда складывать строки скелета. По умолчанию — кольцо журнала. */
  raw?: RawSink
  /**
   * Сплошная запись скелета — отладочный тумблер служебного экрана.
   *
   * Без неё всплеск уходит только по интересному моменту (провал, пауза), и
   * зачтённые раунды в журнале строк не имеют — значит replay их не
   * пересчитает. Для калибровки порогов (задача 23) нужна именно сплошная.
   */
  rawAlways?: boolean
}

/** Кольцо строк скелета. Отдельным типом, потому что подменяется в тестах. */
export type RawSink = {
  push(t: number, lm: Landmarks | null): void
  burst(why: RawWhy): void
  reset(): void
}

export type Play = {
  /**
   * Продвинуть игру до момента `t` накопленными кадрами.
   *
   * Отдаёт либо сцену ЗАБЕГА, либо сцену КАЛИБРОВКИ — ровно одну из двух, —
   * и числа для сводки здоровья. Пустой экран на калибровке неприемлем: пять
   * секунд темноты неотличимы от сломанной игры (22.10.2026, три сессии
   * подряд).
   */
  step(t: number, frames: Frame[]): { scene: Scene | null; calib: CalibScene | null; counts: StepCounts }
  stage(): RunStage
  /** Что сказать игроку поверх холста. Пустая строка — молчать. */
  hint(): string
  state(): RunState | null
  calibration(): Calibration | null
  /**
   * Пауза по просьбе человека. Пишет `pause {why:'manual'}` и всплеск строк
   * скелета: пауза — второй интересный для разбора момент после провала.
   */
  pauseManual(t: number): void
  /**
   * Снять ручную паузу. `false` — возврат ещё не подтверждён присутствием
   * (ребёнок не вернулся на место), и оболочка обязана показать это, а не
   * делать вид, что нажатие не состоялось.
   */
  resume(t: number): boolean
  /** Прервать забег: взрослый выходит в меню. Пишет `run.abort`. */
  abort(where: 'pause' | 'menu'): void
  /** Стоит ли РУЧНАЯ пауза: на ней показывается меню паузы. */
  manual(): boolean
  /**
   * Автопауза ЗАПЕРЛАСЬ: держится дольше `presence.stuckMs` и сама не
   * снимется. Оболочка показывает на ней меню паузы — иначе из забега нет
   * выхода вовсе, что и случилось в живом забеге 22.10.2026.
   */
  stuck(): boolean
}

/** Сколько очков за исход — из конфига, а не числом здесь. */
const scoreOf = (kind: 'hit' | 'miss' | 'skip'): number =>
  kind === 'hit' ? CONFIG.score.hit : kind === 'miss' ? CONFIG.score.miss : 0

export function makePlay(deps: PlayDeps): Play {
  const { settings, write, rnd } = deps
  const wall = deps.wall ?? ((): number => Date.now())
  /** Спрашивается в момент съёма и проверки — см. `PlayDeps.cameraId`. */
  const cameraId = (): string => deps.cameraId?.() ?? 'unknown'

  let cal: Calibration | null = deps.cal ?? null
  let calibrator: Calibrator | null = null
  let run: Run | null = null
  let stage: RunStage = 'calibration'
  let hint = CALIBRATION_HINT

  /** Сколько исходов уже записано в журнал. */
  let logged = 0
  /** Начало раунда, чьё превью уже записано: поза вернётся, а начало — нет. */
  let previewedAt: number | null = null
  /** Записанная причина паузы: иначе строка пишется на каждый кадр. */
  let pausedWhy: string | null = null
  /** Когда встала нынешняя автопауза; `null` — её нет. */
  let autoPausedAt: number | null = null
  /** Запертость уже записана: событие одно на паузу, а не на кадр. */
  let stuckLogged = false
  /**
   * Отношение сторон, которым судили последние кадры. Идёт в приговор: журнал
   * обязан нести число, ПО КОТОРОМУ судили, — иначе replay пересчитывает
   * калибровочным и выдаёт свои приговоры за расхождения.
   * → `RoundJudgeData.aspect`
   */
  let judgedAspect = 0
  /** Время последнего шага: им `stuck()` считает длительность паузы. */
  let lastStepT = 0
  /** Когда началась стадия калибровки; `null` — она не шла ни разу. */
  let calibStartedAt: number | null = null
  /** Кадров на стадии калибровки и из них с геометрией — для диагностики. */
  let calibFrames = 0
  let calibWithGeometry = 0
  /**
   * Пролёт ВРЕМЕНИ КАДРОВ, уже набранный годными отсчётами: от первого до
   * последнего. Это ровно то, чего ждёт калибратор, и считается по часам
   * кадра, а не тика — у них разные шкалы.
   */
  let calibFirstGoodT: number | null = null
  let calibLastGoodT: number | null = null
  /** Когда пришёл последний кадр стадии: по нему силуэт протухает. */
  let calibFrameAt: number | null = null
  /** Когда последний раз жаловались на нехватку: запись редкая. */
  let calibToldAt = -Infinity
  /** Последний скелет и его геометрия на стадии калибровки — для экрана. */
  let calibLast: { lm: Landmarks | null; g: Geometry | null } = { lm: null, g: null }
  let finished = false

  /** Мотив исхода. `skip` звучит НЕ как провал — тот же инвариант, что у цвета. */
  const sound = (kind: 'hit' | 'miss' | 'skip'): void => {
    if (!deps.audio) return
    if (kind === 'hit') deps.audio.hit()
    else if (kind === 'miss') deps.audio.miss()
    else deps.audio.neutral()
  }

  const raw: RawSink = deps.raw ?? {
    push: (t, lm) => rawPush(t, lm),
    burst: (why) => rawBurst(why),
    reset: () => rawReset(),
  }

  /**
   * Сцена калибровки: что показать, пока забег ещё не начался.
   *
   * `framing` считается ТЕМ ЖЕ `framing()`, которым камера судит кадрирование
   * — иначе рамка на экране обещала бы не то, что проверяет игра.
   */
  /**
   * Силуэт ПРОТУХАЕТ: кадры приходят вчетверо реже тиков, и держать последний
   * между ними обязательно, а держать его вечно — нет. Умерший источник иначе
   * показывал бы замерший скелет в зелёной рамке, то есть уверял бы «камера
   * кого-то видит» ровно в том случае, ради которого экран и заведён.
   * Найдено код-ревью.
   */
  const staleSilhouette = (t: number): boolean =>
    calibFrameAt === null || t - calibFrameAt > CALIB_SILHOUETTE_TTL_MS

  function calibScene(t: number): CalibScene {
    const span = CONFIG.calibration.durationMs
    /*
     * Прогресс — по ТОМУ, ЧТО НАБРАНО, а не по часам: время идёт и когда в
     * кадре никого нет, а полоса, ползущая к концу у пустого кадра, обещает
     * «вот-вот начнётся». Это самый обидный вид вранья — ребёнок смотрит
     * именно на неё.
     *
     * Набранное — это ПРОЛЁТ ВРЕМЕНИ КАДРОВ между первым и последним годным
     * отсчётом: ровно то, чего ждёт калибратор, и в его же шкале (часы кадра,
     * не тика). Знаменателем числа отсчётов служить не может: `minSamples` —
     * это нижняя граница (двадцать), она насыщается за полторы секунды, и
     * дальше полоса снова поехала бы по часам. Найдено код-ревью.
     */
    const spanned = calibFirstGoodT !== null && calibLastGoodT !== null ? calibLastGoodT - calibFirstGoodT : 0
    const enoughSamples = calibWithGeometry >= CONFIG.calibration.minSamples
    const bySpan = span > 0 ? spanned / span : 0
    return {
      silhouette: staleSilhouette(t) ? null : calibLast.lm,
      aspect: deps.aspect(),
      /*
       * Кадрирование судится по АБСОЛЮТНОЙ полосе, а не по калибровке: сюда
       * приходят только тогда, когда годной калибровки нет (иначе забег уже
       * начался бы), и мерить от её `S0` значило бы красить рамку по торсу,
       * снятому на другой дистанции или другой камерой. Найдено код-ревью.
       */
      framing: framing(staleSilhouette(t) ? null : calibLast.g, null),
      progress: Math.max(0, Math.min(1, enoughSamples ? bySpan : Math.min(bySpan, 0.95))),
    }
  }

  /** Калибровка годна, если она есть и не устарела для нынешней камеры. */
  function usable(aspect: number): boolean {
    if (!cal) return false
    return !isStale(cal, wall(), aspect, cameraId())
  }

  /**
   * Калибровка в журнал — ЦЕЛИКОМ и НА КАЖДЫЙ забег, включая переиспользованную.
   *
   * Калибровка переиспользуется между забегами (ребёнок не должен сдавать её
   * каждый раз), и поначалу она писалась только в тот забег, в котором снята.
   * Тогда у всех последующих забегов journal её не содержал, и `replay`
   * отвечал «нет калибровки» на каждый их раунд — то есть разбор спорного
   * раунда был невозможен ровно в тех забегах, которые ребёнок и играет.
   *
   * Нейтральные высоты входят обязательно: по ним судится присед (`axes.ts`),
   * и без них пересчёт невозможен. `takenAtMs` калибратор проставляет всегда,
   * но тип его не обещает — отсюда явная подстановка часов стены.
   */
  function writeCalibration(c: Calibration): void {
    write(
      calibDone({
        S0: c.S0,
        shoulderWidth: c.shoulderWidth,
        neutralX: c.neutralX,
        neutralShoulderY: c.neutralShoulderY,
        neutralHipY: c.neutralHipY,
        aspect: c.aspect,
        at: c.at,
        takenAtMs: c.takenAtMs ?? wall(),
        ...(c.cameraId !== undefined ? { cameraId: c.cameraId } : {}),
      }),
    )
  }

  function startRun(t: number): void {
    if (!cal) return
    const strict = settings.strict()
    run = makeRun({
      startT: t,
      durationSec: settings.get('durationSec'),
      tier: settings.get('tier'),
      toggles: settings.toggles(),
      rnd,
      cal,
      strict,
      timings: timingsFor(settings),
    })
    // Новый забег: бюджет всплесков и кольцо с нуля.
    raw.reset()
    stage = 'round'
    hint = ''
    write(
      runStart({
        tier: settings.get('tier'),
        durationS: settings.get('durationSec'),
        strict,
        latencyMs: settings.get('latencyMs'),
        source: deps.source,
      }),
    )
    // Калибровка пишется ПОСЛЕ `run.start` и до первого раунда: так она
    // попадает в журнал каждого забега, а не только того, в котором снята.
    writeCalibration(cal)
  }

  /**
   * Стадия калибровки: кадры копятся, пока калибратор не отдаст числа.
   *
   * Отказ `steady` НЕИСПРАВИМ — разброс центра считается по всем отсчётам с
   * начала, — поэтому калибратор выбрасывается и создаётся новый, а не
   * опрашивается дальше.
   */
  function calibrate(t: number, frames: Frame[], aspect: number): void {
    calibrator ??= makeCalibrator(aspect, cameraId())
    calibStartedAt ??= t

    for (const f of frames) {
      calibFrames += 1
      const g = geometry(f.lm, aspect)
      calibLast = { lm: f.lm, g }
      calibFrameAt = t
      if (g) {
        calibWithGeometry += 1
        calibFirstGoodT ??= f.t
        calibLastGoodT = f.t
        calibrator.push(g, f.t)
      }
    }

    const got = calibrator.done(wall())
    if ('need' in got) {
      /*
       * Числа стадии снимаются ДО сброса: иначе отказ `steady` сообщал бы
       * нули — ровно в том единственном отказе, который писался и раньше, и
       * ровно те поля, ради которых заводился. Найдено код-ревью.
       */
      const told = {
        frames: calibFrames,
        withGeometry: calibWithGeometry,
        heldMs: Math.round(t - (calibStartedAt ?? t)),
      }

      if (got.need === 'steady') {
        // Шевелился: этот экземпляр уже не отдаст калибровку никогда.
        calibrator = makeCalibrator(aspect, cameraId())
        hint = 'Постой спокойно ещё немного'
        // Отсчёт пошёл заново — и полоса ожидания на экране тоже: обещать
        // «вот-вот начнём», когда стадия началась с нуля, значит врать.
        calibStartedAt = t
        // Счётчики стадии тоже с нуля: иначе журнал сообщал бы долю отсчётов
        // от кадров ДВУХ разных попыток и врал бы ровно в диагностике.
        calibFrames = 0
        calibWithGeometry = 0
        calibFirstGoodT = null
        calibLastGoodT = null
      }
      /*
       * О нехватке журнал говорит САМ, и в том числе про `more` — иначе
       * «калибровка не идёт» не оставляет следов вовсе (так и вышло
       * 22.10.2026, три сессии подряд). Но жалоба идёт только на ПРОСРОЧЕННУЮ
       * стадию: первые пять секунд «мало отсчётов» — это нормальный ход
       * калибровки, и писать его значило бы жаловаться на каждый удачный
       * забег. Отказ `steady` пишется всегда: он не про срок, а про то, что
       * ребёнок шевелился, и этот экземпляр калибратора уже не отдаст числа.
       *
       * Запись к тому же РЕДКАЯ: кадров приходит двенадцать в секунду.
       */
      const overdue = t - (calibStartedAt ?? t) >= CONFIG.calibration.durationMs + CALIB_GRACE_MS
      if ((got.need === 'steady' || overdue) && t - calibToldAt >= CALIB_TELL_MS) {
        calibToldAt = t
        write(calibNeed({ need: got.need, ...told }))
      }
      return
    }

    cal = got
    startRun(t)
  }

  /** Приближение стены: 0 у горизонта, 1 у экрана. */
  function wallZ(st: RunState, t: number): number {
    const r = st.round
    if (!r) return 1
    if (st.roundPhase === 'preview') return 0
    // После касания стена стоит у экрана: замирание и приговор смотрят на неё.
    if (t >= r.contactT) return 1
    const wallStart = r.contactT - (timingsFor(settings).wallMs || 1)
    return Math.max(0, Math.min(1, (t - wallStart) / (r.contactT - wallStart)))
  }

  /**
   * Записывает всё, что случилось за шаг. Исходы — РАНЬШЕ превью следующего
   * раунда: порядок и есть контракт, см. doc-комментарий файла.
   */
  function journal(st: RunState, t: number, lastFrame: Frame | null): void {
    while (logged < st.outcomes.length) {
      const o = st.outcomes[logged++]
      write(
        roundWall({
          travelMs: timingsFor(settings).wallMs,
          latencyShiftMs: settings.get('latencyMs'),
          contactT: o.contactT,
        }),
      )

      /*
       * Всплеск строк скелета — ПЕРЕД приговором: replay читает журнал по
       * порядку, и строки, уехавшие после `round.judge`, достались бы
       * следующему раунду.
       *
       * По умолчанию всплеск идёт только на интересном моменте (раунд не
       * зачтён): бюджет журнала не бесконечен. Сплошная запись включается
       * отладочным тумблером — ею и снимают данные для калибровки порогов.
       */
      if (o.kind !== 'hit') raw.burst('miss')
      else if (deps.rawAlways) raw.burst('debug')

      // Мотив — на исходе, один раз на раунд: ребёнок 7 лет различает
      // направление мотива раньше, чем читает счёт.
      sound(o.kind)

      if (o.verdict === null) {
        write(roundSkip({ why: o.why === 'pause' ? 'pause' : 'fewFrames', valid: 0 }))
        continue
      }
      write(
        roundJudge({
          poseId: o.spec.id,
          matched: o.verdict.matched,
          frames: o.verdict.frames,
          valid: o.verdict.valid,
          ratio: o.verdict.ratio,
          // То самое число, которым судили: см. `RoundJudgeData.aspect`.
          aspect: judgedAspect,
          perAxis: o.verdict.perAxis,
          score: scoreOf(o.kind),
          total: st.score,
        }),
      )
    }

    if (st.round && st.round.startT !== previewedAt && st.pose) {
      previewedAt = st.round.startT
      // Нота-подсказка на старте превью: «смотри, вот поза».
      deps.audio?.cue()
      write(
        roundPreview({
          poseId: st.pose.id,
          mirror: st.pose.mirror,
          orientation: st.pose.orientation,
          requires: st.pose.requires,
          tier: st.pose.tier,
        }),
      )
    }

    if (st.pauseWhy !== null && st.pauseWhy !== pausedWhy) {
      pausedWhy = st.pauseWhy
      write(pauseEvent({ why: st.pauseWhy }))
      // Пауза — второй интересный момент: по строкам видно, что увидел трекер.
      raw.burst('pause')
    }
    if (st.pauseWhy === null && pausedWhy !== null) {
      pausedWhy = null
      write(resumeEvent({ afterMs: 0 }))
    }

    /*
     * Запертость автопаузы: когда она встала и сколько держится. Ручная сюда
     * не входит — у неё меню и так есть, и ждать от неё самостоятельного
     * возврата никто не просил.
     */
    if (st.pauseWhy !== null && !st.manual) {
      autoPausedAt ??= t
      if (!stuckLogged && t - autoPausedAt >= CONFIG.presence.stuckMs) {
        stuckLogged = true
        write(pauseStuck({ why: st.pauseWhy, heldMs: Math.round(t - autoPausedAt) }))
      }
    } else {
      autoPausedAt = null
      stuckLogged = false
    }

    if (st.phase === 'finished' && !finished) {
      finished = true
      const kinds = st.outcomes.map((o) => o.kind)
      write(
        runFinish({
          score: st.score,
          rounds: st.outcomes.length,
          hits: kinds.filter((k) => k === 'hit').length,
          misses: kinds.filter((k) => k === 'miss').length,
          skipped: kinds.filter((k) => k === 'skip').length,
          tier: settings.get('tier'),
          durationS: settings.get('durationSec'),
        }),
      )
    }
    void lastFrame
  }

  return {
    step: (t, frames) => {
      const aspect = deps.aspect()
      /*
       * Без отношения сторон не считается НИЧЕГО: ни геометрия, ни калибровка.
       * Это не перестраховка — `x` нормирован по ширине, `y` по высоте, и
       * счёт «пока без поправки» означал бы углы, неверные на десятки
       * градусов, причём молча.
       */
      if (aspect === null) {
        hint = SEARCHING_HINT
        /*
         * Кадра ещё не было — но экран калибровки показывается УЖЕ: область,
         * куда встать, и поза, в которой стоять, от кадра не зависят, а
         * тёмный экран неотличим от сломанной игры.
         */
        return { scene: null, calib: calibScene(t), counts: { valid: 0, lost: 0 } }
      }

      /*
       * Кадр пришёл — строку поиска камеры надо СНЯТЬ, иначе она остаётся на
       * экране навсегда: калибровка подсказку не переставляет. На телефоне так
       * и вышло — камера работала, шла калибровка, а экран звал камеру.
       *
       * Снимается ровно она, а не «ставится общая подсказка»: безусловная
       * установка стирала бы частную просьбу «Постой спокойно ещё немного»
       * через кадр, ведь `step` проходит здесь ~50 раз в секунду.
       */
      if (hint === SEARCHING_HINT) hint = CALIBRATION_HINT

      // Число, которым судили эти кадры: уходит в приговор вместе с ним.
      judgedAspect = aspect
      lastStepT = t

      if (!run) {
        if (usable(aspect)) startRun(t)
        else {
          calibrate(t, frames, aspect)
          return { scene: null, calib: calibScene(t), counts: { valid: 0, lost: 0 } }
        }
      }

      const r = run
      if (!r) return { scene: null, calib: null, counts: { valid: 0, lost: 0 } }

      for (const f of frames) raw.push(f.t, f.lm)

      const st = r.tick(t, frames)

      // Ядро само с паузы не уходит: возврат подтверждает оболочка.
      if (st.pauseWhy !== null && st.canResume) r.resume(t)

      journal(st, t, frames[frames.length - 1] ?? null)

      stage = st.phase === 'finished' ? 'finished' : st.pauseWhy !== null ? 'paused' : 'round'
      hint = st.pauseWhy !== null ? '' : stage === 'finished' ? `Счёт: ${st.score}` : ''

      const last = st.outcomes[st.outcomes.length - 1]
      const showVerdict = st.roundPhase === 'verdict' && last ? last.kind : undefined

      const scene: Scene | null = st.pose
        ? {
            phase: st.roundPhase ?? 'verdict',
            spec: st.pose,
            wallZ: wallZ(st, t),
            verdict: showVerdict,
            score: st.score,
            leftMs: st.remainingMs,
            silhouette: settings.get('silhouette') ? (frames[frames.length - 1]?.lm ?? null) : null,
            aspect,
            ...(st.pauseWhy !== null ? { paused: { why: st.pauseWhy } } : {}),
          }
        : null

      /*
       * Валидные и потерянные кадры берутся у ЯДРА — у него одного есть
       * присутствие. Выдумывать их здесь значило бы врать в журнал о том, по
       * чему судили.
       */
      let valid = 0
      for (const f of frames) {
        const g = geometry(f.lm, aspect)
        if (g) valid++
      }
      // Забег идёт — сцена калибровки больше не нужна: ровно одна из двух.
      return { scene, calib: null, counts: { valid, lost: frames.length - valid } }
    },
    pauseManual: (t) => {
      const r = run
      if (!r || r.state.phase !== 'running') return
      const st = r.pauseManual(t)
      write(pauseEvent({ why: 'manual' }))
      pausedWhy = 'manual'
      raw.burst('pause')
      stage = 'paused'
      hint = ''
      // Исход прерванного раунда записывается тем же путём, что и всегда.
      journal(st, t, null)
    },

    resume: (t) => {
      const r = run
      if (!r || r.state.phase !== 'paused') return false
      if (!r.state.canResume) return false
      r.resume(t)
      write(resumeEvent({ afterMs: 0 }))
      pausedWhy = null
      stage = 'round'
      hint = ''
      return true
    },

    abort: (where) => {
      const st = run?.state
      /*
       * Законченный забег прерывать нечем: `run.abort` означает «прерван и НЕ
       * дошёл до конца» (`adapters/log/events.ts`), и дописать его после
       * `run.finish` значило бы соврать журналу — по нему настраивают пороги,
       * и доигранный забег, помеченный прерванным, портит и статистику, и
       * калибровку.
       *
       * Путь стал достижим вместе с меню финиша: прежде выхода с законченного
       * экрана не было вовсе, и обработчик писался только под паузу.
       *
       * Забег, НЕ начавшийся вовсе (идёт калибровка), прерывание пишет
       * по-прежнему: взрослый ушёл с экрана, и это событие забега, пусть и с
       * нулями. Так было до меню финиша, и менять это ревью не просило.
       */
      if (st?.phase === 'finished') {
        finished = true
        return
      }
      write(
        runAbort({
          where,
          elapsedMs: st?.elapsedMs ?? 0,
          rounds: st?.outcomes.length ?? 0,
          score: st?.score ?? 0,
        }),
      )
      /*
       * Забег НЕ дописывается `run.finish`: он результатом не является.
       * Продолжать с середины тоже нечего — ребёнок уже ушёл от камеры, а
       * половина забега без конца не говорит о порогах ничего. Это решение
       * `run-game`, и оно здесь то же.
       */
      finished = true
    },

    manual: () => run?.state.manual ?? false,
    stuck: () => {
      const st = run?.state
      if (!st || st.pauseWhy === null || st.manual || autoPausedAt === null) return false
      return lastStepT - autoPausedAt >= CONFIG.presence.stuckMs
    },
    stage: () => stage,
    hint: () => hint,
    state: () => run?.state ?? null,
    calibration: () => cal,
  }
}
