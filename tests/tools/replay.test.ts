/**
 * Инструменты разбора журнала: replay через то же ядро и сводка.
 *
 * **Replay работает только потому, что ядро чистое.** Это и есть причина, по
 * которой граница слоёв сторожится тестом: разбор спорного раунда не должен
 * требовать переигрывания с ребёнком.
 *
 * Разбор: `docs/log-and-storage.md`.
 */
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import { report } from '../../tools/lib/report'
import { printReport } from '../../tools/lib/cli'
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
    expect(r.health.inferMedian).toBe(18)
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

  test('склеенный повтор весит столько, сколько событий в нём', () => {
    /*
     * Журнал сворачивает одинаковые подряд события в одну запись со счётчиком
     * `_n`: одна запись может означать до пятисот событий. Счёт по записям
     * давал бы «пауза одна» там, где их было двести. У `run-game` на этом
     * один журнал печатал несогласованные между собой числа: отбросы считались
     * с весом, а окна — без.
     */
    const d = runWith(['hit'], [])
    d.sessions[0].log.push({ t: 900, type: 'pause', why: 'lowvis', _n: 5 })
    const r = report(d)
    expect(r.pauses.lowvis).toBe(5)
  })

  test('инференс: p50 — медиана окон, p95 — ХУДШЕЕ окно', () => {
    /*
     * Урок `run-game`, записанный у них дословно: квантили в `health`
     * посчитаны ВНУТРИ окна, и усреднять их нельзя — среднее квантилей не
     * квантиль. Медиана девяноста пятых процентилей скрывает ровно то, ради
     * чего p95 и смотрят: худшее окно забега.
     */
    const d = runWith(['hit'], [])
    const log = d.sessions[0].log
    const at = log.findIndex((e) => e.type === 'health')
    log.splice(
      at,
      1,
      { t: 800, type: 'health', fps: 40, inferP50: 20, inferP95: 44, drops: 0, valid: 10, lost: 0 },
      { t: 801, type: 'health', fps: 38, inferP50: 22, inferP95: 300, drops: 0, valid: 10, lost: 0 },
      { t: 802, type: 'health', fps: 39, inferP50: 18, inferP95: 40, drops: 0, valid: 10, lost: 0 },
    )
    const r = report(d)
    expect(r.health.inferMedian).toBe(20)
    expect(r.health.inferWorst).toBe(300)
    expect(r.health.windows).toBe(3)
  })

  test('много окон не роняют сводку: ни переполнения стека, ни зависания', () => {
    /*
     * Найдено код-ревью, обе находки сразу. `Math.max(...массив)` на длинном
     * массиве бросает `RangeError` — инструмент умирал бы на том самом
     * журнале, который разбирают. А вес склейки `_n` приходит из ФАЙЛА, и
     * запись с `_n: 1e9` заставила бы отчёт выделять память до отказа: стор
     * свой потолок держит, но отчёт читает произвольный JSON.
     */
    const log: Array<Record<string, unknown>> = [
      { t: 0, type: 'run.start', tier: 1, durationS: 60, strict: 1, latencyMs: 250, source: 'camera' },
      { t: 1, type: 'health', fps: 50, inferP50: 20, inferP95: 44, drops: 1, valid: 10, lost: 0, _n: 1e9 },
      { t: 2, type: 'health', fps: 50, inferP50: 20, inferP95: 300, drops: 1, valid: 10, lost: 0, _n: 400 },
    ]
    const r = report({ sessions: [{ id: 1, log }] })
    expect(r.health.inferWorst).toBe(300)
    // Вес обрезан потолком склейки, а не взят из файла как есть.
    expect(r.health.windows).toBeLessThan(2000)
  })

  test('состояние «после финиша» НЕ перетекает в следующую сессию', () => {
    /*
     * Сессия — это один запуск приложения, и в файле их до двадцати. Если
     * признак «забег кончился» не сбрасывать на границе сессий, то у всех
     * следующих сессий пропадут окна калибровки — молча и тем вернее, чем
     * аккуратнее взрослый доигрывал забеги до финиша.
     */
    const first = runWith(['hit'], []).sessions[0]
    const second = {
      id: 2,
      log: [{ t: 1, type: 'health', fps: 55, inferP50: 70, inferP95: 90, drops: 0, valid: 5, lost: 0 }],
    }
    const r = report({ sessions: [first, second] })
    expect(r.sessions).toBe(2)
    expect(r.health.windows).toBe(2)
  })

  test('окна БЕЗ инференса не тянут медиану в ноль', () => {
    /*
     * Ноль в `inferP50` значит «инференса не было» — синтетический источник
     * или ещё не заведшийся конвейер, — а не «инференс занял ноль
     * миллисекунд». Ноль был бы ложью, тот же запрет, что у `measured` в
     * осях. На живом журнале 22.10 это и вышло: синтетический забег дал свои
     * окна с нулями, и сводка напечатала «медиана окон 0 мс» при живом
     * инференсе около 70.
     */
    const d = runWith(['hit'], [])
    const log = d.sessions[0].log
    const at = log.findIndex((e) => e.type === 'health')
    log.splice(
      at,
      1,
      { t: 800, type: 'health', fps: 60, inferP50: 0, inferP95: 0, drops: 0, valid: 0, lost: 0 },
      { t: 801, type: 'health', fps: 60, inferP50: 0, inferP95: 0, drops: 0, valid: 0, lost: 0 },
      { t: 802, type: 'health', fps: 50, inferP50: 70, inferP95: 105, drops: 0, valid: 10, lost: 0 },
    )
    const r = report(d)
    expect(r.health.inferMedian).toBe(70)
    expect(r.health.inferWorst).toBe(105)
    // Окна считаются ВСЕ: частота по ним честная, инференса в них просто нет.
    expect(r.health.windows).toBe(3)
  })

  test('окна ДО забега считаются: это калибровка, и инференс в ней живой', () => {
    /*
     * `run.start` пишется ПОСЛЕ калибровки, так что окна калибровки лежат
     * раньше него. Выбросить их значило бы ослепнуть ровно в том случае,
     * который интереснее всего: калибровка не сдаётся, и надо знать, с какой
     * частотой и каким инференсом она не сдавалась. Отрезается только простой
     * ПОСЛЕ финиша — то, что измерено у `run-game`.
     */
    const d = runWith(['hit'], [])
    d.sessions[0].log.unshift({ t: 1, type: 'health', fps: 55, inferP50: 70, inferP95: 90, drops: 0, valid: 5, lost: 0 })
    const r = report(d)
    expect(r.health.windows).toBe(2)
  })

  test('окна здоровья ПОСЛЕ финиша в числа забега не входят', () => {
    /*
     * Экран забега живёт и после финиша, инференс продолжается, и окна
     * простоя втекают в числа забега. У `run-game` 355 секунд простоя раздули
     * 187 окон до 535: 60 fps вместо 55 и ровность 17 мс вместо 33.
     */
    const d = runWith(['hit'], [])
    d.sessions[0].log.push({ t: 5000, type: 'health', fps: 120, inferP50: 1, inferP95: 2, drops: 0, valid: 0, lost: 0 })
    const r = report(d)
    expect(r.health.windows).toBe(1)
    expect(r.health.fps).toBe(39)
  })

  test('тревоги, уходы из видимости и ошибки ВИДНЫ в сводке', () => {
    /*
     * Всё это раньше уходило в `default` и не считалось нигде — тот же пробел,
     * что признан у `run-game`: события `visibility` разбирались только
     * глазами. Диагностика, которой нет в сводке, не существует для разбора.
     */
    const d = runWith(['hit'], [])
    const log = d.sessions[0].log
    log.push({ t: 600, type: 'alarm', text: 'Камера пропала' })
    log.push({ t: 601, type: 'alarm', text: 'Камера пропала', _n: 2 })
    log.push({ t: 602, type: 'visibility', state: 'hidden' })
    log.push({ t: 603, type: 'visibility', state: 'visible' })
    log.push({ t: 604, type: 'error', name: 'TypeError', message: 'ой' })
    log.push({ t: 605, type: 'error.promise', reason: 'ой' })
    const r = report(d)
    expect(r.alarms['Камера пропала']).toBe(3)
    expect(r.hidden).toBe(1)
    expect(r.errors).toBe(2)
  })

  test('неизвестные события не роняют сводку', () => {
    // Журнал переживает обновления игры: событие из будущей версии — не повод
    // отказаться разобрать всё остальное.
    const d = runWith(['hit'])
    d.sessions[0].log.push({ t: 999, type: 'что-то.новое', поле: 1 })
    expect(() => report(d)).not.toThrow()
  })
})

/*
 * Печать сводки проверяется ОТДЕЛЬНО от самой сводки, и это не формальность:
 * соврать можно именно подписью. Прежде отчёт считал медиану девяноста пятых
 * процентилей и печатал её как «p95» забега — числа были посчитаны, а строка
 * говорила неправду, и ни один тест этого не видел, потому что тестов на вывод
 * не было вовсе.
 */
describe('печать сводки', () => {
  /** Дамп в файле: `printReport` читает путь, а не объект. */
  function dumpFile(log: Array<Record<string, unknown>>): string {
    const file = join(tmpdir(), `pose-game-report-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), limits: {}, sessions: [{ id: 1, log }] }))
    return file
  }

  /** Собирает всё, что ушло в stdout. */
  function printed(file: string): string {
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    try {
      printReport(file)
    } finally {
      spy.mockRestore()
      rmSync(file, { force: true })
    }
    return chunks.join('')
  }

  test('инференс подписан медианой окон и худшим окном, а не «p50 / p95»', () => {
    const out = printed(
      dumpFile([
        { t: 0, type: 'run.start', tier: 1, durationS: 60, strict: 1, latencyMs: 250, source: 'camera' },
        { t: 1, type: 'health', fps: 50, inferP50: 20, inferP95: 44, drops: 0, valid: 10, lost: 0 },
        { t: 2, type: 'health', fps: 50, inferP50: 22, inferP95: 300, drops: 1, valid: 10, lost: 0 },
        { t: 3, type: 'run.finish', score: 3, rounds: 1, hits: 1, misses: 0, skipped: 0, tier: 1, durationS: 60 },
      ]),
    )
    expect(out).toContain('медиана окон')
    expect(out).toContain('худшее окно по p95 300')
    expect(out).toContain('окон 2')
    // Прежней лживой подписи в выводе больше нет.
    expect(out).not.toMatch(/инференс p50/)
  })

  test('тревоги и уходы из видимости названы в выводе', () => {
    const out = printed(
      dumpFile([
        { t: 0, type: 'run.start', tier: 1, durationS: 60, strict: 1, latencyMs: 250, source: 'camera' },
        { t: 1, type: 'alarm', text: 'Кадр камеры вертикальный — поверни телефон' },
        { t: 2, type: 'visibility', state: 'hidden' },
        { t: 3, type: 'error', name: 'TypeError', message: 'ой' },
      ]),
    )
    expect(out).toContain('тревоги на экране')
    expect(out).toContain('вертикальный')
    expect(out).toMatch(/уходила из видимости: 1/)
    expect(out).toMatch(/ошибок: 1/)
  })
})
