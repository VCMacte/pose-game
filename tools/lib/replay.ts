/**
 * Replay: записанные строки скелета прогоняются через ТО ЖЕ ядро, и рядом
 * ставится приговор, вынесенный тогда. Расхождение — регрессия судейства.
 *
 * **Это работает только потому, что ядро чистое.** Ни `performance.now`, ни
 * камеры, ни DOM внутри ядра нет, а время приходит аргументом — и ровно
 * поэтому граница слоёв сторожится тестом. Разбор спорного раунда не должен
 * требовать переигрывания с ребёнком.
 *
 * Строки журнала — ЧУЖИЕ данные: дамп приходит с телефона, пережил обновления
 * игры и запись всплесками, которая дырявая по определению. Поэтому здесь всё
 * просеивается, и ни одна битая строка прогон не роняет.
 *
 * Разбор: `docs/log-and-storage.md`.
 */

import { judgeWindow } from '../../src/core/judge'
import type { CheckedFrame, Verdict } from '../../src/core/judge'
import { geometry } from '../../src/core/geometry'
import { newPresenceState, presence } from '../../src/core/presence'
import { POSES } from '../../src/core/poses'
import { LANDMARK_COUNT, LANDMARK_STRIDE } from '../../src/core/landmarks'
import type { Calibration, PoseSpec } from '../../src/core/types'

type Row = Record<string, unknown>

export type ReplayRound = {
  poseId: string
  contactT: number
  /** Приговор, записанный тогда. */
  recorded: { kind: Verdict['kind']; matched: number; valid: number; ratio: number }
  /** Приговор, пересчитанный сейчас. `null` — пересчитать было нечем. */
  replayed: Verdict | null
  /** Совпали ли исходы. `null` при непересчитанном раунде. */
  match: boolean | null
  /** Почему не пересчитан, если не пересчитан. */
  why?: 'no-lines' | 'no-calibration' | 'unknown-pose'
}

export type ReplayResult = {
  rounds: ReplayRound[]
  /** Раундов, где записанный и пересчитанный исход разошлись. */
  mismatches: number
  /** Раундов, которые пересчитать было нечем. */
  unreplayable: number
  /** Битых строк скелета, пропущенных молча. */
  skippedLines: number
}

/** Исход по записанным очкам: `+3` — успех, `−2` — провал, `0` — несудимый. */
function recordedKind(score: unknown): Verdict['kind'] {
  if (typeof score !== 'number') return 'skip'
  if (score > 0) return 'hit'
  if (score < 0) return 'miss'
  return 'skip'
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Строка скелета → `Landmarks`, либо `null`, если строка битая.
 *
 * Битых разновидностей тут четыре, и все встречаются: не объект, не массив,
 * неверная длина, нечисловое время. Укороченный скелет — тоже битая строка, а
 * не «скелет попроще»: судить по дырявому нельзя, `packLandmarks` на этом и
 * отказывает.
 */
function toLandmarks(row: unknown): { t: number; lm: Float32Array } | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Row
  if (typeof r.t !== 'number' || !Number.isFinite(r.t)) return null
  const v = r.v
  if (!Array.isArray(v) || v.length !== LANDMARK_COUNT * LANDMARK_STRIDE) return null

  const lm = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (typeof x !== 'number' || !Number.isFinite(x)) return null
    lm[i] = x
  }
  return { t: r.t, lm }
}

/** Калибровка из `calib.done`, либо `null`, если её в дампе нет. */
function calibrationOf(log: Row[]): Calibration | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (e.type !== 'calib.done') continue
    const need = ['S0', 'shoulderWidth', 'neutralX', 'neutralShoulderY', 'neutralHipY', 'aspect']
    if (need.some((k) => typeof e[k] !== 'number')) continue
    return {
      S0: e.S0 as number,
      shoulderWidth: e.shoulderWidth as number,
      neutralX: e.neutralX as number,
      neutralShoulderY: e.neutralShoulderY as number,
      neutralHipY: e.neutralHipY as number,
      aspect: e.aspect as number,
      at: num(e.at),
      ...(typeof e.takenAtMs === 'number' ? { takenAtMs: e.takenAtMs } : {}),
      ...(typeof e.cameraId === 'string' ? { cameraId: e.cameraId } : {}),
    }
  }
  return null
}

/**
 * Прогоняет дамп. Никогда не бросает: пустой, обрезанный и чужой дамп дают
 * пустой ответ — инструмент разбора, который падает на дырявых данных,
 * бесполезен ровно тогда, когда нужен.
 */
export function replay(dump: unknown): ReplayResult {
  const out: ReplayResult = { rounds: [], mismatches: 0, unreplayable: 0, skippedLines: 0 }
  const sessions = (dump as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(sessions)) return out

  for (const s of sessions) {
    const log = (s as { log?: unknown })?.log
    if (!Array.isArray(log)) continue
    replaySession(log as Row[], out)
  }
  return out
}

/** Все строки скелета сессии, разом и отсортированные по времени. */
function skeletonLines(log: Row[], out: ReplayResult): Array<{ t: number; lm: Float32Array }> {
  const lines: Array<{ t: number; lm: Float32Array }> = []
  for (const e of log) {
    if (e.type !== 'raw') continue
    const raw = e.lines
    if (!Array.isArray(raw)) continue
    for (const row of raw) {
      const got = toLandmarks(row)
      if (got) lines.push(got)
      else out.skippedLines++
    }
  }
  return lines.sort((a, b) => a.t - b.t)
}

function replaySession(log: Row[], out: ReplayResult): void {
  const cal = calibrationOf(log)
  const lines = skeletonLines(log, out)
  const latencyMs = latencyOf(log)

  /*
   * Раунд собирается по ОКНАМ: `round.preview` открывает раунд, `round.wall`
   * даёт время касания, `round.judge` закрывает. Привязка по времени, а не по
   * порядку в журнале: журнал пишется всплесками, и порядок в нём не обещан.
   */
  let pose: PoseSpec | null = null
  let poseId = ''
  let contactT: number | null = null

  for (const e of log) {
    if (e.type === 'round.preview') {
      poseId = typeof e.poseId === 'string' ? e.poseId : ''
      pose = POSES.find((p) => p.id === poseId) ?? null
      contactT = null
      continue
    }

    if (e.type === 'round.wall') {
      contactT = num(e.t)
      continue
    }

    if (e.type !== 'round.judge') continue

    const judgeT = num(e.t)
    const contact = contactT ?? judgeT
    const recorded = {
      kind: recordedKind(e.score),
      matched: num(e.matched),
      valid: num(e.valid),
      ratio: num(e.ratio),
    }

    const round: ReplayRound = { poseId, contactT: contact, recorded, replayed: null, match: null }

    const why = cannotReplay(pose, cal, lines)
    if (why) {
      round.why = why
      out.unreplayable++
      out.rounds.push(round)
      contactT = null
      continue
    }

    round.replayed = judgeWindow({
      spec: pose!,
      frames: checkedFrames(lines, pose!, cal!),
      contactT: contact,
      latencyMs,
      cal: cal!,
      strict: strictOf(log),
    })
    round.match = round.replayed.kind === recorded.kind
    if (!round.match) out.mismatches++
    out.rounds.push(round)
    contactT = null
  }
}

/**
 * Почему раунд не пересчитать.
 *
 * Нет строк скелета — НЕ расхождение: всплески ограничены бюджетом забега, у
 * большинства раундов строк нет вовсе, и считать это регрессией значило бы
 * тонуть в ложной тревоге. Нет калибровки — тоже отказ, а не судейство по
 * выдуманной: не тот масштаб даёт расхождения, которые будут артефактом
 * инструмента, а не находкой.
 */
function cannotReplay(
  pose: PoseSpec | null,
  cal: Calibration | null,
  lines: Array<{ t: number; lm: Float32Array }>,
): ReplayRound['why'] | null {
  if (!pose) return 'unknown-pose'
  if (!cal) return 'no-calibration'
  if (lines.length === 0) return 'no-lines'
  return null
}

/**
 * Строки → кадры с вынесенным вердиктом присутствия, той же дорогой, какой их
 * собирает забег: `geometry()` → `presence()` с ориентацией ПОЗЫ раунда.
 *
 * Судья эту работу не повторяет и повторить не вправе — иначе replay судил бы
 * иначе, чем игра, и расхождение означало бы дефект инструмента.
 */
function checkedFrames(
  lines: Array<{ t: number; lm: Float32Array }>,
  pose: PoseSpec,
  cal: Calibration,
): CheckedFrame[] {
  const st = newPresenceState()
  const out: CheckedFrame[] = []
  for (const { t, lm } of lines) {
    const gm = geometry(lm, cal.aspect)
    const r = presence(gm, t, st, pose.orientation)
    out.push(r.ok ? { t, lm, ...r } : { t, ...r })
  }
  return out
}

/** Сдвиг на задержку, как он был записан в забеге. */
function latencyOf(log: Row[]): number {
  for (const e of log) {
    if (e.type === 'round.wall' && typeof e.latencyShiftMs === 'number') return e.latencyShiftMs
    if (e.type === 'run.start' && typeof e.latencyMs === 'number') return e.latencyMs
  }
  return 0
}

/**
 * Множитель строгости ТОГО забега, а не нынешний по умолчанию: подставить
 * сегодняшнюю строгость значило бы объявить регрессией смену настройки.
 */
function strictOf(log: Row[]): number {
  for (const e of log) {
    if (e.type === 'run.start' && typeof e.strict === 'number' && e.strict > 0) return e.strict
  }
  return 1
}
