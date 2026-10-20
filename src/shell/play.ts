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
import { isStale, makeCalibrator } from '../core/calibration'
import type { Calibrator } from '../core/calibration'
import { makeRun } from '../core/run'
import type { Run, RunState } from '../core/run'
import type { Calibration, Frame, Landmarks } from '../core/types'
import { calibDone, calibNeed, pause as pauseEvent, resume as resumeEvent } from '../adapters/log/events'
import { roundJudge, roundPreview, roundSkip, roundWall, runFinish, runStart } from '../adapters/log/events'
import type { LogEvent, RawWhy } from '../adapters/log/store'
import { rawBurst, rawPush, rawReset } from '../adapters/log/store'
import { timingsFor } from '../adapters/settings'
import type { Settings } from '../adapters/settings'
import type { Scene } from '../adapters/render/canvas'
import type { StepCounts } from './loop'
import type { RunStage } from './screens/run'

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
  /** Опознание камеры, чтобы калибровка знала, на какой она снята. */
  cameraId?: string
  /**
   * Откуда кадры. **Обязателен, а не по умолчанию `camera`:** журнал —
   * единственный вход калибровки порогов, и синтетический забег, записанный
   * как живой, делает такую калибровку хуже отсутствующей — она выглядит
   * доказательством. Значение по умолчанию здесь означало бы, что забыть
   * пометку МОЖНО, а забытая пометка неотличима от правды.
   */
  source: 'camera' | 'fake'
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
   * Отдаёт сцену для рендера и числа для сводки здоровья. Сцена `null` —
   * рисовать пока нечего (идёт калибровка: её рисует не рендер стены).
   */
  step(t: number, frames: Frame[]): { scene: Scene | null; counts: StepCounts }
  stage(): RunStage
  /** Что сказать игроку поверх холста. Пустая строка — молчать. */
  hint(): string
  state(): RunState | null
  calibration(): Calibration | null
}

/** Сколько очков за исход — из конфига, а не числом здесь. */
const scoreOf = (kind: 'hit' | 'miss' | 'skip'): number =>
  kind === 'hit' ? CONFIG.score.hit : kind === 'miss' ? CONFIG.score.miss : 0

export function makePlay(deps: PlayDeps): Play {
  const { settings, write, rnd } = deps
  const wall = deps.wall ?? ((): number => Date.now())
  const cameraId = deps.cameraId ?? 'unknown'

  let cal: Calibration | null = deps.cal ?? null
  let calibrator: Calibrator | null = null
  let run: Run | null = null
  let stage: RunStage = 'calibration'
  let hint = 'Встань прямо и постой пять секунд'

  /** Сколько исходов уже записано в журнал. */
  let logged = 0
  /** Начало раунда, чьё превью уже записано: поза вернётся, а начало — нет. */
  let previewedAt: number | null = null
  /** Записанная причина паузы: иначе строка пишется на каждый кадр. */
  let pausedWhy: string | null = null
  let finished = false

  const raw: RawSink = deps.raw ?? {
    push: (t, lm) => rawPush(t, lm),
    burst: (why) => rawBurst(why),
    reset: () => rawReset(),
  }

  /** Калибровка годна, если она есть и не устарела для нынешней камеры. */
  function usable(aspect: number): boolean {
    if (!cal) return false
    return !isStale(cal, wall(), aspect, cameraId)
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
    calibrator ??= makeCalibrator(aspect, cameraId)

    for (const f of frames) {
      const g = geometry(f.lm, aspect)
      if (g) calibrator.push(g, f.t)
    }

    const got = calibrator.done(wall())
    if ('need' in got) {
      if (got.need === 'steady') {
        // Шевелился: этот экземпляр уже не отдаст калибровку никогда.
        calibrator = makeCalibrator(aspect, cameraId)
        hint = 'Постой спокойно ещё немного'
        write(calibNeed({ need: 'steady' }))
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
          perAxis: o.verdict.perAxis,
          score: scoreOf(o.kind),
          total: st.score,
        }),
      )
    }

    if (st.round && st.round.startT !== previewedAt && st.pose) {
      previewedAt = st.round.startT
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
        hint = 'Ищу камеру'
        return { scene: null, counts: { valid: 0, lost: 0 } }
      }

      if (!run) {
        if (usable(aspect)) startRun(t)
        else {
          calibrate(t, frames, aspect)
          return { scene: null, counts: { valid: 0, lost: 0 } }
        }
      }

      const r = run
      if (!r) return { scene: null, counts: { valid: 0, lost: 0 } }

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
      return { scene, counts: { valid, lost: frames.length - valid } }
    },
    stage: () => stage,
    hint: () => hint,
    state: () => run?.state ?? null,
    calibration: () => cal,
  }
}
