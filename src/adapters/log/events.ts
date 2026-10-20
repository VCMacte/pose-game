/**
 * Типизированные конструкторы событий журнала (§8 спека,
 * `docs/log-and-storage.md`).
 *
 * Зачем конструкторы, а не вызовы `event('round.judge', {...})` по месту:
 * журнал читают инструменты разбора (`tools/replay.mjs`,
 * `tools/log-report.mjs`) и взрослый глазами. Имя события и состав полей —
 * это их входной формат, и опечатка в нём не ломает ничего сегодня, а
 * обнаруживается через месяц пустой сводкой. Здесь состав полей проверяет
 * компилятор.
 *
 * Главное поле журнала — `perAxis` у `round.judge`: по нему взрослый читает
 * «левое плечо 58° при цели 90±30», не переигрывая спорный раунд с ребёнком.
 * Поэтому `perAxis` сохраняет ВСЁ различение, которое вынесло ядро, —
 * см. `loggedPerAxis` ниже.
 */

import type { Axis, MeasuredBy } from '../../core/axes'
import type { AxisTally, PerAxisSummary } from '../../core/judge'
import type { AxisOutcome } from '../../core/match'
import type { PresenceReason } from '../../core/presence'
import type { AxisRequirements, Orientation } from '../../core/types'
import type { LogEvent } from './store'

/** Конверт события с точным типом данных: `data` уходит в запись как есть. */
export type Of<T extends string, D extends object> = { type: T; data: D }

// ───────────────────────── perAxis ─────────────────────────

/**
 * Одна ось в журнале: исход по окну, измеренное значение и то, чем измерено.
 *
 * `measured` — `number | null`, и `null` значит «мерить было нечем»
 * (`NaN` в ядре). Ноль здесь был бы ложью — «измерили и вышло 0°», — а
 * выброшенное поле неотличимо от забытого. `NaN` не выживает в JSON, которым
 * журнал выгружается, поэтому «нечем» записывается явным `null`.
 *
 * `measuredBy` есть там, где ось умеет мерить по-разному (сейчас такая одна —
 * ноги: по стопам и по коленям). Без него «ноги 2.0» не прочесть.
 */
export type LoggedAxis = {
  want: string
  got: string
  measured: number | null
  measuredBy?: MeasuredBy
  /** `ok` / `miss` / `unmeasured` / `excused` — различение из ядра целиком. */
  outcome: AxisOutcome
  ok: boolean
  /** Сколько валидных кадров окна дали каждый исход. */
  counts: AxisTally
}

export type LoggedPerAxis = {
  axes: Partial<Record<Axis, LoggedAxis>>
  worst: PerAxisSummary['worst']
}

/**
 * Разбор по осям из приговора судьи в вид журнала.
 *
 * Кадр-представитель (`sample`) приплюснут к оси: его `want` и `outcome`
 * совпадают с оконными по построению (`judgeWindow` берёт первый кадр с худшим
 * исходом окна), так что ничего не теряется, а читать журнал плоским проще.
 */
export function loggedPerAxis(p: PerAxisSummary): LoggedPerAxis {
  const axes: Partial<Record<Axis, LoggedAxis>> = {}
  for (const [axis, s] of Object.entries(p.axes) as [Axis, PerAxisSummary['axes'][Axis]][]) {
    if (!s) continue
    const line: LoggedAxis = {
      want: s.want,
      got: s.sample.got,
      measured: Number.isFinite(s.sample.measured) ? s.sample.measured : null,
      outcome: s.outcome,
      ok: s.sample.ok,
      counts: { ...s.counts },
    }
    if (s.sample.measuredBy !== undefined) line.measuredBy = s.sample.measuredBy
    axes[axis] = line
  }
  return { axes, worst: p.worst }
}

// ───────────────────────── события забега ─────────────────────────

export type RoundPreviewData = {
  poseId: string
  mirror: boolean
  orientation: Orientation
  /** Требуемые состояния осей — то, с чем сравнивали приговор. */
  requires: Partial<AxisRequirements>
  tier: 1 | 2 | 3
}

export const roundPreview = (d: RoundPreviewData): Of<'round.preview', RoundPreviewData> => ({
  type: 'round.preview',
  data: d,
})

export type RoundWallData = {
  travelMs: number
  /** Сдвиг окна судейства на задержку тракта — ВПЕРЁД от касания стены. */
  latencyShiftMs: number
  /**
   * Игровое время КАСАНИЯ стены — полем, а не по отметке `t` конверта.
   *
   * Конверт несёт РАМОЧНЫЕ часы (мс от старта сессии), а окно судейства живёт
   * в игровом времени забега, которое на паузе стоит. Две шкалы расходятся на
   * всю длительность пауз, и replay, бравший касание из конверта, отбирал
   * кадры не того промежутка — то есть не находил ни одного и отвечал «нечего
   * пересчитывать». Поймано при подключении забега к журналу.
   */
  contactT: number
}

export const roundWall = (d: RoundWallData): Of<'round.wall', RoundWallData> => ({ type: 'round.wall', data: d })

export type RoundJudgeData = {
  poseId: string
  /** Валидных кадров окна, совпавших с позой. */
  matched: number
  frames: number
  valid: number
  ratio: number
  perAxis: LoggedPerAxis
  /** Очков за раунд. */
  score: number
  /** Счёт забега после раунда. */
  total: number
}

export const roundJudge = (d: Omit<RoundJudgeData, 'perAxis'> & { perAxis: PerAxisSummary }): Of<
  'round.judge',
  RoundJudgeData
> => ({
  type: 'round.judge',
  data: { ...d, perAxis: loggedPerAxis(d.perAxis) },
})

/** Почему раунд не судился или не дал приговора. */
export type SkipWhy = 'pause' | 'lost' | 'fewFrames' | 'orientation'

export type RoundSkipData = { why: SkipWhy; valid: number }

export const roundSkip = (d: RoundSkipData): Of<'round.skip', RoundSkipData> => ({ type: 'round.skip', data: d })

export type RunStartData = {
  tier: 1 | 2 | 3
  durationS: number
  /** Множитель строгости (`strictness()` из `config.ts`). */
  strict: number
  latencyMs: number
  /**
   * Откуда кадры. `fake` помечает синтетического игрока: ни один замер не
   * должен потом быть принят за настоящий.
   */
  source: 'camera' | 'fake'
}

export const runStart = (d: RunStartData): Of<'run.start', RunStartData> => ({ type: 'run.start', data: d })

export type RunFinishData = {
  score: number
  rounds: number
  hits: number
  misses: number
  skipped: number
  tier: 1 | 2 | 3
  durationS: number
}

export const runFinish = (d: RunFinishData): Of<'run.finish', RunFinishData> => ({ type: 'run.finish', data: d })

// ───────────────────────── здоровье и пауза ─────────────────────────

/**
 * Агрегат здоровья конвейера — РАЗ В СЕКУНДУ, не на кадр: запись каждой позы
 * это десятки мегабайт за сессию при потолке 25 МБ.
 */
export type HealthData = {
  fps: number
  inferP50: number
  inferP95: number
  /** Кадров отброшено, потому что предыдущий ещё в полёте. */
  drops: number
  /** Валидных кадров за секунду и кадров без игрока. */
  valid: number
  lost: number
}

export const health = (d: HealthData): Of<'health', HealthData> => ({ type: 'health', data: d })

/**
 * Причина паузы. `manual` — её попросил человек кнопкой, остальные приходят от
 * присутствия.
 *
 * Ручная пауза пишется В ТО ЖЕ событие, а не в своё: сводка считает паузы по
 * причинам, и отдельное событие дало бы журнал, расходящийся с самим собой —
 * «пауз ноль» рядом с записью о паузе. Так же сделано в `run-game`.
 */
export type PauseWhy = PresenceReason | 'manual'

export const pause = (d: { why: PauseWhy }): Of<'pause', { why: PauseWhy }> => ({
  type: 'pause',
  data: d,
})

/**
 * Забег прерван и НЕ дошёл до конца: взрослый вышел в меню с паузы.
 *
 * Отдельно от `run.finish`, а не полем в нём: прерванный забег результатом не
 * является, и смешать их значило бы испортить и статистику, и калибровку
 * порогов — половина забега без конца не говорит о порогах ничего.
 *
 * `where` — не украшение: журнал единственный свидетель, и «прервано с паузы»
 * иначе не отличить от «прервано из меню». Приём из `run-game`.
 */
export type RunAbortData = {
  where: 'pause' | 'menu'
  /** Сколько игрового времени прошло до прерывания. */
  elapsedMs: number
  /** Раундов успели сыграть. */
  rounds: number
  score: number
}

export const runAbort = (d: RunAbortData): Of<'run.abort', RunAbortData> => ({
  type: 'run.abort',
  data: d,
})

export const resume = (d: { afterMs: number }): Of<'resume', { afterMs: number }> => ({ type: 'resume', data: d })

// ───────────────────────── инфраструктурные ─────────────────────────

export type SessionStartData = {
  startedAt: string
  /** `ШхВ@dpr` — по нему видно, в каком режиме шла съёмка. */
  screen: string
  installed: boolean
  lang: string
}

export const sessionStart = (d: SessionStartData): Of<'session.start', SessionStartData> => ({
  type: 'session.start',
  data: d,
})

export const build = (d: { version: string; builtAt?: string }): Of<'build', { version: string; builtAt?: string }> => ({
  type: 'build',
  data: d,
})

export type ErrorData = { message: string; source?: string; line?: number; col?: number }

export const error = (d: ErrorData): Of<'error', ErrorData> => ({ type: 'error', data: d })

export const errorPromise = (d: { reason: string }): Of<'error.promise', { reason: string }> => ({
  type: 'error.promise',
  data: d,
})

export const visibility = (d: { state: 'visible' | 'hidden' }): Of<'visibility', { state: 'visible' | 'hidden' }> => ({
  type: 'visibility',
  data: d,
})

export type CamStartData = { w: number; h: number; facing?: string; deviceId?: string }

export const camStart = (d: CamStartData): Of<'cam.start', CamStartData> => ({ type: 'cam.start', data: d })

export const camFail = (d: { name: string; message: string }): Of<'cam.fail', { name: string; message: string }> => ({
  type: 'cam.fail',
  data: d,
})

/** Android отбирает камеру на звонке: дорожка кончается или глохнет. */
export const camEnded = (d: { why: 'ended' | 'mute' }): Of<'cam.ended', { why: 'ended' | 'mute' }> => ({
  type: 'cam.ended',
  data: d,
})

/**
 * Источник позы завёлся. `warmupMs` — МЕДИАНА десяти прогревочных инференсов
 * по серому кадру, и это главное поле записи: заявленный делегат умеет врать,
 * а медиана выше `POSE.warmupCpuMs` означает, что считает процессор, что бы
 * ни было написано в `delegate`. Отсюда и `looksLikeCpu` — приговор по замеру,
 * а не по ответу библиотеки. `null` у медианы значит «не замерили»; ноль был
 * бы ложью («замерили и вышло 0 мс»).
 */
export type PoseReadyData = {
  pipeline: string
  delegate: 'GPU' | 'CPU'
  warmupMs: number | null
  initMs?: number | null
  looksLikeCpu?: boolean | null
  source?: string
  script?: string
}

export const poseReady = (d: PoseReadyData): Of<'pose.ready', PoseReadyData> => ({ type: 'pose.ready', data: d })

/**
 * Источник позы отказал ЦЕЛИКОМ, а не отдельной ступенью: камера не подключена
 * к источнику, синтетический игрок не передан, итератор кадров бросил. Для
 * ступеней лестницы есть `pose.pipeline.down` — см. ниже, и путать их нельзя.
 */
export const poseFail = (d: {
  pipeline: string
  message: string
}): Of<'pose.fail', { pipeline: string; message: string }> => ({ type: 'pose.fail', data: d })

/**
 * Откуда берутся кадры и какая лестница поднимается. Пишется ОДИН раз на
 * запуск источника, до первой попытки.
 *
 * `rejected` — значение `?pipeline=`, не совпавшее ни с одной ступенью
 * (опечатка, либо намеренно отсутствующий `main/CPU`). Без этого поля
 * отвергнутый принудительный выбор выглядел бы на штативе как «меня молча
 * проигнорировали»: полная лестница поехала, а почему — не из чего понять.
 */
export type PoseSourceData = {
  source: 'camera' | 'fake'
  hz: number
  /** Ступени, которые будут пробоваться, по порядку. */
  ladder: string[]
  /** Принудительный выбор, если он сработал. */
  forced?: string
  rejected?: string
  script?: string
}

export const poseSource = (d: PoseSourceData): Of<'pose.source', PoseSourceData> => ({
  type: 'pose.source',
  data: d,
})

/** Ступень начала подниматься. Пара к `pose.ready` и к `pose.pipeline.down`. */
export type PoseBootData = { pipeline: string; index: number; delegate: 'GPU' | 'CPU' }

export const poseBoot = (d: PoseBootData): Of<'pose.boot', PoseBootData> => ({ type: 'pose.boot', data: d })

/**
 * ОДНА ошибка инференса — ещё не отказ ступени: кадр приходит закрытым, и это
 * бывает на вполне живом конвейере. Отдельное событие именно затем, чтобы
 * одиночная ошибка не читалась разбором журнала как сошедшая ступень; порог
 * «пять подряд» (`ERRORS_BEFORE_NEXT`) превращает её в `pose.pipeline.down`
 * с `why: 'died'`.
 */
export type PoseErrorData = {
  pipeline: string
  stage: string
  name?: string
  message: string
  seq?: number
}

export const poseError = (d: PoseErrorData): Of<'pose.error', PoseErrorData> => ({ type: 'pose.error', data: d })

/**
 * Почему ступень лестницы больше не работает — **ПОЛЕМ**:
 *
 * - `unsupported` — ступень пропущена, её возможности в этом браузере нет
 *   (нет `Worker`, `MediaStreamTrackProcessor`, `createImageBitmap`). Она даже
 *   не пробовалась;
 * - `open` — пробовалась и не открылась: воркер не ответил `ready` за
 *   `POSE.initTimeoutMs`, wasm без SIMD, модель не загрузилась;
 * - `died` — открылась, отдала `ready`, а потом сошла: пять ошибок инференса
 *   подряд, молчание дольше `POSE.aliveTimeoutMs`, конец потока кадров.
 *
 * Три случая различаются полем, а не разбором русской прозы из `message`:
 * на штативе проза — не поле, а разбору журнала надо отличать «браузер не
 * умеет» от «GPU-делегат соврал и помер».
 */
export type PipelineDownWhy = 'unsupported' | 'open' | 'died'

export type PosePipelineDownData = { pipeline: string; why: PipelineDownWhy; message: string }

export const posePipelineDown = (d: PosePipelineDownData): Of<'pose.pipeline.down', PosePipelineDownData> => ({
  type: 'pose.pipeline.down',
  data: d,
})

/**
 * Итог замера задержки тракта.
 *
 * `ok: false` пишется ТОЖЕ, и это не формальность: неудавшийся замер — самый
 * интересный случай для разбора. Без записи он выглядел бы в журнале как «не
 * мерили», а на самом деле мерили и не услышали — то есть телевизор был
 * приглушён или микрофон не дал разрешения.
 *
 * **Записанного звука здесь нет и быть не может** — только числа. Игра про
 * ребёнка в его комнате, и запись из неё не уходит.
 */
export type LatencyMeasuredData = {
  ok: boolean
  /** Выстрелов в серии. */
  shots: number
  /** Из них услышано. */
  heard: number
  medianMs?: number
  spreadMs?: number
  message?: string
}

export const latencyMeasured = (d: LatencyMeasuredData): Of<'latency.measured', LatencyMeasuredData> => ({
  type: 'latency.measured',
  data: d,
})

// ───────────────────────── калибровка ─────────────────────────

/**
 * Снятая калибровка. Времён здесь ДВА, и путать их нельзя: `at` — кадровое,
 * от старта сессии (та же шкала, что `t` конверта), `takenAtMs` — настенное.
 * Срок устаревания (14 дней) считается ТОЛЬКО по настенному: кадровое
 * обнуляется при каждом запуске приложения.
 */
/**
 * Снятая калибровка — ЦЕЛИКОМ, все поля `Calibration`.
 *
 * **Нейтральные высоты тоже, и это не полнота ради полноты.** По ним судится
 * присед (`axes.ts`: просадка плеч и бёдер против нейтрали, в долях `S0`), а
 * значит без них replay не может пересчитать раунд вовсе. Прежняя запись
 * несла только `S0`, ширину плеч и отношение сторон — и `tools/replay.mjs` на
 * настоящем журнале отвечал «нет калибровки» на каждый раунд. Поймано при
 * подключении забега к журналу: сквозной тест этого не видел, потому что
 * писал калибровку в журнал сам и целиком.
 */
export type CalibDoneData = {
  S0: number
  shoulderWidth: number
  neutralX: number
  neutralShoulderY: number
  neutralHipY: number
  aspect: number
  at: number
  takenAtMs: number
  cameraId?: string
}

export const calibDone = (d: CalibDoneData): Of<'calib.done', CalibDoneData> => ({ type: 'calib.done', data: d })

export const calibNeed = (d: {
  need: 'more' | 'steady'
}): Of<'calib.need', { need: 'more' | 'steady' }> => ({ type: 'calib.need', data: d })

export const calibStale = (d: {
  why: 'age' | 'aspect' | 'camera' | 'missing'
}): Of<'calib.stale', { why: 'age' | 'aspect' | 'camera' | 'missing' }> => ({ type: 'calib.stale', data: d })

/** Любой конструктор отсюда годится журналу: `write()` берёт конверт как есть. */
export type AnyEvent = LogEvent
