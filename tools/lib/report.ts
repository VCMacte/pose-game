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
  /**
   * Числа по сводкам `health`, и подписаны они ровно тем, чем являются.
   *
   * **`inferMedian` — медиана ОКОН, `inferWorst` — худшее окно по p95.** Это
   * не придирка к словам: квантили считаются ВНУТРИ окна (`shell/loop.ts`), а
   * среднее квантилей — не квантиль. Прежде отчёт брал медиану девяноста
   * пятых процентилей и печатал её как `p95` забега, то есть скрывал ровно то
   * худшее окно, ради которого p95 и смотрят. Урок перенесён из `run-game`,
   * где он записан дословно.
   *
   * `windows` — сколько окон посчитано, с весом склейки. Без него числа не
   * прочесть: медиана по двум окнам и по двумстам — разной цены.
   */
  health: { fps: number; inferMedian: number; inferWorst: number; drops: number; windows: number }
  /** Текст тревоги → сколько раз показана. */
  alarms: Record<string, number>
  /**
   * Причина ЗАПЕРТОЙ автопаузы → сколько раз забег запирался.
   *
   * Отдельно от `pauses`: та говорит «игра встала», а эта — «встала и сама не
   * встала бы», то есть забег кончился ничем. В живом забеге 22.10.2026 это
   * случилось по `orientation` и стоило всего захода.
   */
  stuckPauses: Record<string, number>
  /** Чего не хватило калибровке → сколько раз она об этом сказала. */
  calibFailed: Record<string, number>
  /** Сколько раз страница уходила из видимости. */
  hidden: number
  /** Ошибок за все сессии: `error`, `error.promise`, `pose.fail`. */
  errors: number
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

/**
 * Сколько событий означает одна запись журнала.
 *
 * Журнал сворачивает одинаковые подряд события в одну запись со счётчиком
 * `_n` (`adapters/log/store.ts`), и одна запись может означать до пятисот
 * событий. Счёт по записям давал бы «пауза одна» там, где их было двести; у
 * `run-game` на этом один журнал печатал несогласованные между собой числа —
 * отбросы считались с весом, а окна без.
 */
const occurrences = (e: Row): number => {
  const n = e._n
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 1) return 1
  /*
   * Вес ОБРЕЗАЕТСЯ потолком склейки. Сам журнал выше него не поднимается
   * (`LIMITS.repeat` в `adapters/log/store.ts`), но отчёт читает произвольный
   * JSON с диска: запись с `_n: 1e9` заставила бы его выделять память до
   * отказа — то есть инструмент умирал бы на том самом журнале, который
   * разбирают. Найдено код-ревью. Копия числа здесь намеренная и помечена:
   * тащить в инструмент разбора хранилище с IndexedDB ради одной константы
   * значило бы тащить и браузерные зависимости.
   */
  return Math.min(Math.floor(n), REPEAT_CAP)
}

/** Потолок склейки повторов — та же величина, что `LIMITS.repeat` у стора. */
const REPEAT_CAP = 500

/** Прибавляет счётчику по ключу вес записи. */
function bump(into: Record<string, number>, key: unknown, weight = 1): void {
  if (typeof key !== 'string' || key.length === 0) return
  into[key] = (into[key] ?? 0) + weight
}

export function report(dump: unknown): Report {
  const out: Report = {
    sessions: 0,
    runs: 0,
    verdicts: { hit: 0, miss: 0, skip: 0 },
    pauses: {},
    axisMisses: {},
    hardestPose: null,
    health: { fps: 0, inferMedian: 0, inferWorst: 0, drops: 0, windows: 0 },
    alarms: {},
    stuckPauses: {},
    calibFailed: {},
    hidden: 0,
    errors: 0,
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
  let windows = 0
  /**
   * Считать ли окна здоровья, которые идут сейчас.
   *
   * Отрезается ПРОСТОЙ ПОСЛЕ ФИНИША: экран забега живёт и после него, инференс
   * продолжается, пока взрослый не ушёл в меню, и окна простоя втекали бы в
   * числа забега — у `run-game` 355 секунд на экране результата раздули 187
   * окон до 535, то есть 60 fps вместо 55.
   *
   * А вот окна ДО забега считаются, и начальное значение здесь поэтому
   * `true`: `run.start` пишется ПОСЛЕ калибровки, так что окна калибровки
   * лежат раньше него, и выбросить их значило бы ослепнуть ровно в самом
   * интересном случае — когда калибровка не сдаётся и надо знать, с какой
   * частотой и каким инференсом она не сдавалась.
   */
  let counting = true

  for (const s of sessions) {
    const log = (s as { log?: unknown })?.log
    if (!Array.isArray(log)) continue
    out.sessions++
    /*
     * Признак сбрасывается НА ГРАНИЦЕ СЕССИИ: сессия — это один запуск
     * приложения, и их в файле до двадцати. Иначе забег, доигранный до
     * финиша, выключал бы счёт окон у всех последующих сессий — молча и тем
     * вернее, чем аккуратнее взрослый доигрывал.
     */
    counting = true

    for (const row of log as Row[]) {
      if (!row || typeof row !== 'object') continue
      const e = row

      switch (e.type) {
        case 'run.start':
          out.runs++
          counting = true
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
          counting = false
          break

        // Прерванный забег закрывает окно кадров так же, как доигранный:
        // дальше идёт меню, а не забег.
        case 'run.abort':
          counting = false
          break

        case 'round.judge': {
          const kind = num(e.score) > 0 ? 'hit' : num(e.score) < 0 ? 'miss' : 'skip'
          const weight = occurrences(e)
          out.verdicts[kind] += weight
          const id = typeof e.poseId === 'string' ? e.poseId : ''
          if (id) {
            attempts[id] = (attempts[id] ?? 0) + weight
            if (kind === 'miss') misses[id] = (misses[id] ?? 0) + weight
          }
          /*
           * Оси считаются ТОЛЬКО у незачтённых раундов. У зачтённого `worst`
           * тоже есть — это просто самая слабая из сошедшихся осей, — и
           * считать её промахом значило бы раздувать ответ на вопрос «что нам
           * мешает» осями, которые не помешали ничему.
           */
          if (kind !== 'hit') countAxes(e.perAxis, out.axisMisses, weight)
          break
        }

        case 'round.skip':
          out.verdicts.skip += occurrences(e)
          break

        case 'pause':
          bump(out.pauses, e.why, occurrences(e))
          break

        case 'pause.stuck':
          bump(out.stuckPauses, e.why, occurrences(e))
          break

        case 'calib.need':
          bump(out.calibFailed, e.need, occurrences(e))
          break

        case 'alarm':
          // Текстом, а не числом: взрослый спрашивает «что игра сказала», и
          // ответ «три тревоги» на этот вопрос не отвечает.
          bump(out.alarms, e.text, occurrences(e))
          break

        case 'visibility':
          if (e.state === 'hidden') out.hidden += occurrences(e)
          break

        case 'error':
        case 'error.promise':
        case 'pose.fail':
          out.errors += occurrences(e)
          break

        case 'health': {
          // Простой после финиша не считается — см. `counting`.
          if (!counting) break
          const w = occurrences(e)
          windows += w
          /*
           * Ноль в `inferP50` значит «инференса НЕ БЫЛО» — синтетический
           * источник или ещё не заведшийся конвейер, — а не «инференс занял
           * ноль миллисекунд». Такие окна в медиану не входят: ноль был бы
           * ложью (тот же запрет, что у `measured` в осях), и на живом
           * журнале 22.10 он утянул медиану в ноль при живом инференсе
           * восьмидесяти миллисекунд (число — в `docs/log-and-storage.md`, и
           * живёт оно там). В частоту и в число окон такие окна входят: кадры
           * в них настоящие.
           */
          const infer = num(e.inferP50)
          const worst = num(e.inferP95)
          for (let i = 0; i < w; i++) {
            fps.push(num(e.fps))
            if (infer > 0) p50.push(infer)
            if (worst > 0) p95.push(worst)
          }
          drops += num(e.drops) * w
          break
        }

        default:
          // Событие из будущей версии игры. Не повод отказаться разобрать
          // всё остальное: журнал переживает обновления.
          break
      }
    }
  }

  /*
   * `inferWorst` — МАКСИМУМ по окнам, а не медиана: см. тип `Report['health']`.
   */
  out.health = {
    fps: median(fps),
    inferMedian: median(p50),
    /*
     * `reduce`, а не `Math.max(...p95)`: длинный массив рассыпанных аргументов
     * бросает `RangeError`, и сводка падала бы на самом длинном журнале —
     * ровно том, который и разбирают. Найдено код-ревью.
     */
    inferWorst: p95.reduce((a, b) => (b > a ? b : a), 0),
    drops,
    windows,
  }

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
function countAxes(perAxis: unknown, into: Record<string, number>, weight = 1): void {
  if (!perAxis || typeof perAxis !== 'object') return
  const p = perAxis as { worst?: unknown; axes?: unknown }

  /*
   * `worst` — та ось, которую судейство само назвало помешавшей чаще всего;
   * пересчитывать её здесь значило бы завести вторую копию логики сравнения.
   */
  if (typeof p.worst === 'string') {
    bump(into, p.worst, weight)
    return
  }

  // Старая запись без `worst`: берём все оси с исходом не `match`.
  if (p.axes && typeof p.axes === 'object') {
    for (const [axis, line] of Object.entries(p.axes as Record<string, unknown>)) {
      const l = line as { outcome?: unknown } | null
      if (l && typeof l === 'object' && l.outcome !== 'match') bump(into, axis, weight)
    }
  }
}
