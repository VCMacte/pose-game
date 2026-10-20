/**
 * Печать для обоих инструментов. Вывод — человеку за столом, а не машине:
 * взрослый читает его глазами, снимая журнал с телефона ребёнка.
 *
 * Разбор: `docs/log-and-storage.md`.
 */

import { readFileSync } from 'node:fs'

import { replay } from './replay'
import { report } from './report'

/** Читает дамп. Нечитаемый файл — внятный отказ, а не стек. */
export function readDump(path: string | undefined): unknown {
  if (!path) {
    process.stderr.write('нужен путь к дампу журнала\n')
    process.exit(2)
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    process.stderr.write(`не читается ${path}: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(2)
  }
}

export function printReplay(path: string | undefined): void {
  const r = replay(readDump(path))

  process.stdout.write(`раундов: ${r.rounds.length}\n`)
  process.stdout.write(`пересчитано: ${r.rounds.length - r.unreplayable}\n`)
  process.stdout.write(`без строк скелета: ${r.unreplayable}\n`)
  process.stdout.write(`битых строк пропущено: ${r.skippedLines}\n`)
  process.stdout.write(`РАСХОЖДЕНИЙ: ${r.mismatches}\n`)

  for (const round of r.rounds) {
    if (round.replayed === null) continue
    const mark = round.match ? '  ok' : 'РАЗНО'
    process.stdout.write(
      `${mark}  ${round.poseId.padEnd(22)} t=${round.contactT}` +
        `  записано=${round.recorded.kind} (${round.recorded.matched}/${round.recorded.valid})` +
        `  сейчас=${round.replayed.kind} (${round.replayed.matched}/${round.replayed.valid})\n`,
    )
  }

  /*
   * Расхождение — РЕГРЕССИЯ судейства, и выход ненулевой: так инструмент
   * годится и для прогона в CI, а не только для чтения глазами.
   */
  if (r.mismatches > 0) process.exit(1)
}

export function printReport(path: string | undefined): void {
  const r = report(readDump(path))

  if (r.synthetic) {
    // Первой строкой, а не сноской: синтетические числа, принятые за живые,
    // хуже отсутствия калибровки — они выглядят доказательством.
    process.stdout.write('ВНИМАНИЕ: в журнале есть забеги на СИНТЕТИЧЕСКОМ игроке\n\n')
  }

  process.stdout.write(`сессий: ${r.sessions}, забегов: ${r.runs}\n`)
  process.stdout.write(
    `исходы: hit ${r.verdicts.hit}, miss ${r.verdicts.miss}, skip ${r.verdicts.skip}\n`,
  )
  process.stdout.write(`счёт: лучший ${r.score.best}, последний ${r.score.last}\n`)
  process.stdout.write(
    `частота: ${r.health.fps} fps, инференс p50 ${r.health.inferP50} / p95 ${r.health.inferP95} мс,` +
      ` отброшено ${r.health.drops}\n`,
  )

  const pauses = Object.entries(r.pauses).sort((a, b) => b[1] - a[1])
  process.stdout.write(`\nпаузы по причинам:${pauses.length ? '' : ' нет'}\n`)
  for (const [why, n] of pauses) process.stdout.write(`  ${why.padEnd(14)} ${n}\n`)

  const axes = Object.entries(r.axisMisses).sort((a, b) => b[1] - a[1])
  process.stdout.write(`\nпромахи по осям:${axes.length ? '' : ' нет'}\n`)
  for (const [axis, n] of axes) process.stdout.write(`  ${axis.padEnd(14)} ${n}\n`)

  if (r.hardestPose) {
    process.stdout.write(
      `\nчаще всего не даётся: ${r.hardestPose.poseId}` +
        ` — ${r.hardestPose.misses} провалов из ${r.hardestPose.attempts} попыток\n`,
    )
  }
}
