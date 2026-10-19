import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { cutouts } from '../../src/core/poses'
import { newPresenceState, presence } from '../../src/core/presence'
import { makeRun, type Run, type RunOpts, type RunState } from '../../src/core/run'
import type { Timings } from '../../src/core/round'
import type { Calibration, Frame, PoseSpec } from '../../src/core/types'
import { stick, type StickDesc } from '../../src/fake/stick'

/**
 * Забег: автомат, связывающий присутствие, такты раунда, судейство и счёт.
 *
 * Пять правил держат этот файл, и три из них — пойманные ревью ошибки, которые
 * ничем, кроме теста, не видны:
 *
 * - **С момента, когда присутствие запросило паузу, не судится ничего.**
 *   Доверие к прежнему торсу истекает ровно за `pauseMs`, и на следующем кадре
 *   вошедшая в кадр мама становится доверенным субъектом с выключенным на этот
 *   кадр стражем подмены. Безопасно это ТОЛЬКО если с момента запроса паузы
 *   судейства нет. Тест держит обе половины: и что раунд не судится, и что
 *   мамины кадры присутствие и правда признаёт годными.
 * - **В буфер раунда идут и НЕВАЛИДНЫЕ кадры.** Иначе `Verdict.frames`
 *   схлопывается в `valid`, и «ребёнка не было видно» становится неотличимо от
 *   «кадры не пришли вовсе» — для журнала это разные вещи.
 * - **Присутствие спрашивается с ориентацией ПОЗЫ РАУНДА, а не режима игры.**
 *   Ориентация режима молча отвергла бы все профильные раунды целиком.
 * - **Время забега на паузе стоит, прерванный раунд даёт `skip`** и счёта не
 *   трогает: ребёнок не отвечает за то, что трекер его потерял.
 * - **Ядро не возобновляет забег само.** Подтверждённый возврат поднимает
 *   `canResume`, но забег остаётся на паузе, и часы его стоят, пока оболочка
 *   не позовёт `resume`: отсчёт «3, 2, 1» рисует она, и часы под ним идти не
 *   должны — иначе ребёнок теряет три секунды забега за паузу, которой не
 *   устраивал.
 * - **Часов внутри нет.** Время приходит аргументом `tick`, иначе replay
 *   журнала из node невозможен; на это стоит отдельный тест по исходнику.
 */

const ASPECT = 16 / 9

const shot = (desc: Partial<StickDesc>): Float32Array => stick({ aspect: ASPECT, ...desc })

function calibrate(): Calibration {
  const g = geometry(shot({}), ASPECT)!
  return {
    S0: g.S,
    shoulderWidth: g.shoulderRatio * g.S,
    neutralX: g.cx,
    neutralShoulderY: g.shoulderMid.y,
    neutralHipY: g.hipMid.y,
    aspect: ASPECT,
    at: 0,
  }
}

const CAL = calibrate()

const T: Timings = { previewMs: 2000, wallMs: 2000, latencyMs: 150, verdictMs: 800 }

/** Длина раунда при `T`: 4950 мс. */
const ROUND_MS = T.previewMs + T.wallMs + T.latencyMs + T.verdictMs

/** 12 Гц, как на живой камере. */
const PERIOD = 83

const START = 1_000

const opts = (over: Partial<RunOpts> = {}): RunOpts => ({
  startT: START,
  durationSec: 10,
  tier: 1,
  toggles: {},
  rnd: () => 0,
  cal: CAL,
  strict: 1,
  timings: T,
  ...over,
})

/** Что показывает кадр: позу, `null` — трекер потерял ребёнка, `'gap'` — кадра не было вовсе. */
type Shown = Partial<StickDesc> | null | 'gap'

type How = (t: number, pose: PoseSpec | null, i: number) => Shown

/** Кадр с позой ТЕКУЩЕГО раунда: забег обязан спрашивать ориентацию у неё. */
const right: How = (_t, pose) =>
  pose === null ? null : { orientation: pose.orientation, ...pose.requires }

/**
 * Та же поза с опущенными руками: кадр валиден, поза не совпала. Трогаются
 * только плечи: предплечье при прямом локте кинематика задать не даёт.
 */
const wrong: How = (t, pose, i) => {
  const d = right(t, pose, i)
  return d === null || d === 'gap' ? d : { ...d, leftShoulder: 'down', rightShoulder: 'down' }
}

/** Верная поза, но трекер потерял ребёнка: присутствие отвергает (`lowvis`). */
const lowvis: How = (t, pose, i) => {
  const d = right(t, pose, i)
  return d === null || d === 'gap' ? d : { ...d, visibility: 0.2 }
}

/** Отметки времени, которыми гонится забег: 12 Гц от `from` до `to` включительно. */
function ticks(from: number, to: number): number[] {
  const out: number[] = []
  for (let t = from; t <= to; t += PERIOD) out.push(t)
  return out
}

/** Гонит забег шагом 12 Гц, строя кадр по позе того раунда, который идёт сейчас. */
function drive(run: Run, from: number, to: number, how: How): RunState {
  let last = run.state
  ticks(from, to).forEach((t, i) => {
    const d = how(t, last.pose, i)
    const frames: Frame[] = d === 'gap' ? [] : [{ t, lm: d === null ? null : shot(d) }]
    last = run.tick(t, frames)
  })
  return last
}

/** `rnd`, которым `nextPose` на ПЕРВОМ выборе берёт названную позу. */
function picks(id: string, tier: 1 | 2 | 3): () => number {
  const pool = cutouts(tier, {})
  const i = pool.findIndex((p) => p.id === id)
  if (i < 0) throw new Error(`picks: позы «${id}» нет в пуле ступени ${tier}`)
  return () => (i + 0.5) / pool.length
}

describe('такты, счёт и конец забега', () => {
  test('счёт за забег складывается из приговоров', () => {
    const run = makeRun(opts())
    const s = drive(run, START, START + 20_000, right)

    expect(s.phase).toBe('finished')
    expect(s.outcomes.length).toBe(3)
    expect(s.outcomes.map((o) => o.kind)).toEqual(['hit', 'hit', 'hit'])
    expect(s.score).toBe(CONFIG.score.hit * 3)
    // Приговор раунда сохранён целиком: по нему разбирают спорный раунд.
    expect(s.outcomes[0].verdict!.valid).toBeGreaterThanOrEqual(CONFIG.judge.minValid)
  })

  test('подряд идущие раунды берут разные позы', () => {
    const run = makeRun(opts())
    const s = drive(run, START, START + 20_000, right)
    const ids = s.outcomes.map((o) => o.spec.id)

    expect(ids[0]).not.toBe(ids[1])
    expect(ids[1]).not.toBe(ids[2])
  })

  test('сумма упирается в ноль', () => {
    const run = makeRun(opts())
    const s = drive(run, START, START + 20_000, wrong)

    expect(s.outcomes.map((o) => o.kind)).toEqual(['miss', 'miss', 'miss'])
    expect(s.score).toBe(CONFIG.score.floor)
  })

  test('забег кончается по времени, начатый раунд доигрывается', () => {
    // Два раунда: второй начат на 5950-й мс при потолке 6 с и доигран до 10900.
    const run = makeRun(opts({ durationSec: 6 }))

    const mid = drive(run, START, START + 7_000, right)
    expect(mid.phase).toBe('running')
    expect(mid.elapsedMs).toBeGreaterThan(6_000)
    expect(mid.outcomes.length).toBe(1)

    const end = drive(run, START + 7_000 + PERIOD, START + 12_000, right)
    expect(end.phase).toBe('finished')
    expect(end.outcomes.length).toBe(2)
    expect(end.elapsedMs).toBe(2 * ROUND_MS)
  })

  test('после конца забега tick ничего не меняет', () => {
    const run = makeRun(opts({ durationSec: 6 }))
    const end = drive(run, START, START + 12_000, right)
    const after = drive(run, START + 12_000 + PERIOD, START + 30_000, right)

    expect(after.phase).toBe('finished')
    expect(after.outcomes.length).toBe(end.outcomes.length)
    expect(after.score).toBe(end.score)
    expect(after.elapsedMs).toBe(end.elapsedMs)
  })

  test('повторный tick в тот же момент не судит раунд дважды', () => {
    const run = makeRun(opts())
    const s = drive(run, START, START + ROUND_MS + 200, right)
    const again = run.tick(START + ROUND_MS + 200, [])

    expect(again.outcomes.length).toBe(s.outcomes.length)
    expect(again.score).toBe(s.score)
  })

  test('фаза раунда считается от времени каждый tick', () => {
    const run = makeRun(opts())
    const r = run.state.round!

    expect(run.tick(r.startT + 10, []).roundPhase).toBe('preview')
    expect(run.tick(r.contactT - 10, []).roundPhase).toBe('wall')
    expect(run.tick(r.contactT + 10, []).roundPhase).toBe('freeze')
    expect(run.tick(r.verdictT + 10, []).roundPhase).toBe('verdict')
  })
})

describe('пауза', () => {
  /** Момент, когда присутствие просит паузу: 700 мс непрерывного отказа. */
  const firstLost = START + 1_000
  const lostFrom = ticks(START, START + 20_000).find((t) => t >= firstLost)!

  const vanish: How = (t, pose, i) => (t >= firstLost ? null : right(t, pose, i))

  test('пауза останавливает время забега', () => {
    const run = makeRun(opts())

    const paused = drive(run, START, lostFrom + CONFIG.presence.pauseMs + PERIOD, vanish)
    expect(paused.phase).toBe('paused')
    const frozen = paused.elapsedMs

    // Ещё четыре секунды отсутствия — время забега не сдвинулось ни на мс.
    const later = drive(
      run,
      lostFrom + CONFIG.presence.pauseMs + 2 * PERIOD,
      lostFrom + CONFIG.presence.pauseMs + 4_000,
      vanish,
    )
    expect(later.phase).toBe('paused')
    expect(later.elapsedMs).toBe(frozen)
    expect(frozen).toBeLessThan(ROUND_MS)
  })

  test('раунд, прерванный паузой, даёт skip и счёта не меняет', () => {
    const run = makeRun(opts())
    const s = drive(run, START, lostFrom + CONFIG.presence.pauseMs + PERIOD, vanish)

    expect(s.outcomes.length).toBe(1)
    expect(s.outcomes[0].kind).toBe('skip')
    expect(s.outcomes[0].why).toBe('pause')
    // Раунд НЕ судился вовсе — это не то же самое, что судился и дал `skip`.
    expect(s.outcomes[0].verdict).toBeNull()
    expect(s.score).toBe(0)
    expect(s.pauseWhy).toBe('none')
  })

  test('раунд стартует только после подтверждённого возврата', () => {
    const run = makeRun(opts())
    const backAt = lostFrom + CONFIG.presence.pauseMs + 2_000
    const comeback: How = (t, pose, i) => (t >= backAt ? right(t, pose, i) : vanish(t, pose, i))

    const soon = drive(run, START, backAt + CONFIG.presence.resumeMs - PERIOD, comeback)
    expect(soon.phase).toBe('paused')
    expect(soon.round).toBeNull()

    expect(soon.canResume).toBe(false)

    const readyT = backAt + CONFIG.presence.resumeMs + 2 * PERIOD
    const ready = drive(run, backAt + CONFIG.presence.resumeMs, readyT, comeback)
    // Готовность есть, а продолжения нет: его зовёт оболочка, дорисовав отсчёт.
    expect(ready.phase).toBe('paused')
    expect(ready.canResume).toBe(true)
    expect(ready.round).toBeNull()

    const back = run.resume(ticks(backAt + CONFIG.presence.resumeMs, readyT).at(-1)!)
    expect(back.phase).toBe('running')
    expect(back.round).not.toBeNull()
    expect(back.round!.startT).toBeGreaterThanOrEqual(backAt + CONFIG.presence.resumeMs)
    expect(back.roundPhase).toBe('preview')
  })

  test('часы забега стоят между готовностью и явным возобновлением', () => {
    const run = makeRun(opts())
    const backAt = lostFrom + CONFIG.presence.pauseMs + 2_000
    const comeback: How = (t, pose, i) => (t >= backAt ? right(t, pose, i) : vanish(t, pose, i))

    const readyAt = ticks(START, START + 60_000).find((t) => t >= backAt + CONFIG.presence.resumeMs)!
    const ready = drive(run, START, readyAt, comeback)
    expect(ready.phase).toBe('paused')
    const frozen = ready.elapsedMs

    // Оболочка ведёт свой отсчёт «3, 2, 1»: почти три секунды, за которые
    // идущие часы съели бы больше половины раунда — будь они не остановлены,
    // это было бы видно на `elapsedMs` невооружённым глазом.
    const countdownEnd = readyAt + 2_900
    const waited = drive(run, readyAt + PERIOD, countdownEnd, comeback)
    expect(waited.phase).toBe('paused')
    expect(waited.canResume).toBe(true)
    expect(waited.elapsedMs).toBe(frozen)

    // Продолжение — только явным вызовом, и часы идут с него, а не с готовности.
    const lastT = ticks(readyAt + PERIOD, countdownEnd).at(-1)!
    const resumed = run.resume(lastT)
    expect(resumed.phase).toBe('running')
    expect(resumed.canResume).toBe(false)
    expect(resumed.elapsedMs).toBe(frozen)
    expect(resumed.round!.startT).toBe(lastT)

    // Не идемпотентен: второй вызов — ошибка оболочки, и она её увидит.
    expect(() => run.resume(lastT)).toThrow(/паузы нет/)
  })

  test('ошибочный вызов возобновления оболочка заметит', () => {
    const run = makeRun(opts())
    // Паузы ещё нет вовсе.
    expect(() => run.resume(START)).toThrow(/паузы нет/)

    const at = lostFrom + CONFIG.presence.pauseMs + PERIOD
    const paused = drive(run, START, at, vanish)
    expect(paused.phase).toBe('paused')
    // Возврат не подтверждён: ребёнка не видно вовсе.
    expect(paused.canResume).toBe(false)
    expect(() => run.resume(at)).toThrow(/возврат не подтверждён/)
    // Отказ не сдвинул ни фазу, ни часы.
    expect(run.state.phase).toBe('paused')
    expect(run.state.elapsedMs).toBe(paused.elapsedMs)
    // Время назад не идёт.
    expect(() => run.resume(START)).toThrow(/время идёт назад/)
  })

  test('после запроса паузы не судится ничего', () => {
    // Вошедшая в кадр мама: другой торс, другое место. За `pauseMs` доверие к
    // торсу ребёнка истекает, и мама становится доверенным субъектом — на её
    // первом кадре страж подмены выключен. Безопасно это только потому, что с
    // момента запроса паузы забег не судит.
    const mom: Partial<StickDesc> = { torso: 0.33, x: 0.33 }
    const run = makeRun(opts())
    const r1 = run.state.round!
    const pose = r1.spec

    const how: How = (t) => {
      if (t < firstLost) return { orientation: pose.orientation, ...pose.requires }
      if (t < lostFrom + CONFIG.presence.pauseMs) return null
      // Мама держит ТУ САМУЮ позу раунда — судись она, был бы `hit`.
      return { ...mom, orientation: pose.orientation, ...pose.requires }
    }

    const s = drive(run, START, r1.endT + PERIOD, how)

    expect(s.outcomes.filter((o) => o.spec.id === pose.id)[0].kind).toBe('skip')
    expect(s.outcomes.filter((o) => o.spec.id === pose.id)[0].verdict).toBeNull()
    expect(s.outcomes.some((o) => o.verdict !== null)).toBe(false)
    expect(s.score).toBe(0)

    // Половина теста, без которой он зелёный по неверной причине: опасность
    // настоящая, мамины кадры присутствие и правда признаёт годными.
    const st = newPresenceState()
    const verdicts = ticks(START, r1.endT + PERIOD).map((t) => {
      const d = how(t, pose, 0)
      const lm = d === 'gap' || d === null ? null : shot(d)
      return presence(lm === null ? null : geometry(lm, ASPECT), t, st, pose.orientation)
    })
    const window = ticks(START, r1.endT + PERIOD).map((t, i) => ({ t, ok: verdicts[i].ok }))
    const inWindow = window.filter((f) => f.t >= r1.verdictT - CONFIG.judge.windowMs && f.t <= r1.verdictT)
    expect(inWindow.length).toBeGreaterThanOrEqual(CONFIG.judge.minValid)
    expect(inWindow.every((f) => f.ok)).toBe(true)
  })
})

describe('буфер кадров раунда', () => {
  test('невалидные кадры тоже попадают в приговор', () => {
    // Два отказа из трёх кадров: отказ непрерывен лишь 166 мс, паузы нет.
    const run = makeRun(opts())
    const r1 = run.state.round!
    const patchy: How = (t, pose, i) => (i % 3 === 2 ? right(t, pose, i) : lowvis(t, pose, i))

    const s = drive(run, START, r1.endT + PERIOD, patchy)
    const v = s.outcomes[0].verdict!
    const expected = ticks(START, r1.endT + PERIOD).filter(
      (t) => t >= r1.verdictT - CONFIG.judge.windowMs && t <= r1.verdictT,
    ).length

    expect(s.phase).toBe('running')
    // `frames` — кадров в окне, включая те, в которых ребёнка не было видно.
    expect(v.frames).toBe(expected)
    expect(v.valid).toBeLessThan(v.frames)
    expect(v.valid).toBeGreaterThan(0)
  })

  test('«ребёнка не было видно» отличимо от «кадры не пришли вовсе»', () => {
    const r1 = makeRun(opts())
    const round = r1.state.round!
    // Отказов в окне столько, что валидных не хватает на приговор.
    const seldom: How = (t, pose, i) => (i % 8 === 0 ? right(t, pose, i) : lowvis(t, pose, i))

    const unseen = drive(r1, START, round.endT + PERIOD, seldom).outcomes[0].verdict!

    const r2 = makeRun(opts())
    // Кадры перестали приходить вовсе: ни одного кадра в окне.
    const silent: How = (t, pose, i) => (t > round.contactT - 1_000 ? 'gap' : right(t, pose, i))
    const nothing = drive(r2, START, round.endT + PERIOD, silent).outcomes[0].verdict!

    expect(unseen.kind).toBe('skip')
    expect(nothing.kind).toBe('skip')
    expect(unseen.frames).toBeGreaterThan(0)
    expect(nothing.frames).toBe(0)
  })

  test('окно судейства раунда не залезает в превью следующего', () => {
    // Задержка 400 мс при ходе стены 1.5 с: окно уезжает за касание стены.
    const timings: Timings = { previewMs: 2000, wallMs: 1500, latencyMs: 400, verdictMs: 800 }
    const run = makeRun(opts({ timings, durationSec: 60 }))
    const r1 = run.state.round!
    // Верную позу ребёнок показывает ТОЛЬКО после окна — в такте приговора и
    // в превью следующего раунда.
    const late: How = (t, pose, i) => (t > r1.verdictT ? right(t, pose, i) : wrong(t, pose, i))

    const s = drive(run, START, r1.endT + 2_000, late)
    const v = s.outcomes[0].verdict!
    const expected = ticks(START, r1.endT + 2_000).filter(
      (t) => t >= r1.verdictT - CONFIG.judge.windowMs && t <= r1.verdictT,
    ).length

    expect(v.frames).toBe(expected)
    expect(v.matched).toBe(0)
    expect(v.kind).toBe('miss')
    expect(s.outcomes[0].spec.id).toBe(r1.spec.id)
  })
})

describe('ориентация', () => {
  test('присутствие вызывается с ориентацией позы раунда, а не режима игры', () => {
    // Профильный раунд: стойка боком — норма. Вызов присутствия с ориентацией
    // режима («фронт») отверг бы ВСЕ кадры такого раунда причиной `orientation`.
    const run = makeRun(opts({ tier: 3, rnd: picks('arrow', 3) }))
    const r1 = run.state.round!
    expect(r1.spec.orientation).toBe('profile')

    const s = drive(run, START, r1.endT + PERIOD, right)

    expect(s.outcomes[0].spec.id).toBe('arrow')
    expect(s.outcomes[0].kind).toBe('hit')
    expect(s.outcomes[0].verdict!.valid).toBeGreaterThanOrEqual(CONFIG.judge.minValid)
  })

  test('в профильном раунде фронтальная стойка — отказ', () => {
    const run = makeRun(opts({ tier: 3, rnd: picks('arrow', 3) }))
    const r1 = run.state.round!
    const frontal: How = () => ({ orientation: 'front' })

    const s = drive(run, START, r1.endT + PERIOD, frontal)

    expect(s.outcomes[0].kind).toBe('skip')
    expect(s.score).toBe(0)
  })

  test('во фронтальном раунде профильная стойка — отказ', () => {
    const run = makeRun(opts({ tier: 1 }))
    const r1 = run.state.round!
    expect(r1.spec.orientation).toBe('front')
    const sideways: How = () => ({ orientation: 'profile' })

    const s = drive(run, START, r1.endT + PERIOD, sideways)

    expect(s.outcomes[0].kind).toBe('skip')
    expect(s.score).toBe(0)
  })
})

test('часов внутри автоматов нет вовсе', () => {
  const clocks = /performance\s*\.\s*now|Date\s*\.\s*now|new\s+Date|setTimeout|setInterval/
  for (const file of ['round.ts', 'run.ts']) {
    // Комментарии снимаются: оба файла НАЗЫВАЮТ `performance.now()` как
    // дефект, и сторож, спотыкающийся об это, ловил бы собственный разбор.
    const src = readFileSync(join(__dirname, '../../src/core', file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '')
    expect(clocks.test(src), file).toBe(false)
  }
})
