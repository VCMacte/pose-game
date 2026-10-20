/**
 * Сводка по журналу: исходы раундов, паузы по причинам, промахи по осям, какая
 * поза чаще всего не даётся, частота и задержки инференса.
 *
 * Отвечает на вопросы, которые взрослый задаёт журналу на самом деле: «почему
 * забег не идёт» и «какую позу убрать или переразметить». Поэтому паузы
 * считаются ПО ПРИЧИНАМ, а не общим числом: «тебя не видно» и «второй человек
 * в кадре» — разные беды и лечатся по-разному.
 *
 * Строки журнала — чужие данные, пережившие обновления игры: неизвестное
 * событие не повод отказаться разобрать всё остальное.
 *
 * Разбор: `docs/log-and-storage.md`.
 */

type Row = Record<string, unknown>

export type Report = {
  sessions: number
  runs: number
  verdicts: { hit: number; miss: number; skip: number }
  /** Причина паузы → сколько раз. */
  pauses: Record<string, number>
  /** Ось → сколько раз она помешала зачёту. */
  axisMisses: Record<string, number>
  /** Поза, которая чаще всего не даётся. */
  hardestPose: { poseId: string; misses: number; attempts: number } | null
  /** Медианы по сводкам `health`. */
  health: { fps: number; inferP50: number; inferP95: number; drops: number }
  /**
   * Хотя бы один забег шёл на синтетическом игроке.
   *
   * Помечается ОБЯЗАТЕЛЬНО: журнал — единственный вход калибровки порогов, и
   * синтетические числа, принятые за живые, хуже отсутствия калибровки, потому
   * что выглядят доказательством.
   */
  synthetic: boolean
  score: { best: number; last: number }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Медиана, а не среднее: один выброс в серии — обычное дело. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10
}

/** Прибавляет единицу счётчику по ключу. */
function bump(into: Record<string, number>, key: unknown): void {
  if (typeof key !== 'string' || key.length === 0) return
  into[key] = (into[key] ?? 0) + 1
}

export function report(dump: unknown): Report {
  const out: Report = {
    sessions: 0,
    runs: 0,
    verdicts: { hit: 0, miss: 0, skip: 0 },
    pauses: {},
    axisMisses: {},
    hardestPose: null,
    health: { fps: 0, inferP50: 0, inferP95: 0, drops: 0 },
    synthetic: false,
    score: { best: 0, last: 0 },
  }

  const sessions = (dump as { sessions?: unknown } | null)?.sessions
  if (!Array.isArray(sessions)) return out

  /** Попытки и провалы по позам: по ним и считается «не даётся». */
  const attempts: Record<string, number> = {}
  const misses: Record<string, number> = {}
  const fps: number[] = []
  const p50: number[] = []
  const p95: number[] = []
  let drops = 0

  for (const s of sessions) {
    const log = (s as { log?: unknown })?.log
    if (!Array.isArray(log)) continue
    out.sessions++

    for (const row of log as Row[]) {
      if (!row || typeof row !== 'object') continue
      const e = row

      switch (e.type) {
        case 'run.start':
          out.runs++
          if (e.source === 'fake') out.synthetic = true
          break

        case 'fake.source':
          // Пометка синтетического источника приходит и отдельным событием:
          // забег мог не начаться, а источник уже объявил себя.
          out.synthetic = true
          break

        case 'run.finish':
          out.score.last = num(e.score)
          out.score.best = Math.max(out.score.best, num(e.score))
          break

        case 'round.judge': {
          const kind = num(e.score) > 0 ? 'hit' : num(e.score) < 0 ? 'miss' : 'skip'
          out.verdicts[kind]++
          const id = typeof e.poseId === 'string' ? e.poseId : ''
          if (id) {
            attempts[id] = (attempts[id] ?? 0) + 1
            if (kind === 'miss') misses[id] = (misses[id] ?? 0) + 1
          }
          /*
           * Оси считаются ТОЛЬКО у незачтённых раундов. У зачтённого `worst`
           * тоже есть — это просто самая слабая из сошедшихся осей, — и
           * считать её промахом значило бы раздувать ответ на вопрос «что нам
           * мешает» осями, которые не помешали ничему.
           */
          if (kind !== 'hit') countAxes(e.perAxis, out.axisMisses)
          break
        }

        case 'round.skip':
          out.verdicts.skip++
          break

        case 'pause':
          bump(out.pauses, e.why)
          break

        case 'health':
          fps.push(num(e.fps))
          p50.push(num(e.inferP50))
          p95.push(num(e.inferP95))
          drops += num(e.drops)
          break

        default:
          // Событие из будущей версии игры. Не повод отказаться разобрать
          // всё остальное: журнал переживает обновления.
          break
      }
    }
  }

  out.health = { fps: median(fps), inferP50: median(p50), inferP95: median(p95), drops }

  /*
   * «Не даётся» — по числу ПРОВАЛОВ, а не по доле: поза, провалённая один раз
   * из одного, дала бы долю 1.0 и возглавила бы список, ничего при этом не
   * говоря. Доля отдаётся рядом (`attempts`), чтобы взрослый видел и её.
   */
  let worst: Report['hardestPose'] = null
  for (const [poseId, n] of Object.entries(misses)) {
    if (!worst || n > worst.misses) worst = { poseId, misses: n, attempts: attempts[poseId] ?? n }
  }
  out.hardestPose = worst

  return out
}

/**
 * Оси, помешавшие зачёту: считается `worst`, названная самим судейством.
 *
 * Зовётся только для незачтённых раундов — см. место вызова.
 */
function countAxes(perAxis: unknown, into: Record<string, number>): void {
  if (!perAxis || typeof perAxis !== 'object') return
  const p = perAxis as { worst?: unknown; axes?: unknown }

  /*
   * `worst` — та ось, которую судейство само назвало помешавшей чаще всего;
   * пересчитывать её здесь значило бы завести вторую копию логики сравнения.
   */
  if (typeof p.worst === 'string') {
    bump(into, p.worst)
    return
  }

  // Старая запись без `worst`: берём все оси с исходом не `match`.
  if (p.axes && typeof p.axes === 'object') {
    for (const [axis, line] of Object.entries(p.axes as Record<string, unknown>)) {
      const l = line as { outcome?: unknown } | null
      if (l && typeof l === 'object' && l.outcome !== 'match') bump(into, axis)
    }
  }
}
