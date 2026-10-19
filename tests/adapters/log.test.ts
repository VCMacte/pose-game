/**
 * Журнал — единственный диагностический аппарат проекта: телефон стоит на
 * штативе, консоли нет, ребёнок не расскажет, что случилось. Поэтому тесты
 * здесь проверяют не «вызвалось ли», а то, что из журнала потом можно
 * ПРОЧИТАТЬ: конверт записи, различение исходов по осям, потолки и, главное,
 * что отказ базы не роняет игру.
 *
 * База — `fake-indexeddb`: настоящий движок IndexedDB на памяти, а не заглушка
 * с методами. Проверять потолки и курсоры на заглушке бессмысленно.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, test } from 'vitest'

import { LIMITS, eventKey, makeJournal, sameEvent } from '../../src/adapters/log/store'
import type { Journal, JournalDeps } from '../../src/adapters/log/store'
import * as ev from '../../src/adapters/log/events'
import type { PerAxisSummary } from '../../src/core/judge'

// ─────────────────────────── снаряжение ───────────────────────────

/** Своя база на каждый тест: общая переживала бы тесты друг друга. */
let dbSeq = 0
const freshDb = (): string => `pose-game-log-test-${++dbSeq}`

/** Управляемые часы: `t` конверта обязан быть проверяем, а не «примерно». */
function clock(start = 0) {
  let value = start
  return {
    now: () => value,
    set: (v: number) => {
      value = v
    },
    advance: (dt: number) => {
      value += dt
    },
  }
}

type StoredEvent = { t: number; type: string; session: number; _n?: number; _lastT?: number } & Record<
  string,
  unknown
>

/** Читает записанное НЕ через журнал: проверяем базу, а не свои же буферы. */
function readAll(dbName: string): Promise<{ events: StoredEvent[]; sessions: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) {
        // Базы может не быть вовсе: журнал не ходит в неё, пока нечего писать.
        db.close()
        resolve({ sessions: [], events: [] })
        return
      }
      const tx = db.transaction(['sessions', 'events'])
      const se = tx.objectStore('sessions').getAll()
      const evs = tx.objectStore('events').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve({
          sessions: se.result as Record<string, unknown>[],
          events: (evs.result as StoredEvent[]).sort((a, b) => a.t - b.t),
        })
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** Кладёт в базу чужую сессию с готовыми числами — так проверяются потолки. */
function seedSession(
  dbName: string,
  session: { id: number; bytes: number; events: number; exported?: boolean },
  eventCount = 1,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('events')) {
        db.createObjectStore('events', { keyPath: 'k', autoIncrement: true }).createIndex('session', 'session')
      }
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['sessions', 'events'], 'readwrite')
      tx.objectStore('sessions').put({ startedAt: new Date(session.id).toISOString(), ...session })
      for (let i = 0; i < eventCount; i++) {
        tx.objectStore('events').add({ t: i, type: 'seed', session: session.id })
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** Журнал на живой (фальшивой) базе с управляемыми часами. */
function journal(over: Partial<JournalDeps> = {}): { log: Journal; dbName: string } {
  const dbName = over.dbName ?? freshDb()
  return { log: makeJournal({ dbName, idb: indexedDB, ...over }), dbName }
}

// ─────────────────────────── конверт записи ───────────────────────────

describe('конверт записи', () => {
  test('t — целые мс от старта сессии', async () => {
    const c = clock(5000.7)
    const { log, dbName } = journal({ now: c.now, sessionId: 1 })

    log.event('session.start', { a: 1 })
    c.set(5123.6)
    log.event('pause', { why: 'none' })
    await log.flush()

    const { events } = await readAll(dbName)
    expect(events.map((e) => e.t)).toEqual([0, 123])
    expect(events[0]?.type).toBe('session.start')
    expect(events[0]?.a).toBe(1)
  })

  test('t монотонен даже при часах, пошедших назад', async () => {
    const c = clock(1000)
    const { log, dbName } = journal({ now: c.now, sessionId: 2 })

    c.set(1500)
    log.event('a')
    c.set(1200) // часы дрогнули — записи назад не едут
    log.event('b')
    await log.flush()

    const { events } = await readAll(dbName)
    expect(events.map((e) => e.t)).toEqual([500, 500])
  })

  test('t считается от старта СЕССИИ, а не забега: второй забег продолжает отсчёт', async () => {
    const c = clock(0)
    const { log, dbName } = journal({ now: c.now, sessionId: 3 })

    log.write(ev.runStart({ tier: 1, durationS: 60, strict: 1, latencyMs: 120, source: 'camera' }))
    c.advance(60_000)
    log.write(ev.runFinish({ score: 10, rounds: 5, hits: 3, misses: 1, skipped: 1, tier: 1, durationS: 60 }))
    c.advance(5_000)
    // «Ещё раз» не перезагружает страницу: сессия та же, часы не обнуляются.
    log.write(ev.runStart({ tier: 1, durationS: 60, strict: 1, latencyMs: 120, source: 'camera' }))
    await log.flush()

    const { events } = await readAll(dbName)
    expect(events.map((e) => e.t)).toEqual([0, 60_000, 65_000])
    expect(events[2]?.type).toBe('run.start')
  })
})

// ─────────────────────────── склейка ───────────────────────────

describe('склейка подряд идущих одинаковых событий', () => {
  test('счётчик растёт, первое время сохраняется, последнее — видно', async () => {
    const c = clock(0)
    const { log, dbName } = journal({ now: c.now, sessionId: 4 })

    log.event('error', { message: 'boom' })
    c.set(100)
    log.event('error', { message: 'boom' })
    c.set(250)
    log.event('error', { message: 'boom' })
    await log.flush()

    const { events } = await readAll(dbName)
    expect(events).toHaveLength(1)
    expect(events[0]?._n).toBe(3)
    expect(events[0]?.t).toBe(0)
    expect(events[0]?._lastT).toBe(250)
  })

  test('разные данные одного типа не склеиваются', async () => {
    const { log, dbName } = journal({ now: clock(0).now, sessionId: 5 })

    log.event('error', { message: 'boom' })
    log.event('error', { message: 'другой' })
    log.event('error', { message: 'boom' })
    await log.flush()

    const { events } = await readAll(dbName)
    expect(events).toHaveLength(3)
  })

  test('склейка упирается в потолок repeat', async () => {
    const { log, dbName } = journal({ now: clock(0).now, sessionId: 6 })

    for (let i = 0; i < LIMITS.repeat + 1; i++) log.event('error', { message: 'залипло' })
    await log.flush()

    const { events } = await readAll(dbName)
    // Потолок не бесконечный ровно затем, чтобы «упало 500 раз» отличалось от
    // «падает до сих пор».
    expect(events).toHaveLength(2)
    expect(events[0]?._n).toBe(LIMITS.repeat)
    expect(events[1]?._n).toBeUndefined()
  })

  test('eventKey и sameEvent считают одинаковыми записи с точностью до времени и счётчика', () => {
    const a = { t: 0, type: 'error', message: 'boom' }
    const b = { t: 900, type: 'error', message: 'boom', _n: 7, _lastT: 1000 }
    const c = { t: 0, type: 'error', message: 'иное' }
    const d = { t: 0, type: 'pause', message: 'boom' }

    expect(eventKey(a)).toBe(eventKey(b))
    expect(sameEvent(a, b)).toBe(true)
    expect(sameEvent(a, c)).toBe(false)
    expect(sameEvent(a, d)).toBe(false)
  })
})

// ─────────────────────────── потолки ───────────────────────────

describe('потолки и автоочистка', () => {
  test('LIMITS несёт объявленные числа', () => {
    expect(LIMITS.bytes).toBe(25 * 1024 * 1024)
    expect(LIMITS.sessions).toBe(20)
    expect(LIMITS.flushMs).toBe(2000)
    expect(LIMITS.repeat).toBe(500)
  })

  test('trim удаляет старейшие сессии, текущую — никогда', async () => {
    const dbName = freshDb()
    // 22 чужие сессии: нумерация id по времени, 1 — самая старая.
    for (let id = 1; id <= 22; id++) await seedSession(dbName, { id, bytes: 1000, events: 1 })

    const { log } = journal({ dbName, now: clock(0).now, sessionId: 9999 })
    log.event('session.start')
    await log.flush()

    const { sessions, events } = await readAll(dbName)
    const ids = sessions.map((s) => s.id as number).sort((a, b) => a - b)
    expect(ids).toHaveLength(LIMITS.sessions)
    expect(ids).toContain(9999)
    expect(ids).not.toContain(1)
    expect(ids).not.toContain(2)
    expect(ids).not.toContain(3)
    // События удалённых сессий ушли вместе с ними, свои — остались.
    expect(events.filter((e) => e.session === 1)).toEqual([])
    expect(events.filter((e) => e.session === 9999)).toHaveLength(1)
  })

  test('потолок 25 МБ соблюдается: толстая старая сессия вытесняется, хотя сессий мало', async () => {
    const dbName = freshDb()
    await seedSession(dbName, { id: 1, bytes: LIMITS.bytes, events: 1 })
    await seedSession(dbName, { id: 2, bytes: 1024, events: 1 })

    const { log } = journal({ dbName, now: clock(0).now, sessionId: 3 })
    log.event('session.start')
    await log.flush()

    const { sessions } = await readAll(dbName)
    const ids = sessions.map((s) => s.id as number).sort((a, b) => a - b)
    expect(ids).toEqual([2, 3])
    const total = sessions.reduce((s, x) => s + ((x.bytes as number) || 0), 0)
    expect(total).toBeLessThanOrEqual(LIMITS.bytes)
  })

  test('status отдаёт занятое место и долю потолка', async () => {
    const dbName = freshDb()
    await seedSession(dbName, { id: 1, bytes: 2048, events: 4 })

    const { log } = journal({ dbName, now: clock(0).now, sessionId: 2 })
    log.event('session.start')
    await log.flush()

    const st = await log.status()
    expect(st.broken).toBe(false)
    expect(st.sessions).toBe(2)
    expect(st.events).toBe(5)
    expect(st.bytes).toBeGreaterThan(2048)
    expect(st.share).toBeCloseTo(st.bytes / LIMITS.bytes, 10)
  })

  test('sweepExported помечает чужие сессии и удаляет помеченные в прошлый раз', async () => {
    const dbName = freshDb()
    await seedSession(dbName, { id: 1, bytes: 10, events: 1 })
    const { log } = journal({ dbName, now: clock(0).now, sessionId: 2 })
    log.event('session.start')
    await log.flush()

    const first = await log.sweepExported()
    expect(first).toEqual({ sessions: 0, marked: 1, bytes: 0 })
    expect((await readAll(dbName)).sessions.map((s) => s.id)).toEqual(expect.arrayContaining([1, 2]))

    const second = await log.sweepExported()
    expect(second.sessions).toBe(1)
    const after = await readAll(dbName)
    expect(after.sessions.map((s) => s.id)).toEqual([2])
    expect(after.events.filter((e) => e.session === 1)).toEqual([])
  })

  test('clear опустошает базу и очередь', async () => {
    const { log, dbName } = journal({ now: clock(0).now, sessionId: 1 })
    log.event('a')
    await log.flush()
    log.event('b')
    await log.clear()

    const { sessions, events } = await readAll(dbName)
    expect(sessions).toEqual([])
    expect(events).toEqual([])
  })
})

// ─────────────────────── отказ базы (Review Focus 5) ───────────────────────

describe('недоступная IndexedDB не мешает игре играться', () => {
  /** База, отказывающая на open запросом с ошибкой — приватный режим. */
  const erroringIdb = (): IDBFactory => {
    const factory = {
      open: () => {
        const req: Record<string, unknown> = { error: new Error('отказано'), result: undefined }
        setTimeout(() => (req.onerror as (() => void) | undefined)?.(), 0)
        return req
      },
    }
    return factory as unknown as IDBFactory
  }

  /** База, бросающая прямо из open — исчерпанная квота на некоторых сборках. */
  const throwingIdb = (): IDBFactory =>
    ({
      open: () => {
        throw new Error('квота')
      },
    }) as unknown as IDBFactory

  for (const [name, idb] of [
    ['open отвечает ошибкой', erroringIdb],
    ['open бросает', throwingIdb],
  ] as const) {
    test(`${name}: сотня event и flush не даёт ни одного исключения, broken становится true`, async () => {
      const log = makeJournal({ dbName: freshDb(), idb: idb(), now: clock(0).now, sessionId: 1 })

      const failures: unknown[] = []
      for (let i = 0; i < 100; i++) {
        try {
          log.event('error', { i })
          log.write(ev.pause({ why: 'none' }))
          log.rawPush(i, new Float32Array(132))
          log.rawBurst('miss')
          await log.flush()
        } catch (e) {
          failures.push(e)
        }
      }

      expect(failures).toEqual([])
      expect(log.broken).toBe(true)
    })

    test(`${name}: trim, status, sweepExported, clear и save не бросают`, async () => {
      const log = makeJournal({ dbName: freshDb(), idb: idb(), now: clock(0).now, sessionId: 1 })
      log.event('session.start')

      await expect(log.flush()).resolves.toBeUndefined()
      await expect(log.trim()).resolves.toBe(0)
      await expect(log.status()).resolves.toMatchObject({ broken: true })
      await expect(log.sweepExported()).resolves.toEqual({ sessions: 0, marked: 0, bytes: 0 })
      await expect(log.clear()).resolves.toBeUndefined()
      await expect(log.save()).resolves.toMatchObject({ broken: true })
    })
  }

  test('отсутствующая IndexedDB вовсе (idb: null) ведёт себя так же', async () => {
    const log = makeJournal({ dbName: freshDb(), idb: null, now: clock(0).now, sessionId: 1 })
    for (let i = 0; i < 100; i++) log.event('x', { i })
    await expect(log.flush()).resolves.toBeUndefined()
    expect(log.broken).toBe(true)
  })

  test('сломанный журнал не растит очередь без конца', async () => {
    const log = makeJournal({ dbName: freshDb(), idb: null, now: clock(0).now, sessionId: 1 })
    log.event('a')
    await log.flush()
    for (let i = 0; i < 1000; i++) log.event('b', { i })
    expect(log.queued).toBe(0)
  })
})

// ─────────────────────────── выгрузка ───────────────────────────

describe('выгрузка', () => {
  /** Поддельная оболочка: запоминает порядок и то, что в неё приехало. */
  function shell() {
    const calls: string[] = []
    const files: File[] = []
    let downloaded: { name: string; text: Promise<string> } | null = null
    const deps = {
      download: (blob: Blob, name: string) => {
        calls.push('download')
        downloaded = { name, text: blob.text() }
        return true
      },
      canShare: (f: File[]) => f.length === 1,
      share: async (f: File[]) => {
        calls.push('share')
        files.push(...f)
      },
    }
    return {
      deps,
      calls,
      files,
      get downloaded() {
        return downloaded
      },
    }
  }

  test('save отдаёт и файл, и данные для «Поделиться» — именно в таком порядке', async () => {
    const sh = shell()
    const { log } = journal({ now: clock(0).now, sessionId: 7, ...sh.deps })
    log.write(ev.roundWall({ travelMs: 1500, latencyShiftMs: 120 }))

    const res = await log.save()

    expect(res.saved).toBe(true)
    expect(res.shared).toBe('shared')
    // Файл ПЕРВЫМ: шторку можно закрыть случайно, и журнал не должен пропасть.
    expect(sh.calls).toEqual(['download', 'share'])
    expect(sh.files).toHaveLength(1)
    expect(sh.files[0]?.name).toBe(res.name)
    expect(res.name).toMatch(/^pose-game-log-.*\.json$/)

    const dump = JSON.parse(await (sh.downloaded as unknown as { text: Promise<string> }).text)
    expect(dump.limits.bytes).toBe(LIMITS.bytes)
    expect(dump.sessions).toHaveLength(1)
    expect(dump.sessions[0].log[0]).toMatchObject({ type: 'round.wall', travelMs: 1500 })
    // Выгрузка сбрасывает очередь: самые ценные записи — последние.
    expect(res.bytes).toBeGreaterThan(0)
  })

  test('отказ «Поделиться» не отменяет уже сохранённый файл', async () => {
    const sh = shell()
    const { log } = journal({
      now: clock(0).now,
      sessionId: 8,
      ...sh.deps,
      share: async () => {
        const e = new Error('передумал')
        e.name = 'AbortError'
        throw e
      },
    })
    log.event('a')

    const res = await log.save()
    expect(res.saved).toBe(true)
    expect(res.shared).toBe('cancelled')
  })

  test('нет «Поделиться» вовсе — остаётся файл', async () => {
    const sh = shell()
    const { log } = journal({ now: clock(0).now, sessionId: 10, ...sh.deps, canShare: () => false })
    log.event('a')

    const res = await log.save()
    expect(res.saved).toBe(true)
    expect(res.shared).toBe('unavailable')
  })
})

// ───────────────────── строки скелета: кольцо и всплески ─────────────────────

describe('всплески строк скелета', () => {
  test('бюджет всплесков не превышает 5% потолка', () => {
    const perRun = LIMITS.rawBursts * LIMITS.rawLines * LIMITS.rawLineBytes
    expect(perRun).toBeLessThanOrEqual(LIMITS.bytes * 0.05)
    // И при этом всплеск осмысленный: окно судейства, а не пара кадров.
    expect(LIMITS.rawLines).toBeGreaterThanOrEqual(30)
    expect(LIMITS.rawBursts).toBeGreaterThanOrEqual(4)
  })

  test('кольцо держит последние rawLines строк, всплеск их выгружает', async () => {
    const c = clock(0)
    const { log, dbName } = journal({ now: c.now, sessionId: 11 })

    for (let i = 0; i < LIMITS.rawLines + 10; i++) {
      const lm = new Float32Array(132)
      lm[0] = i / 1000
      log.rawPush(i, lm)
    }
    log.rawBurst('miss')
    await log.flush()

    const { events } = await readAll(dbName)
    const burst = events.find((e) => e.type === 'raw')
    expect(burst).toBeTruthy()
    const lines = burst?.lines as { t: number; v: number[] }[]
    expect(lines).toHaveLength(LIMITS.rawLines)
    expect(lines[0]?.t).toBe(10) // старейшие вытеснены кольцом
    expect(lines[0]?.v).toHaveLength(132)
    expect(burst?.why).toBe('miss')
    // Кольцо после всплеска пусто: один и тот же кадр дважды не выгружается.
    log.rawBurst('pause')
    await log.flush()
    expect((await readAll(dbName)).events.filter((e) => e.type === 'raw')).toHaveLength(1)
  })

  test('всплесков за забег не больше rawBursts, новый забег бюджет возвращает', async () => {
    const { log, dbName } = journal({ now: clock(0).now, sessionId: 12 })

    for (let b = 0; b < LIMITS.rawBursts + 5; b++) {
      log.rawPush(b, new Float32Array(132))
      log.rawBurst('pause')
    }
    await log.flush()
    expect((await readAll(dbName)).events.filter((e) => e.type === 'raw')).toHaveLength(LIMITS.rawBursts)

    log.rawReset()
    log.rawPush(999, new Float32Array(132))
    log.rawBurst('pause')
    await log.flush()
    expect((await readAll(dbName)).events.filter((e) => e.type === 'raw')).toHaveLength(LIMITS.rawBursts + 1)
  })

  test('кадр без скелета в кольцо не кладётся', async () => {
    const { log, dbName } = journal({ now: clock(0).now, sessionId: 13 })
    log.rawPush(1, null)
    log.rawBurst('miss')
    await log.flush()
    expect((await readAll(dbName)).events.filter((e) => e.type === 'raw')).toEqual([])
  })
})

// ─────────────────────── конструкторы событий ───────────────────────

describe('конструкторы событий', () => {
  const perAxis: PerAxisSummary = {
    axes: {
      leftShoulder: {
        want: 'up',
        counts: { ok: 1, miss: 4, unmeasured: 0, excused: 0 },
        outcome: 'miss',
        sample: { want: 'up', got: 'side', measured: 58, ok: false, outcome: 'miss' },
      },
      legs: {
        want: 'wide',
        counts: { ok: 5, miss: 0, unmeasured: 0, excused: 0 },
        outcome: 'ok',
        sample: { want: 'wide', got: 'wide', measured: 2.03, measuredBy: 'knee', ok: true, outcome: 'ok' },
      },
      farElbow: {
        want: 'straight',
        counts: { ok: 0, miss: 0, unmeasured: 0, excused: 5 },
        outcome: 'excused',
        sample: { want: 'straight', got: 'unknown', measured: NaN, ok: false, outcome: 'excused' },
      },
      hands: {
        want: 'no',
        counts: { ok: 0, miss: 0, unmeasured: 5, excused: 0 },
        outcome: 'unmeasured',
        sample: { want: 'no', got: 'unknown', measured: NaN, ok: false, outcome: 'unmeasured' },
      },
    },
    worst: { axis: 'leftShoulder', frames: 4, outcome: 'miss' },
  }

  test('round.judge сохраняет исход по оси, измеренное значение и measuredBy', () => {
    const e = ev.roundJudge({
      poseId: 'star',
      matched: 1,
      frames: 10,
      valid: 5,
      ratio: 0.2,
      perAxis,
      score: 0,
      total: 30,
    })

    expect(e.type).toBe('round.judge')
    const axes = e.data.perAxis.axes
    expect(axes.leftShoulder).toEqual({
      want: 'up',
      got: 'side',
      measured: 58,
      outcome: 'miss',
      ok: false,
      counts: { ok: 1, miss: 4, unmeasured: 0, excused: 0 },
    })
    // Ноги умеют мериться двумя способами — без measuredBy «ноги 2.0» не прочесть.
    expect(axes.legs?.measuredBy).toBe('knee')
    expect(e.data.perAxis.worst).toEqual({ axis: 'leftShoulder', frames: 4, outcome: 'miss' })
  })

  test('«мерить было нечем» не превращается в ноль и поле не выбрасывается', () => {
    const e = ev.roundJudge({
      poseId: 'star',
      matched: 1,
      frames: 10,
      valid: 5,
      ratio: 0.2,
      perAxis,
      score: 0,
      total: 30,
    })
    const axes = e.data.perAxis.axes

    for (const axis of ['farElbow', 'hands'] as const) {
      expect(axes[axis]).toHaveProperty('measured')
      expect(axes[axis]?.measured).toBeNull() // NaN не выживает в JSON — пишем null
      expect(axes[axis]?.measured).not.toBe(0)
    }
    // Различение исходов сохранено: перекрытое и неизмеренное — не одно и то же.
    expect(axes.farElbow?.outcome).toBe('excused')
    expect(axes.hands?.outcome).toBe('unmeasured')

    // И это выживает в выгрузке, а не только в памяти.
    const dump = JSON.parse(JSON.stringify(e.data))
    expect(dump.perAxis.axes.hands.measured).toBeNull()
  })

  test('round.preview несёт позу, зеркальность, ориентацию, требуемые оси и ступень', () => {
    const e = ev.roundPreview({
      poseId: 'flamingo',
      mirror: true,
      orientation: 'front',
      requires: { leftShoulder: 'up', legs: 'together' },
      tier: 2,
    })
    expect(e.type).toBe('round.preview')
    expect(e.data).toEqual({
      poseId: 'flamingo',
      mirror: true,
      orientation: 'front',
      requires: { leftShoulder: 'up', legs: 'together' },
      tier: 2,
    })
  })

  test('round.skip, run.finish, health, pause и calib.done несут объявленные поля', () => {
    expect(ev.roundSkip({ why: 'pause', valid: 2 })).toEqual({
      type: 'round.skip',
      data: { why: 'pause', valid: 2 },
    })
    expect(ev.runFinish({ score: 7, rounds: 5, hits: 2, misses: 2, skipped: 1, tier: 3, durationS: 90 }).data).toEqual(
      { score: 7, rounds: 5, hits: 2, misses: 2, skipped: 1, tier: 3, durationS: 90 },
    )
    expect(ev.health({ fps: 14.6, inferP50: 42, inferP95: 71, drops: 3, valid: 28, lost: 2 }).type).toBe('health')
    expect(ev.pause({ why: 'edge' })).toEqual({ type: 'pause', data: { why: 'edge' } })

    // У калибровки два разных времени, и путать их нельзя: срок устаревания
    // считается только по настенному `takenAtMs`.
    const calib = ev.calibDone({
      S0: 0.31,
      shoulderWidth: 0.26,
      aspect: 16 / 9,
      at: 1234,
      takenAtMs: 1_760_000_000_000,
      cameraId: 'back',
    })
    expect(calib.data.at).toBe(1234)
    expect(calib.data.takenAtMs).toBe(1_760_000_000_000)
  })
})

// ──────────────────── журнал не трогает базу, пока не надо ────────────────────

describe('цена журнала', () => {
  let opened = 0
  beforeEach(() => {
    opened = 0
  })

  test('event не ходит в базу: сброс раз в flushMs', async () => {
    const real = new IDBFactory()
    const counting = {
      open: (name: string, version?: number) => {
        opened++
        return real.open(name, version as number)
      },
    } as unknown as IDBFactory

    const log = makeJournal({ dbName: freshDb(), idb: counting, now: clock(0).now, sessionId: 14 })
    for (let i = 0; i < 50; i++) log.event('x', { i })
    expect(opened).toBe(0)

    await log.flush()
    expect(opened).toBe(1)
    await log.flush() // очередь пуста — в базу не ходим
    expect(opened).toBe(1)
  })
})
