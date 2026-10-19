import { CONFIG } from './config'
import { geometry } from './geometry'
import { judgeWindow, type CheckedFrame, type Verdict, type VerdictReason } from './judge'
import { nextPose } from './picker'
import type { Toggles } from './poses'
import {
  newPresenceState,
  pauseRequested,
  presence,
  resumeReady,
  type PresenceReason,
} from './presence'
import { makeRound, type Round, type RoundPhase, type Timings } from './round'
import { applyVerdict } from './score'
import type { Calibration, Frame, Orientation, PoseSpec } from './types'

/**
 * Забег: автомат, который связывает присутствие, такты раунда, судейство и
 * счёт. Последняя часть чистого ядра, и самая опасная: ошибка здесь не
 * локальна — она выглядит как дефект судейства, калибровки или присутствия, и
 * искать её будут не там.
 *
 * Шесть правил держат этот файл.
 *
 * - **Время приходит аргументом `tick`, часов внутри нет вовсе.**
 *   `performance.now()` сломал бы replay журнала из node, а replay —
 *   единственный способ разобрать спорный раунд, не переигрывая его с
 *   ребёнком. Фаза раунда поэтому считается от времени на каждом `tick`
 *   (`Round.phaseAt`), а не хранится состоянием.
 *
 * - **С момента, когда присутствие запросило паузу, забег НЕ СУДИТ ничего.**
 *   Это не про аккуратность, а про единственную дыру в защите от подмены
 *   субъекта: доверие к прежнему торсу истекает ровно за `presence.pauseMs`
 *   (`presence.ts`), и на первом кадре после истечения страж подмены выключен
 *   по построению — доверять нечему. Вошедшая в кадр мама отвергается `jump`
 *   все 700 мс, а на 701-й миллисекунде становится доверенным субъектом.
 *   Безопасно это ТОЛЬКО потому, что к этому моменту судейства уже нет: кадр,
 *   на котором `pauseRequested` стал истиной, в буфер не попадает, а раунд
 *   закрывается как `skip` с причиной `pause`.
 *
 * - **В буфер раунда идут и НЕВАЛИДНЫЕ кадры.** Судья считает `frames` —
 *   кадров в окне, — и `valid` — из них годных; выбрось невалидные здесь, и
 *   `frames` схлопнется в `valid`, а «ребёнка не было видно» станет
 *   неотличимо от «кадры не пришли вовсе». Для журнала и разбора это разные
 *   вещи (docs/judging.md «Что возвращает приговор»).
 *
 * - **Присутствие спрашивается с ориентацией ПОЗЫ РАУНДА, а не режима игры.**
 *   В раунде с `profile` фронтальная стойка — отказ, и наоборот
 *   (docs/presence-and-pause.md «Ориентация — свойство позы»). Ориентация
 *   режима молча отвергла бы все профильные раунды целиком — молча, потому
 *   что отказ выглядел бы как законный `orientation`.
 *
 * - **Память присутствия ОДНА на весь забег.** Она же — единственный источник
 *   истины о том, кто в кадре: вся защита от подмены держится на непрерывной
 *   памяти доверенного торса, и первый кадр серии не проверяется вовсе. Две
 *   памяти — тот же дефект, что две копии одного числа, только про состояние
 *   (docs/judging.md «Валидность приходит вместе с кадрами»).
 *
 * - **Время забега на паузе СТОИТ, а раунд, начавшийся до истечения времени,
 *   доигрывается целиком** (docs/judging.md «Счёт»). Поэтому игровое время
 *   копится отрезками: `elapsedBase` плюс открытый отрезок от `runningSince`.
 *
 * Отдельно про две шкалы времени, которые здесь встречаются и которые нельзя
 * путать. Расписание раунда живёт в той же шкале, что отметки кадров (`t` в
 * `tick`), — иначе окно судейства, отбирающее кадры по времени кадра, не
 * нашло бы ни одного. Потолок же забега мерится ИГРОВЫМ временем, которое на
 * паузе стоит. Расхождения эти две шкалы не дают: раунд, задетый паузой, не
 * судится вовсе, так что ни один раунд не переживает остановку часов.
 */

/** Фаза забега. Отсчёт «3, 2, 1» после возврата — дело оболочки, не ядра. */
export type RunPhase = 'running' | 'paused' | 'finished'

/** Итог одного раунда забега: строка журнала и слагаемое счёта. */
export type RoundOutcome = {
  spec: PoseSpec
  startT: number
  contactT: number
  /** Исход раунда. У несудимого — `skip`. */
  kind: Verdict['kind']
  /**
   * Приговор судьи целиком (с `perAxis` для журнала), либо `null` — раунд не
   * судился ВОВСЕ. «Не судился» и «судился и дал `skip`» — разные вещи: в
   * первом не было даже окна, во втором в окне не набралось валидных кадров.
   */
  verdict: Verdict | null
  /** Почему не `hit`. `'pause'` — раунд прерван паузой и потому не судился. */
  why?: VerdictReason | 'pause'
}

/** Снимок забега на момент `tick`. Значение: ничего в нём не меняется задним числом. */
export type RunState = {
  phase: RunPhase
  /** Игровое время забега, мс. На паузе СТОИТ. */
  elapsedMs: number
  remainingMs: number
  score: number
  /** Поза текущего раунда; на паузе — та, что пойдёт после возврата. */
  pose: PoseSpec | null
  /** Расписание текущего раунда; `null` на паузе и после конца забега. */
  round: Round | null
  roundPhase: RoundPhase | null
  /** Причина отказа присутствия, по которой встала пауза; `null` — паузы нет. */
  pauseWhy: PresenceReason | null
  outcomes: readonly RoundOutcome[]
}

export type RunOpts = {
  /** Отметка времени первого кадра забега — в той же шкале, что `t` в `tick`. */
  startT: number
  /** Потолок игрового времени. По умолчанию — `CONFIG.run.defaultDurationSec`. */
  durationSec?: number
  tier: 1 | 2 | 3
  toggles: Toggles
  /** Генератор случайных чисел для выбора поз: чистота забега держится на нём. */
  rnd: () => number
  cal: Calibration
  /** Множитель строгости (`strictness()` из `config.ts`). */
  strict: number
  timings: Timings
}

export type Run = {
  tick(t: number, frames: Frame[]): RunState
  readonly state: RunState
}

export function makeRun(opts: RunOpts): Run {
  const { startT, tier, toggles, rnd, cal, strict, timings } = opts
  const durationMs = (opts.durationSec ?? CONFIG.run.defaultDurationSec) * 1000

  const pst = newPresenceState()

  let phase: RunPhase = 'running'
  let score = 0
  const outcomes: RoundOutcome[] = []

  /** Накопленное игровое время закрытых отрезков. */
  let elapsedBase = 0
  /** Начало открытого отрезка игрового времени; `null` — часы стоят. */
  let runningSince: number | null = startT

  /** Предыдущая поза — для `nextPose`: ни повтора, ни зеркала сразу следом. */
  let prev: PoseSpec | null = null
  /** Поза, которая пойдёт после возврата с паузы. */
  let pending: PoseSpec | null = null

  let round: Round | null = null
  /** Кадры текущего раунда, ГОДНЫЕ И НЕГОДНЫЕ, в порядке времени. */
  let buffer: CheckedFrame[] = []

  let pauseWhy: PresenceReason | null = null
  /** Причина отказа последнего негодного кадра — ею называется причина паузы. */
  let lastWhy: PresenceReason = 'none'
  let now = startT

  const elapsedAt = (t: number): number =>
    elapsedBase + (runningSince === null ? 0 : Math.max(0, t - runningSince))

  const outOfTime = (t: number): boolean => elapsedAt(t) >= durationMs

  /**
   * Фаза читается функцией, а не полем: внутри `tick` её меняют `closeRound`
   * и `pauseAt`, и прямое сравнение TypeScript считал бы «сужением»,
   * невозможным после раннего выхода.
   */
  const at = (p: RunPhase): boolean => phase === p

  function pick(): PoseSpec {
    const spec = nextPose(prev, tier, toggles, rnd)
    prev = spec
    return spec
  }

  function startRound(t: number, spec: PoseSpec): void {
    round = makeRound(spec, t, timings)
    buffer = []
  }

  function finishAt(t: number): void {
    elapsedBase = elapsedAt(t)
    runningSince = null
    phase = 'finished'
    round = null
    buffer = []
    pending = null
    pauseWhy = null
  }

  /** Раунд доигран: судим по буферу, применяем к счёту и берём следующую позу. */
  function closeRound(r: Round): void {
    const verdict = judgeWindow({
      spec: r.spec,
      frames: buffer,
      contactT: r.contactT,
      latencyMs: timings.latencyMs,
      cal,
      strict,
    })
    score = applyVerdict(score, verdict)
    outcomes.push({
      spec: r.spec,
      startT: r.startT,
      contactT: r.contactT,
      kind: verdict.kind,
      verdict,
      ...(verdict.why === undefined ? {} : { why: verdict.why }),
    })
    round = null
    buffer = []

    // Раунд, начавшийся до истечения времени, доигран — теперь можно и
    // закончить забег. Проверка стоит ЗДЕСЬ, между раундами, а не в середине
    // раунда, ровно поэтому.
    if (outOfTime(r.endT)) finishAt(r.endT)
    else startRound(r.endT, pick())
  }

  /**
   * Присутствие попросило паузу. Отсюда и до возврата забег не судит: см.
   * второе правило файла — на этом держится вся защита от подмены субъекта.
   */
  function pauseAt(t: number): void {
    const r = round
    if (r !== null) {
      outcomes.push({
        spec: r.spec,
        startT: r.startT,
        contactT: r.contactT,
        kind: 'skip',
        verdict: null,
        why: 'pause',
      })
    }
    round = null
    buffer = []

    // Часы забега останавливаются ровно на отметке кадра, запросившего паузу.
    elapsedBase = elapsedAt(t)
    runningSince = null

    if (elapsedBase >= durationMs) {
      // Время вышло ещё в прерванном раунде: возвращаться некуда.
      finishAt(t)
      return
    }

    phase = 'paused'
    pauseWhy = lastWhy
    // Поза следующего раунда выбирается ЗДЕСЬ, а не на возврате: её
    // ориентацию присутствие спрашивает уже на паузе — иначе возврат судился
    // бы против ориентации позы, которой больше не будет.
    pending = pick()
  }

  function resumeAt(t: number): void {
    phase = 'running'
    pauseWhy = null
    runningSince = t
    startRound(t, pending ?? pick())
    pending = null
  }

  /** Ориентация, которую присутствие ждёт от кадра: свойство ПОЗЫ, не режима. */
  function expected(): Orientation {
    const spec = round?.spec ?? pending ?? prev
    // `prev` не бывает `null` после конструктора: первый раунд уже выбран.
    return spec === null ? 'front' : spec.orientation
  }

  /**
   * Кадр с вынесенным вердиктом присутствия — ГОДНЫЙ ИЛИ НЕГОДНЫЙ: в буфер
   * идут оба, см. третье правило файла.
   *
   * Утверждение про `lm` безопасно по построению присутствия, а не по вере:
   * `geometry(null)` даёт `null`, а `presence(null, …)` — отказ `none`, так
   * что до годной ветки кадр без скелета не доходит. Геометрия при этом
   * берётся из самого вердикта (`v.gm`) — ту же, что прошла проверки причин.
   */
  function checked(f: Frame, t: number): CheckedFrame {
    const gm = geometry(f.lm, cal.aspect)
    const v = presence(gm, t, pst, expected())
    if (!v.ok) lastWhy = v.why
    return v.ok
      ? { t, ok: true, lm: f.lm as NonNullable<Frame['lm']>, gm: v.gm }
      : { t, ok: false, why: v.why }
  }

  /** Закрывает все раунды, чьё время вышло к моменту `t`. */
  function advance(t: number): void {
    while (at('running') && round !== null && t >= round.endT) closeRound(round)
  }

  function snapshot(t: number): RunState {
    const elapsedMs = elapsedAt(t)
    return {
      phase,
      elapsedMs,
      remainingMs: Math.max(0, durationMs - elapsedMs),
      pose: round?.spec ?? pending ?? null,
      round,
      roundPhase: round === null ? null : round.phaseAt(t),
      score,
      pauseWhy,
      outcomes: [...outcomes],
    }
  }

  startRound(startT, pick())

  return {
    tick(t: number, frames: Frame[]): RunState {
      now = t
      if (at('finished')) return snapshot(t)

      // Кадры обрабатываются в порядке времени: память присутствия — автомат,
      // и переставленный кадр сдвинул бы её.
      for (const f of [...frames].sort((a, b) => a.t - b.t)) {
        // Раунд, чьё время вышло раньше этого кадра, закрывается ДО него —
        // иначе кадр превью следующего раунда попал бы в буфер предыдущего.
        advance(f.t)
        if (at('finished')) break

        // Пауза решается ДО того, как присутствие увидит этот кадр, и это
        // главная строчка файла. Отказ, дотянувший до `pauseMs`, уже
        // состоялся — а сам кадр гасить его не вправе: доверие к торсу
        // ребёнка истекает тем же сроком, и первым кадром после истечения
        // вошедшая в кадр мама становится доверенным субъектом (страж подмены
        // на первом кадре серии выключен по построению). Спроси присутствие
        // сначала, и её кадр ответит `ok`, обнулит отсчёт отказа — пауза не
        // встанет вовсе, а мамина поза уедет в приговор ребёнка.
        if (pauseRequested(pst, f.t)) pauseAt(f.t)

        // Присутствие видит кадр и на паузе: иначе возврат нечем подтвердить.
        const cf = checked(f, f.t)

        if (at('paused')) {
          if (resumeReady(pst, f.t)) resumeAt(f.t)
          continue
        }

        buffer.push(cf)
      }

      // Пауза обязана встать и тогда, когда кадры перестали приходить посреди
      // отказа: отсчёт отказа ведётся по времени, а не по числу кадров.
      if (at('running') && pauseRequested(pst, t)) pauseAt(t)

      advance(t)
      return snapshot(t)
    },

    get state(): RunState {
      return snapshot(now)
    },
  }
}
