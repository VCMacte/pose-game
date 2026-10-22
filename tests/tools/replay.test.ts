/**
 * Инструменты разбора журнала: replay через то же ядро и сводка.
 *
 * **Replay работает только потому, что ядро чистое.** Это и есть причина, по
 * которой граница слоёв сторожится тестом: разбор спорного раунда не должен
 * требовать переигрывания с ребёнком.
 *
 * Разбор: `docs/log-and-storage.md`.
 */
import { describe, expect, test } from 'vitest'

import { report } from '../../tools/lib/report'
import { replay } from '../../tools/lib/replay'
import { CONFIG, strictness } from '../../src/core/config'
import { geometry } from '../../src/core/geometry'
import { makeCalibrator } from '../../src/core/calibration'
import { stick } from '../../src/fake/stick'
import { POSES } from '../../src/core/poses'
import { LANDMARK_COUNT, LANDMARK_STRIDE } from '../../src/core/landmarks'
import type { Calibration } from '../../src/core/types'

const ASPECT = 16 / 9

/** Калибровка из нейтральной стойки того же синтетического скелета. */
function calibrate(): Calibration {
  const c = makeCalibrator(ASPECT, 'test-cam')
  // Стадия — 5 секунд и не меньше 20 отсчётов (`CONFIG.calibration`): короче
  // срока калибратор честно отвечает `need: 'more'`.
  const span = CONFIG.calibration.durationMs + 1000
  for (let t = 0; t <= span; t += 50) {
    const g = geometry(stick({ aspect: ASPECT }), ASPECT)
    if (g) c.push(g, t)
  }
  const got = c.done(Date.now())
  if ('need' in got) throw new Error(`калибровка не вышла: ${got.need}`)
  return got
}

const CAL = calibrate()

/** Строка скелета дампа: `{ t, v }`, как её пишет `rawPush`. */
function line(t: number, lm: Float32Array): { t: number; v: number[] } {
  return { t, v: Array.from(lm, (x) => Math.round(x * 1000) / 1000) }
}

/**
 * Дамп одного раунда: превью, стена, строки скелета в позе и приговор.
 *
 * `judge` подставляется снаружи: именно расхождение между записанным
 * приговором и пересчитанным и есть то, что replay ищет.
 */
function dumpOf(opts: {
  pose: (typeof POSES)[number]
  lines: Array<{ t: number; v: number[] }>
  contactT: number
  judge: { matched: number; frames: number; valid: number; ratio: number; score: number; total: number }
}) {
  return {
    exportedAt: new Date().toISOString(),
    limits: {},
    sessions: [
      {
        id: 1,
        log: [
          {
            t: 0,
            type: 'run.start',
            tier: opts.pose.tier,
            durationS: 90,
            strict: strictness('normal'),
            latencyMs: 0,
            source: 'fake',
          },
          { t: 0, type: 'calib.done', ...CAL, aspect: ASPECT },
          {
            t: 10,
            type: 'round.preview',
            poseId: opts.pose.id,
            mirror: opts.pose.mirror,
            orientation: opts.pose.orientation,
            requires: opts.pose.requires,
            tier: opts.pose.tier,
          },
          { t: opts.contactT, type: 'round.wall', travelMs: 2000, latencyShiftMs: 0 },
          { t: opts.contactT, type: 'raw', why: 'judge', lines: opts.lines },
          { t: opts.contactT + 10, type: 'round.judge', poseId: opts.pose.id, ...opts.judge },
          {
            t: opts.contactT + 20,
            type: 'run.finish',
            score: opts.judge.total,
            rounds: 1,
            hits: opts.judge.score > 0 ? 1 : 0,
            misses: opts.judge.score < 0 ? 1 : 0,
            skipped: 0,
            tier: opts.pose.tier,
            durationS: 90,
          },
        ],
      },
    ],
  }
}

/** Кадры в позе, покрывающие окно судейства перед касанием. */
function framesInPose(pose: (typeof POSES)[number], contactT: number) {
  const lm = stick({ ...pose.requires, aspect: ASPECT })
  const lines = []
  // Окно — `[contact − 600, contact]`; 11 Гц даёт 7±1 кадр.
  for (let t = contactT - CONFIG.judge.windowMs + 50; t <= contactT; t += 90) {
    lines.push(line(t, lm))
  }
  return lines
}

const POSE = POSES.find((p) => p.tier === 1)!

describe('replay', () => {
  test('гонит записанные строки через ТО ЖЕ ядро', () => {
    // Приговор, пересчитанный из строк скелета, совпадает с записанным тогда.
    const contactT = 2000
    const lines = framesInPose(POSE, contactT)
    const d = dumpOf({
      pose: POSE,
      lines,
      contactT,
      judge: { matched: lines.length, frames: lines.length, valid: lines.length, ratio: 1, score: 3, total: 3 },
    })
    const r = replay(d)
    expect(r.rounds.length).toBe(1)
    expect(r.rounds[0].recorded.kind).toBe('hit')
    expect(r.rounds[0].replayed!.kind).toBe('hit')
    expect(r.mismatches).toBe(0)
  })

  test('расхождение приговора ВИДНО в выводе', () => {
    // Подменённый `round.judge`: записано «провал», ядро считает «успех».
    // Это и есть сигнал регрессии судейства, ради которого replay существует.
    const contactT = 2000
    const lines = framesInPose(POSE, contactT)
    const d = dumpOf({
      pose: POSE,
      lines,
      contactT,
      judge: { matched: 0, frames: lines.length, valid: lines.length, ratio: 0, score: -2, total: 0 },
    })
    const r = replay(d)
    expect(r.mismatches).toBe(1)
    expect(r.rounds[0].recorded.kind).toBe('miss')
    expect(r.rounds[0].replayed!.kind).toBe('hit')
    expect(r.rounds[0].match).toBe(false)
  })

  test('битые строки скелета ПРОПУСКАЮТСЯ, а не роняют прогон', () => {
    // Запись идёт всплесками и дырявая по определению.
    const contactT = 2000
    const good = framesInPose(POSE, contactT)
    const broken = [
      { t: contactT - 500, v: [1, 2, 3] },
      { t: contactT - 400, v: null as unknown as number[] },
      { t: Number.NaN, v: good[0].v },
      { t: contactT - 300 },
      null,
      'строка',
    ]
    const d = dumpOf({
      pose: POSE,
      lines: [...broken, ...good] as Array<{ t: number; v: number[] }>,
      contactT,
      judge: { matched: good.length, frames: good.length, valid: good.length, ratio: 1, score: 3, total: 3 },
    })
    const r = replay(d)
    expect(r.rounds[0].replayed!.kind).toBe('hit')
    expect(r.skippedLines).toBe(broken.length)
  })

  test('строка неверной ДЛИНЫ — битая, а не укороченный скелет', () => {
    // Судить по дырявому скелету нельзя: `packLandmarks` на этом и отказывает.
    const contactT = 2000
    const short = Array.from({ length: (LANDMARK_COUNT - 1) * LANDMARK_STRIDE }, () => 0.5)
    const d = dumpOf({
      pose: POSE,
      lines: [{ t: contactT - 100, v: short }],
      contactT,
      judge: { matched: 0, frames: 0, valid: 0, ratio: 0, score: 0, total: 0 },
    })
    const r = replay(d)
    expect(r.skippedLines).toBe(1)
  })

  test('нет строк скелета — раунд не пересчитывается, а НЕ считается расхождением', () => {
    // Всплески ограничены бюджетом забега: у большинства раундов строк нет
    // вовсе, и называть это расхождением значило бы тонуть в ложной тревоге.
    const contactT = 2000
    const d = dumpOf({
      pose: POSE,
      lines: [],
      contactT,
      judge: { matched: 5, frames: 7, valid: 7, ratio: 0.71, score: 3, total: 3 },
    })
    const r = replay(d)
    expect(r.rounds[0].replayed).toBeNull()
    expect(r.mismatches).toBe(0)
    expect(r.unreplayable).toBe(1)
  })

  test('строки ЕСТЬ у соседнего раунда, а у этого нет — он тоже не пересчитывается', () => {
    /*
     * Дефект из разбора журнала 22.10.2026: нехватка строк проверялась по ВСЕЙ
     * сессии, а не по окну раунда. Всплески идут только на интересных
     * моментах, так что в сессии строки есть почти всегда, — и зачтённые
     * раунды, у которых своих строк нет, пересчитывались по ПУСТОМУ окну,
     * давали `skip (0/0)` и попадали в расхождения. Четыре из восьми
     * «расхождений» того журнала были именно этим, а счётчик «без строк
     * скелета» показывал ноль.
     */
    const first = 2000
    const second = 6000
    const d = dumpOf({
      pose: POSE,
      lines: framesInPose(POSE, second),
      contactT: second,
      judge: { matched: 7, frames: 7, valid: 7, ratio: 1, score: 3, total: 3 },
    })
    // Раунд ПЕРЕД тем, у которого строки: своих строк у него нет вовсе.
    const log = d.sessions[0].log
    const head = log.findIndex((e) => e.type === 'round.preview')
    log.splice(
      head,
      0,
      {
        t: 10,
        type: 'round.preview',
        poseId: POSE.id,
        mirror: POSE.mirror,
        orientation: POSE.orientation,
        requires: POSE.requires,
        tier: POSE.tier,
      },
      { t: first, type: 'round.wall', travelMs: 2000, latencyShiftMs: 0 },
      {
        t: first + 10,
        type: 'round.judge',
        poseId: POSE.id,
        matched: 7,
        frames: 7,
        valid: 7,
        ratio: 1,
        score: 3,
        total: 3,
      },
    )

    const r = replay(d)
    expect(r.rounds.length).toBe(2)
    expect(r.rounds[0].replayed).toBeNull()
    expect(r.rounds[0].why).toBe('no-lines')
    expect(r.unreplayable).toBe(1)
    expect(r.mismatches).toBe(0)
  })

  test('судит по отношению сторон ТОГО раунда, а не только калибровочному', () => {
    /*
     * Живой забег 22.10.2026 судил на 0.5625 (камера отдала вертикальный кадр
     * 360×640), а в калибровке осталось 1.7778. Replay брал калибровочное на
     * все раунды и потому выносил СВОИ приговоры — расхождения оказывались
     * артефактом инструмента, а не находкой. Поэтому забег пишет отношение
     * сторон в приговор, а replay берёт записанное.
     *
     * Видно это по приговору: тот же скелет при другом отношении сторон даёт
     * другие углы и другую ориентацию, то есть другой исход. Запись в журнале
     * и есть единственный способ узнать, каким числом судили.
     */
    const contactT = 2000
    const lines = framesInPose(POSE, contactT)
    const judge = { matched: lines.length, frames: lines.length, valid: lines.length, ratio: 1, score: 3, total: 3 }

    // Поля `aspect` нет — замена на калибровочное, и это зачтённый раунд.
    const byCal = replay(dumpOf({ pose: POSE, lines, contactT, judge }))
    expect(byCal.rounds[0].replayed!.kind).toBe('hit')

    // Поле есть и говорит «кадр был вертикальный» — судить обязано по нему.
    const d = dumpOf({ pose: POSE, lines, contactT, judge })
    const row = d.sessions[0].log.find((e) => e.type === 'round.judge')!
    ;(row as Record<string, unknown>).aspect = 0.5625
    const byRound = replay(d)
    expect(byRound.rounds[0].replayed!.kind).not.toBe('hit')
  })

  test('нет калибровки в дампе — отказ, а не судейство по выдуманной', () => {
    // Без калибровки геометрия судится не тем масштабом, и расхождения были бы
    // артефактом инструмента, а не находкой.
    const contactT = 2000
    const d = dumpOf({
      pose: POSE,
      lines: framesInPose(POSE, contactT),
      contactT,
      judge: { matched: 7, frames: 7, valid: 7, ratio: 1, score: 3, total: 3 },
    })
    d.sessions[0].log = d.sessions[0].log.filter((e) => e.type !== 'calib.done')
    const r = replay(d)
    expect(r.rounds[0].replayed).toBeNull()
    expect(r.unreplayable).toBe(1)
  })

  test('пустой дамп — пустой ответ, а не исключение', () => {
    expect(replay({ sessions: [] }).rounds).toEqual([])
    expect(replay({}).rounds).toEqual([])
    expect(replay(null).rounds).toEqual([])
  })
})

describe('сводка по журналу', () => {
  /** Журнал забега с заданными исходами раундов. */
  const runWith = (outcomes: Array<'hit' | 'miss' | 'skip'>, pauses: string[] = []) => {
    const log: Array<Record<string, unknown>> = [
      { t: 0, type: 'run.start', tier: 2, durationS: 90, strict: 1, latencyMs: 250, source: 'fake' },
    ]
    let t = 10
    let total = 0
    outcomes.forEach((o, i) => {
      const pose = POSES[i % POSES.length]
      log.push({ t: t++, type: 'round.preview', poseId: pose.id, tier: pose.tier })
      if (o === 'skip') {
        log.push({ t: t++, type: 'round.skip', why: 'lost', valid: 1 })
        return
      }
      const score = o === 'hit' ? 3 : -2
      total = Math.max(0, total + score)
      log.push({
        t: t++,
        type: 'round.judge',
        poseId: pose.id,
        matched: o === 'hit' ? 7 : 1,
        frames: 7,
        valid: 7,
        ratio: o === 'hit' ? 1 : 0.14,
        score,
        total,
        perAxis: { axes: { arms: { want: 'up', got: 'down', outcome: o === 'hit' ? 'match' : 'mismatch' } }, worst: 'arms' },
      })
    })
    for (const why of pauses) log.push({ t: t++, type: 'pause', why })
    log.push({ t: t++, type: 'health', fps: 39, inferP50: 18, inferP95: 40, drops: 2, valid: 10, lost: 1 })
    log.push({
      t: t++,
      type: 'run.finish',
      score: total,
      rounds: outcomes.length,
      hits: outcomes.filter((o) => o === 'hit').length,
      misses: outcomes.filter((o) => o === 'miss').length,
      skipped: outcomes.filter((o) => o === 'skip').length,
      tier: 2,
      durationS: 90,
    })
    return { sessions: [{ id: 1, log }] }
  }

  test('считает hit/miss/skip', () => {
    const r = report(runWith(['hit', 'hit', 'miss', 'skip']))
    expect(r.verdicts).toEqual({ hit: 2, miss: 1, skip: 1 })
  })

  test('считает паузы ПО ПРИЧИНАМ, а не общим числом', () => {
    // Общее число паузы не объясняет: «не видно» и «второй человек в кадре» —
    // разные беды и лечатся по-разному.
    const r = report(runWith(['hit'], ['lowvis', 'jump', 'lowvis']))
    expect(r.pauses).toEqual({ lowvis: 2, jump: 1 })
  })

  test('считает промахи ПО ОСЯМ', () => {
    const r = report(runWith(['miss', 'miss', 'hit']))
    expect(r.axisMisses.arms).toBe(2)
  })

  test('называет позу, которая чаще всего НЕ даётся', () => {
    // Это главный практический вопрос к журналу: какую позу убрать или
    // переразметить.
    const log = runWith([])
    const pose = POSES[0]
    for (let i = 0; i < 3; i++) {
      log.sessions[0].log.push({
        t: 100 + i,
        type: 'round.judge',
        poseId: pose.id,
        matched: 0,
        frames: 7,
        valid: 7,
        ratio: 0,
        score: -2,
        total: 0,
      })
    }
    const r = report(log)
    expect(r.hardestPose?.poseId).toBe(pose.id)
    expect(r.hardestPose?.misses).toBe(3)
  })

  test('частота и задержки инференса берутся из health', () => {
    const r = report(runWith(['hit']))
    expect(r.health.fps).toBeGreaterThan(0)
    expect(r.health.inferP50).toBe(18)
  })

  test('синтетический забег ПОМЕЧЕН в сводке', () => {
    // Журнал — единственный вход калибровки порогов, и синтетические числа,
    // принятые за живые, хуже отсутствия калибровки: они выглядят
    // доказательством.
    const r = report(runWith(['hit']))
    expect(r.synthetic).toBe(true)
  })

  test('пустой журнал — пустая сводка, а не исключение', () => {
    const r = report({ sessions: [] })
    expect(r.verdicts).toEqual({ hit: 0, miss: 0, skip: 0 })
    expect(r.hardestPose).toBeNull()
  })

  test('неизвестные события не роняют сводку', () => {
    // Журнал переживает обновления игры: событие из будущей версии — не повод
    // отказаться разобрать всё остальное.
    const d = runWith(['hit'])
    d.sessions[0].log.push({ t: 999, type: 'что-то.новое', поле: 1 })
    expect(() => report(d)).not.toThrow()
  })
})
