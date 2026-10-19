import { AXES, axes, type Axis } from './axes'
import { CONFIG } from './config'
import { matchFrame, type AxisOutcome, type AxisVerdict } from './match'
import type { PresenceResult } from './presence'
import type { Calibration, Landmarks, PoseSpec } from './types'

/**
 * Приговор за раунд: голосование по окну кадров. Совпадение ОДНОГО кадра — не
 * здесь (`match.ts`), годность кадра — тоже не здесь (`presence.ts`).
 *
 * Читать вместе с docs/judging.md («Сдвиг на задержку», «Правило приговора»).
 * Это самая ответственная функция ядра: от неё зависит, что ребёнок увидит,
 * зелёную стену или красную. Шесть правил держат файл:
 *
 * - **Валидность приходит ВМЕСТЕ с кадрами, судья её не считает.** Присутствие
 *   забега — единственный источник истины о том, кто в кадре: вся защита от
 *   подмены субъекта держится на НЕПРЕРЫВНОЙ памяти доверенного торса, и
 *   первый кадр серии сознательно не проверяется вовсе. Своя память на каждое
 *   окно означала бы, что внутри окна защита от вошедшей в кадр мамы
 *   выключена, а приговор судьи расходится с тем, что видел забег. Поэтому
 *   `judgeWindow()` не создаёт `PresenceState` и не зовёт `presence()`: он
 *   получает кадры с уже вынесенным вердиктом и ЧИТАЕТ его.
 * - **Сдвиг на задержку — ВПЕРЁД:** окно равно
 *   `[contact + latency − windowMs, contact + latency]`. Ребёнок видит касание
 *   стены на `latency` ПОЗЖЕ, чем оно случилось в игре, и позу держит под то,
 *   что видит, — значит судить надо кадры, пришедшие ПОСЛЕ игрового касания.
 *   Сдвиг назад удваивает рассинхрон вместо того, чтобы его снять; эта ошибка
 *   уже была допущена однажды, и на знак сдвига стоит отдельный тест, который
 *   обязан падать при его смене.
 * - **Кадры отбираются строго по ВРЕМЕНИ кадра, а не по номеру раунда.** При
 *   задержке 400 мс и ходе стены 1.5 с окно уезжает за границу раунда и
 *   формально перекрывает превью следующего; верные позы вне окна не имеют
 *   права давать `hit`.
 * - **Знаменатель — ВАЛИДНЫЕ кадры, не все.** Кадры, в которых трекер потерял
 *   ребёнка, не имеют права съедать очки; невалидные влияют только на порог
 *   «≥ `minValid` валидных». При нуле валидных отношение считается нулём, а не
 *   делением на ноль, и исход — `skip`.
 * - **`perAxis` — главное, ради чего существует журнал.** По нему взрослый
 *   читает «левое плечо 58° при цели 90±30», не переигрывая раунд с ребёнком,
 *   поэтому агрегат сохраняет различение исходов `matchFrame` (`miss` —
 *   «сделал не то», `unmeasured` — «не смогли измерить», `excused` — дальняя
 *   конечность в профиле) и называет ось, помешавшую зачёту чаще всего.
 * - **Время приходит аргументом.** `performance.now()` здесь сломал бы replay
 *   журнала из node, а replay — единственный способ разобрать спорный раунд,
 *   не переигрывая его с ребёнком.
 */

/** Годная ветка вердикта присутствия — та же, что у `presence.ts`, с геометрией кадра. */
type Valid = Extract<PresenceResult, { ok: true }>

/** Негодная ветка: одна причина отказа. Скелет и геометрия такому кадру не нужны. */
type Invalid = Extract<PresenceResult, { ok: false }>

/**
 * Кадр, пришедший в судейство с УЖЕ вынесенным вердиктом присутствия.
 *
 * Собирает его тот, кто ведёт память присутствия забега (`run.ts`), на каждом
 * кадре видео: `geometry()` → `presence()` с ориентацией, которую требует поза
 * раунда, → кадр в буфер. Судья эту работу не повторяет — см. первое правило в
 * doc-комментарии выше.
 *
 * Валидный кадр несёт скелет и геометрию ровно потому, что присутствие их уже
 * проверило: типы говорят это вслух, и недостижимых проверок на `null` в
 * судействе не остаётся.
 */
export type CheckedFrame = ({ t: number; lm: Landmarks } & Valid) | ({ t: number } & Invalid)

/** Сколько валидных кадров окна дали каждый исход по одной оси. */
export type AxisTally = Record<AxisOutcome, number>

/**
 * Итог одной оси по ОКНУ.
 *
 * `counts` отвечает на «как часто», `sample` — на «что именно вышло»: это
 * строка журнала кадра-представителя, первого кадра с худшим исходом окна.
 * Ради неё судейство и возвращает измерения, а не один булев флаг.
 */
export type AxisSummary = {
  /** Требуемое состояние, строкой — одно и то же во всех кадрах окна. */
  want: string
  counts: AxisTally
  /** Худший исход по окну: `miss` хуже `unmeasured`, тот хуже `excused` и `ok`. */
  outcome: AxisOutcome
  /** Кадр-представитель: первый кадр окна с исходом `outcome`. */
  sample: AxisVerdict
}

/** Разбор приговора по осям — то самое поле `round.judge.perAxis` журнала. */
export type PerAxisSummary = {
  /** По каждой оси из `spec.requires`, кроме ориентации: её судит присутствие. */
  axes: Partial<Record<Axis, AxisSummary>>
  /**
   * Ось, помешавшая зачёту в наибольшем числе валидных кадров, и это число.
   * Мешают `miss` и `unmeasured`; `excused` не мешает (дальняя конечность в
   * профиле), `ok` тем более. `null` — помешавших осей не было вовсе.
   */
  worst: { axis: Axis; frames: number } | null
}

/** Почему приговор не `hit`. Есть ровно при `kind` ≠ `hit`. */
export type VerdictReason = 'fewFrames' | 'lowRatio'

/** Приговор за раунд. */
export type Verdict = {
  kind: 'hit' | 'miss' | 'skip'
  why?: VerdictReason
  /** Кадров, попавших В ОКНО. Не число кадров раунда и не длина входа. */
  frames: number
  /** Из них тех, что присутствие забега признало годными. */
  valid: number
  /** Из валидных — совпавших с позой. */
  matched: number
  /** `matched / valid`; при нуле валидных — `0`, а не `NaN`. */
  ratio: number
  perAxis: PerAxisSummary
}

/** Насколько исход мешает зачёту: им выбирается худший исход оси по окну. */
const SEVERITY: Record<AxisOutcome, number> = { ok: 0, excused: 1, unmeasured: 2, miss: 3 }

/**
 * В скольких валидных кадрах ось помешала зачёту. Мешают `miss` и
 * `unmeasured`; `excused` не мешает — это свойство самой позы (дальняя
 * конечность в профиле), `ok` тем более.
 */
const blocked = (c: AxisTally): number => c.miss + c.unmeasured

/**
 * Приговор за раунд по окну кадров.
 *
 * `contactT` — игровое время касания стены, `latencyMs` — задержка тракта
 * камера→экран. Оба в той же шкале, что `CheckedFrame.t`.
 *
 * `frames` — кадры с уже вынесенным вердиктом присутствия; годность здесь не
 * пересчитывается. Чистая функция: ни состояния, ни часов.
 */
export function judgeWindow(args: {
  spec: PoseSpec
  frames: CheckedFrame[]
  contactT: number
  latencyMs: number
  cal: Calibration
  strict: number
}): Verdict {
  const { spec, frames, contactT, latencyMs, cal, strict } = args

  // Сдвиг ВПЕРЁД. Знак здесь — главное в файле, см. doc-комментарий выше.
  const end = contactT + latencyMs
  const start = end - CONFIG.judge.windowMs

  // Отбор по времени кадра, границы включительны. Порядок по времени нужен
  // `sample`: кадр-представитель оси — ПЕРВЫЙ кадр окна с худшим исходом.
  const window = frames.filter((f) => f.t >= start && f.t <= end).sort((a, b) => a.t - b.t)

  const perAxis: Partial<Record<Axis, AxisSummary>> = {}
  let valid = 0
  let matched = 0

  for (const f of window) {
    // Вердикт присутствия ЧИТАЕТСЯ. Пересчитать его здесь значило бы завести
    // вторую память о субъекте — см. первое правило файла.
    if (!f.ok) continue

    valid += 1
    const m = matchFrame(spec, axes(f.lm, f.gm, cal, strict))
    if (m.matched) matched += 1

    for (const axis of Object.keys(m.perAxis) as Axis[]) absorb(perAxis, axis, m.perAxis[axis]!)
  }

  const ratio = valid === 0 ? 0 : matched / valid
  const kind = outcome(valid, ratio)
  const why = reason(kind)

  return {
    kind,
    ...(why === undefined ? {} : { why }),
    frames: window.length,
    valid,
    matched,
    ratio,
    perAxis: { axes: perAxis, worst: worstAxis(perAxis) },
  }
}

/**
 * Приговор по итогам голосования. Оба порога включительны.
 *
 * Порог валидных кадров ОДИН — `minValid`. Любая вторая граница ниже него
 * оставляла бы полосу, в которой раунд судится, а зачёт недоступен: минус два
 * очка за раунд, в котором ребёнка почти не было видно. Разбор —
 * docs/concept-and-plan.md, раздел развороты.
 */
function outcome(valid: number, ratio: number): Verdict['kind'] {
  if (valid < CONFIG.judge.minValid) return 'skip'
  return ratio >= CONFIG.judge.ratio ? 'hit' : 'miss'
}

/**
 * Почему не `hit`. Причин ровно две, и каждая однозначно связана с `kind`:
 * `skip` бывает только от недостатка валидных кадров, `miss` — только от
 * недотянувшего отношения. Третьего исхода нет, поэтому набор исчерпан.
 */
function reason(kind: Verdict['kind']): VerdictReason | undefined {
  if (kind === 'hit') return undefined
  return kind === 'skip' ? 'fewFrames' : 'lowRatio'
}

/** Добавляет приговор по оси одного кадра в итог окна. */
function absorb(acc: Partial<Record<Axis, AxisSummary>>, axis: Axis, v: AxisVerdict): void {
  const s =
    acc[axis] ??
    (acc[axis] = {
      want: v.want,
      counts: { ok: 0, miss: 0, unmeasured: 0, excused: 0 },
      outcome: v.outcome,
      sample: v,
    })

  s.counts[v.outcome] += 1
  if (SEVERITY[v.outcome] > SEVERITY[s.outcome]) {
    s.outcome = v.outcome
    s.sample = v
  }
}

/**
 * Ось, помешавшая зачёту чаще всех. Равный счёт разрешается порядком `AXES` —
 * канонического списка осей, — чтобы приговор не зависел от порядка ключей.
 */
function worstAxis(acc: Partial<Record<Axis, AxisSummary>>): PerAxisSummary['worst'] {
  let worst: PerAxisSummary['worst'] = null

  for (const axis of AXES) {
    const s = acc[axis]
    if (s === undefined) continue

    const frames = blocked(s.counts)

    if (frames > 0 && (worst === null || frames > worst.frames)) worst = { axis, frames }
  }

  return worst
}
