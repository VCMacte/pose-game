/**
 * Сквозной забег на синтетическом игроке: ядро, журнал и replay вместе.
 *
 * Это единственный тест, который проходит весь путь — кадры синтетического
 * игрока, присутствие, окно судейства, счёт, журнал, — и потом ПЕРЕСЧИТЫВАЕТ
 * тот же журнал тем же ядром. Расхождение здесь означает, что либо забег
 * пишет в журнал не то, по чему судил, либо replay читает не то, что записано;
 * и то и другое делает журнал бесполезным именно там, где он единственный
 * аппарат — на штативе, без консоли.
 *
 * Камеры здесь нет и быть не может: синтетический игрок ровно для этого и
 * написан, а его самомаркировка обязательна, чтобы ни одно число отсюда не
 * было потом принято за живой замер.
 *
 * Разбор: `docs/log-and-storage.md`, `docs/judging.md`.
 */
import { describe, expect, test } from 'vitest'

import { CONFIG, strictness } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { makeCalibrator } from '../../src/core/calibration'
import { makeRun } from '../../src/core/run'
import type { RunState } from '../../src/core/run'
import { POSES } from '../../src/core/poses'
import { stick } from '../../src/fake/stick'
import { fakeSource } from '../../src/fake/player'
import type { FakeScript, FakeMarker } from '../../src/fake/player'
import type { Frame } from '../../src/core/types'
import { replay } from '../../tools/lib/replay'
import { report } from '../../tools/lib/report'

const ASPECT = 16 / 9
const HZ = 11
const DURATION_S = 90

/**
 * Предел кадров у потребителя. Забег на 90 игровых секунд при 11 Гц — около
 * 1000 кадров; потолок выше с запасом на паузы, которые игровое время не
 * двигают, и ниже бесконечности, которой источник и является.
 */
const MAX_FRAMES = 4000

/** Калибровка из нейтральной стойки того же синтетического скелета. */
function calibrate() {
  const c = makeCalibrator(ASPECT, 'fake-cam')
  for (let t = 0; t <= CONFIG.calibration.durationMs + 1000; t += 50) {
    const g = geometry(stick({ aspect: ASPECT }), ASPECT)
    if (g) c.push(g, t)
  }
  const got = c.done(Date.now())
  if ('need' in got) throw new Error(`калибровка не вышла: ${got.need}`)
  return got
}

const CAL = calibrate()

type Row = Record<string, unknown>

/**
 * Проигрывает забег на синтетическом игроке и собирает журнал.
 *
 * Строки журнала пишутся ЗДЕСЬ, а не адаптером: IndexedDB в node нет, а
 * проверяется состав журнала и его согласие с приговорами — не хранилище.
 * Состав при этом ровно тот, что пишет оболочка, и это то, что сверяет replay.
 */
async function playRun(opts: {
  /** Сценарий синтетического игрока, либо `follow` — игрок, повторяющий позу. */
  script?: FakeScript
  tier: 1 | 2 | 3
}): Promise<{ state: RunState; log: Row[] }> {
  const marks: FakeMarker[] = []
  /*
   * Темп подменён: забег на 90 ИГРОВЫХ секунд при настоящих паузах шёл бы те
   * же 90 секунд, и единственная проверка, проходящая весь путь целиком, не
   * могла бы входить в обычный прогон. Отметка `t` внутри кадра от подмены не
   * зависит — окно судейства видит те же 7±1 кадр.
   */
  const src = opts.script ? fakeSource(opts.script, HZ, (m) => marks.push(m), async () => {}) : null

  const log: Row[] = []
  // Самомаркировка приходит синхронно, при создании источника, и попадает в
  // журнал первой: забытая пометка означала бы синтетические числа,
  // неотличимые от живых.
  for (const m of marks) log.push({ t: 0, type: m.type, ...m.data })

  const strict = strictness('normal')
  log.push({
    t: 0,
    type: 'run.start',
    tier: opts.tier,
    durationS: DURATION_S,
    strict,
    latencyMs: 0,
    source: 'fake',
  })
  log.push({ t: 0, type: 'calib.done', ...CAL })

  const run = makeRun({
    startT: 0,
    durationSec: DURATION_S,
    tier: opts.tier,
    toggles: {},
    rnd: makeRnd(1),
    cal: CAL,
    strict,
    // Сдвиг на задержку ноль: синтетический игрок встаёт в позу мгновенно, и
    // ненулевой сдвиг сдвигал бы окно в кадры, которых у него нет.
    timings: { previewMs: 2000, wallMs: 2000, latencyMs: 0, verdictMs: 800 },
  })

  /** Уже записанные раунды: по ним видно, какой исход только что добавился. */
  let logged = 0
  /** Строки скелета текущего раунда — всплеск уходит в журнал при приговоре. */
  let lines: Array<{ t: number; v: number[] }> = []
  /** Чей раунд уже озаглавлен превью. Опознаётся по НАЧАЛУ раунда, не по позе:
      одна и та же поза вернётся через несколько раундов. */
  let previewedAt: number | null = null
  /** Причина паузы, уже записанная: иначе строка пишется на каждый кадр. */
  let pausedWhy: string | null = null

  let state = run.state
  const iter = src ? src[Symbol.asyncIterator]() : null

  /*
   * ПОТОЛОК кадров, и он не формальность. Игровое время забега на паузе СТОИТ,
   * а сценарий `leave-frame` уводит игрока навсегда — такой забег не кончается
   * никогда и ждёт взрослого. Источник бесконечен, как трек настоящей камеры,
   * так что потребитель обязан иметь свой предел.
   */
  for (let i = 0; i < MAX_FRAMES; i++) {
    if (state.phase === 'finished') break

    let frame: Frame
    if (iter) {
      const next = await iter.next()
      if (next.done) break
      frame = next.value
    } else {
      /*
       * Игрок, ПОВТОРЯЮЩИЙ позу раунда — то есть ребёнок, делающий всё верно.
       * Сценарии `fakeSource` для этого не годятся: `hit` всегда изображает
       * «Звезду», а выбор поз не повторяет предыдущую, так что «все раунды
       * зачтены» через фиксированное тело недостижимо в принципе.
       */
      const t = i * (1000 / HZ)
      const pose = state.pose
      /*
       * Ориентация берётся из `orientation` ПОЗЫ, а не из `requires`: в
       * `PoseSpec` это отдельное поле, и в `requires` его нет. Фигура позы
       * (`core/figure.ts`) собирает кинематику точно так же — `requires` плюс
       * `orientation` плюс сторона взгляда. Без этого «верный» игрок стоял бы
       * фронтом в профильных раундах, присутствие отказывало бы по
       * `orientation`, и раунд выходил бы НЕСУДИМЫМ — что и случилось: ровно
       * три раунда из девятнадцати, по числу профильных поз ступени 3.
       */
      frame = {
        t,
        lm: stick({
          ...(pose?.requires ?? {}),
          ...(pose ? { orientation: pose.orientation } : {}),
          facing: 'right',
          aspect: ASPECT,
        }),
      }
    }

    state = run.tick(frame.t, [frame])

    /*
     * Приговоры сливаются В ЖУРНАЛ РАНЬШЕ превью следующего раунда, и порядок
     * здесь — не вкус. К моменту появления исхода раунда N забег уже перешёл к
     * раунду N+1, и превью N+1, записанное первым, уехало бы в журнал ПЕРЕД
     * `round.wall` раунда N. Replay читает журнал по порядку и судил бы данные
     * раунда N позой раунда N+1 — то есть расходился бы с игрой на каждом
     * раунде, не имея при этом ни одного дефекта в судействе.
     */
    // Новые приговоры: по одному на раунд, в порядке их появления.
    while (logged < state.outcomes.length) {
      const o = state.outcomes[logged++]
      log.push({ t: o.contactT, type: 'round.wall', travelMs: 2000, latencyShiftMs: 0 })
      log.push({ t: o.contactT, type: 'raw', why: 'judge', lines })
      lines = []

      if (o.verdict === null) {
        log.push({ t: o.contactT + 1, type: 'round.skip', why: o.why ?? 'pause', valid: 0 })
        continue
      }
      log.push({
        t: o.contactT + 1,
        type: 'round.judge',
        poseId: o.spec.id,
        matched: o.verdict.matched,
        frames: o.verdict.frames,
        valid: o.verdict.valid,
        ratio: o.verdict.ratio,
        perAxis: { worst: null, axes: {} },
        score: scoreOf(o.kind),
        total: state.score,
      })
    }

    // Превью нового раунда: пишется один раз на раунд, уже после исходов.
    if (state.round && state.round.startT !== previewedAt && state.pose) {
      previewedAt = state.round.startT
      log.push({
        t: frame.t,
        type: 'round.preview',
        poseId: state.pose.id,
        mirror: state.pose.mirror,
        orientation: state.pose.orientation,
        requires: state.pose.requires,
        tier: state.pose.tier,
      })
    }

    // Строки скелета копятся всегда: какие из них попадут в окно, решает судья.
    if (frame.lm) {
      lines.push({ t: Math.round(frame.t), v: Array.from(frame.lm, (x) => Math.round(x * 1000) / 1000) })
    }

    // Пауза пишется на ПЕРЕХОДЕ, а не на каждом кадре: иначе одна потеря
    // игрока даёт в журнале тысячу одинаковых строк и съедает его потолок.
    if (state.pauseWhy !== null && state.pauseWhy !== pausedWhy) {
      pausedWhy = state.pauseWhy
      log.push({ t: frame.t, type: 'pause', why: state.pauseWhy })
    }
    if (state.pauseWhy === null) pausedWhy = null
    // Ядро само с паузы не уходит: оболочка обязана подтвердить возврат.
    if (state.pauseWhy !== null && state.canResume) state = run.resume(frame.t)

  }

  const kinds = state.outcomes.map((o) => o.kind)
  log.push({
    t: state.elapsedMs,
    type: 'run.finish',
    score: state.score,
    rounds: state.outcomes.length,
    hits: kinds.filter((k) => k === 'hit').length,
    misses: kinds.filter((k) => k === 'miss').length,
    skipped: kinds.filter((k) => k === 'skip').length,
    tier: opts.tier,
    durationS: DURATION_S,
  })

  return { state, log }
}

const scoreOf = (kind: 'hit' | 'miss' | 'skip'): number =>
  kind === 'hit' ? CONFIG.score.hit : kind === 'miss' ? CONFIG.score.miss : 0

/** Детерминированный генератор: чистота забега держится на нём. */
function makeRnd(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x / 0x7fffffff
  }
}

const dumpOf = (log: Row[]): unknown => ({ sessions: [{ id: 1, log }] })

describe('сквозной забег на синтетическом игроке', () => {
  test('игрок повторяет позу верно: все раунды зачтены, счёт равен 3 × раундов', async () => {
    // Happy path целиком: кадры → присутствие → окно судейства → счёт → журнал.
    const { state } = await playRun({ tier: 3 })
    expect(state.phase).toBe('finished')
    expect(state.outcomes.length).toBeGreaterThan(0)
    expect(state.outcomes.map((o) => o.kind)).toEqual(state.outcomes.map(() => 'hit'))
    expect(state.score).toBe(state.outcomes.length * CONFIG.score.hit)
  })

  test('сценарий leave-frame: ни одного зачтённого раунда, счёт 0', async () => {
    // Ребёнок ушёл из кадра. Приговор не вправе наказывать за то, чего игра не
    // видела: несудимый раунд вместо минуса — худший класс дефекта здесь это
    // ребёнок, не понимающий, почему проиграл.
    const { state } = await playRun({ script: 'leave-frame', tier: 1 })
    expect(state.outcomes.some((o) => o.kind === 'hit')).toBe(false)
    expect(state.outcomes.some((o) => o.kind === 'miss')).toBe(false)
    expect(state.score).toBe(0)
  })

  test('ушедший навсегда игрок оставляет забег НА ПАУЗЕ, а не доигрывает его', async () => {
    // Игровое время на паузе стоит, значит такой забег ждёт взрослого. Это
    // свойство, а не дефект, — но знать его обязан всякий, кто потребляет
    // забег: бесконечный источник требует предела у потребителя.
    const { state } = await playRun({ script: 'leave-frame', tier: 1 })
    expect(state.phase).toBe('paused')
    expect(state.pauseWhy).not.toBeNull()
  })

  test('сценарий miss-one-axis: раунды провалены, счёт УПИРАЕТСЯ в ноль', async () => {
    // Промах ровно по одной оси от «Звезды» — на фронтальных позах ступени 1
    // это настоящий промах: ребёнок виден, поза не та.
    const { state } = await playRun({ script: 'miss-one-axis', tier: 1 })
    expect(state.outcomes.length).toBeGreaterThan(0)
    expect(state.outcomes.some((o) => o.kind === 'hit')).toBe(false)
    expect(state.outcomes.some((o) => o.kind === 'miss')).toBe(true)
    expect(state.score).toBe(0)
  })

  test('счёт не уходит в минус ни на каком сценарии', async () => {
    for (const script of ['hit', 'miss-one-axis', 'leave-frame', 'still', 'turn-profile', 'subject-swap'] as const) {
      const { state } = await playRun({ script, tier: 1 })
      expect(state.score).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('журнал забега', () => {
  test('на каждый раунд есть preview, wall и приговор; run.finish один', async () => {
    const { state, log } = await playRun({ tier: 3 })
    const count = (type: string): number => log.filter((e) => e.type === type).length

    expect(count('round.preview')).toBe(state.outcomes.length)
    expect(count('round.wall')).toBe(state.outcomes.length)
    expect(count('round.judge') + count('round.skip')).toBe(state.outcomes.length)
    expect(count('run.finish')).toBe(1)
  })

  test('синтетический источник ПОМЕЧЕН в журнале', async () => {
    // Журнал — единственный вход калибровки порогов, и забытая пометка
    // означает синтетические числа, сидящие в нём неотличимо от живых. Такая
    // калибровка хуже отсутствия: она выглядит доказательством.
    const { log } = await playRun({ script: 'hit', tier: 1 })
    expect(log.some((e) => e.type === 'fake.source')).toBe(true)
    expect(log.find((e) => e.type === 'run.start')?.source).toBe('fake')
    expect(report(dumpOf(log)).synthetic).toBe(true)
  })

  test('счёт в журнале совпадает со счётом забега', async () => {
    const { state, log } = await playRun({ tier: 3 })
    expect(log.find((e) => e.type === 'run.finish')?.score).toBe(state.score)
  })

  test('сводка по журналу согласна с исходами забега', async () => {
    const { state, log } = await playRun({ tier: 3 })
    const r = report(dumpOf(log))
    expect(r.verdicts.hit).toBe(state.outcomes.filter((o) => o.kind === 'hit').length)
    expect(r.runs).toBe(1)
  })

  test('одна потеря игрока даёт ОДНУ строку паузы, а не тысячу', async () => {
    // Журнал с паузой на каждый кадр упёрся бы в потолок за один забег.
    const { log } = await playRun({ script: 'leave-frame', tier: 1 })
    expect(log.filter((e) => e.type === 'pause').length).toBeLessThan(5)
  })
})

describe('replay сверяется с живыми приговорами', () => {
  test('replay того же журнала НЕ расходится с живыми приговорами', async () => {
    // Главная проверка проекта: разбор спорного раунда обязан давать то же,
    // что дала игра, иначе журнал врёт уверенно.
    const { log } = await playRun({ tier: 3 })
    const r = replay(dumpOf(log))
    expect(r.rounds.length).toBeGreaterThan(0)
    expect(r.rounds.length - r.unreplayable).toBeGreaterThan(0)
    expect(r.mismatches).toBe(0)
  })

  test('то же на провальном сценарии: расхождений нет и там', async () => {
    const { log } = await playRun({ script: 'miss-one-axis', tier: 1 })
    expect(replay(dumpOf(log)).mismatches).toBe(0)
  })

  test('подмена приговора в журнале replay-ем ЛОВИТСЯ', async () => {
    // Сторож, который не умеет сказать «разошлось», выглядит зелёным тестом.
    const { log } = await playRun({ tier: 3 })
    const judged = log.filter((e) => e.type === 'round.judge')
    expect(judged.length).toBeGreaterThan(0)
    judged[0].score = CONFIG.score.miss
    expect(replay(dumpOf(log)).mismatches).toBe(1)
  })
})
