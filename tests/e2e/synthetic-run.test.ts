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
import { makePlay } from '../../src/shell/play'
import { makeSettings } from '../../src/adapters/settings'
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
  /** Сценарий синтетического игрока, либо ничего — игрок, повторяющий позу. */
  script?: FakeScript
  tier: 1 | 2 | 3
  /** Звук исходов, если его проверяют. */
  audio?: { cue(): void; hit(): void; miss(): void; neutral(): void }
  /**
   * Насколько часы КАДРА уехали вперёд от часов ТИКА. На живом телефоне это
   * не выдумка: воркерный конвейер датирует кадр `VideoFrame.timestamp` —
   * часами видеотрека, — а тик приходит из `requestAnimationFrame`. Прогон
   * без сдвига подаёт `t === frame.t` тождественно и потому не видит целого
   * класса отказов (docs/camera-and-pose.md).
   */
  frameSkew?: number
}): Promise<{ state: RunState; log: Row[]; scenes: number }> {
  const marks: FakeMarker[] = []
  /*
   * Темп подменён: забег на 90 ИГРОВЫХ секунд при настоящих паузах шёл бы те
   * же 90 секунд, и единственная проверка, проходящая весь путь целиком, не
   * могла бы входить в обычный прогон. Отметка `t` внутри кадра от подмены не
   * зависит — окно судейства видит те же 7±1 кадр.
   */
  const src = opts.script ? fakeSource(opts.script, HZ, (m) => marks.push(m), async () => {}) : null

  const log: Row[] = []
  const write = (e: { type: string; data: object }): void => {
    log.push({ t: log.length, type: e.type, ...(e.data as Record<string, unknown>) })
  }
  // Самомаркировка приходит синхронно, при создании источника: забытая пометка
  // означала бы синтетические числа, неотличимые от живых.
  for (const m of marks) write(m)

  /** Кольцо строк скелета: его же ведёт журнал в бою. */
  const ring: Array<{ t: number; v: number[] }> = []

  const settings = makeSettings({ store: memStore() })
  settings.set('tier', opts.tier)
  settings.set('durationSec', DURATION_S)
  // Сдвиг на задержку ноль: синтетический игрок встаёт в позу мгновенно, и
  // ненулевой сдвиг уводил бы окно в кадры, которых у него нет.
  settings.set('latencyMs', 0)

  /*
   * ЗАБЕГ ВЕДЁТ `makePlay` — тот самый код, что ведёт его в игре, вместе с его
   * порядком записи в журнал. Прежняя версия этого теста писала журнал сама, и
   * потому проверяла свой писатель, а не оболочкин: порядок событий, состав
   * полей и согласие с replay были гарантированы только внутри теста.
   */
  const play = makePlay({
    settings,
    cal: CAL,
    aspect: () => ASPECT,
    write,
    rnd: makeRnd(1),
    wall: () => 1_760_000_000_000,
    cameraId: 'fake-cam',
    /*
     * Пометка ОБЯЗАТЕЛЬНА по типу: вызов без неё не компилируется. Забытая
     * пометка означала бы синтетические числа, сидящие в журнале неотличимо
     * от живых, — калибровка по такому журналу хуже отсутствующей.
     */
    source: 'fake',
    ...(opts.audio ? { audio: opts.audio } : {}),
    // Сплошная запись скелета: ею и снимают данные для калибровки порогов, и
    // без неё зачтённые раунды не имеют строк, а значит не пересчитываются.
    rawAlways: true,
    raw: {
      push: (t, lm) => {
        if (lm) ring.push({ t: Math.round(t), v: Array.from(lm, (x) => Math.round(x * 1000) / 1000) })
      },
      burst: (why) => {
        if (ring.length === 0) return
        write({ type: 'raw', data: { why, lines: ring.splice(0) } })
      },
      reset: () => void ring.splice(0),
    },
  })

  let scenes = 0
  const iter = src ? src[Symbol.asyncIterator]() : null

  /*
   * ПОТОЛОК кадров, и он не формальность. Игровое время забега на паузе СТОИТ,
   * а сценарий `leave-frame` уводит игрока навсегда — такой забег не кончается
   * никогда и ждёт взрослого. Источник бесконечен, как трек настоящей камеры,
   * так что потребитель обязан иметь свой предел.
   */
  for (let i = 0; i < MAX_FRAMES; i++) {
    if (play.state()?.phase === 'finished') break

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
       *
       * Ориентация берётся из `orientation` ПОЗЫ, а не из `requires`: в
       * `PoseSpec` это отдельное поле. Без этого «верный» игрок стоял бы
       * фронтом в профильных раундах, и те выходили бы НЕСУДИМЫМИ.
       */
      const t = i * (1000 / HZ)
      const pose = play.state()?.pose
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

    // Тик идёт по своим часам, кадр — по своим: ровно так их видит оболочка
    // на телефоне.
    const skew = opts.frameSkew ?? 0
    const got = play.step(frame.t, [skew === 0 ? frame : { ...frame, t: frame.t + skew }])
    if (got.scene) scenes++
  }

  const state = play.state()
  /*
   * Калибровка подана готовой, значит забег обязан был начаться. `null` здесь
   * означал бы, что он не начался вовсе — и все проверки ниже судили бы о
   * пустоте, молча проходя.
   */
  if (!state) throw new Error('забег не начался: play.state() === null')
  return { state, log, scenes }
}

/** Хранилище настроек в памяти: забеги не должны течь друг в друга. */
function memStore(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage
}

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

describe('звук исходов', () => {
  test('мотив звучит на КАЖДОМ раунде и по его исходу', async () => {
    /*
     * Созданный, но ни разу не зазвучавший звук — ровно тот дефект «выглядит
     * работающим и не работает», что уже находился в этом проекте трижды.
     */
    const heard: string[] = []
    const audio = {
      cue: () => heard.push('cue'),
      hit: () => heard.push('hit'),
      miss: () => heard.push('miss'),
      neutral: () => heard.push('neutral'),
    }
    const { state } = await playRun({ tier: 3, audio })

    const hits = heard.filter((x) => x === 'hit').length
    const cues = heard.filter((x) => x === 'cue').length
    expect(hits).toBe(state.outcomes.filter((o) => o.kind === 'hit').length)
    expect(cues).toBe(state.outcomes.length)
    expect(heard).not.toContain('miss')
  })

  test('несудимый раунд звучит НЕ как провал', async () => {
    // Тот же инвариант, что у цвета стены: ребёнок не должен услышать провал
    // за раунд, которого игра не судила.
    const heard: string[] = []
    const audio = {
      cue: () => heard.push('cue'),
      hit: () => heard.push('hit'),
      miss: () => heard.push('miss'),
      neutral: () => heard.push('neutral'),
    }
    await playRun({ script: 'leave-frame', tier: 1, audio })
    expect(heard).not.toContain('miss')
    expect(heard).not.toContain('hit')
  })
})

/*
 * Ручная пауза сквозь весь путь: ядро, журнал и признак, по которому оболочка
 * решает, показывать ли меню. Модель `run-game`: ручная и автоматическая
 * различаются ПОЛЕМ, и меню показывается только на ручной.
 */
describe('ручная пауза в забеге', () => {
  /** Забег, которым можно управлять покадрово. */
  function interactive(opts: { script?: FakeScript; tier: 1 | 2 | 3 }) {
    const log: Row[] = []
    const write = (e: { type: string; data: object }): void => {
      log.push({ t: log.length, type: e.type, ...(e.data as Record<string, unknown>) })
    }
    const ring: Array<{ t: number; v: number[] }> = []

    const settings = makeSettings({ store: memStore() })
    settings.set('tier', opts.tier)
    settings.set('durationSec', DURATION_S)
    settings.set('latencyMs', 0)

    const play = makePlay({
      settings,
      cal: CAL,
      aspect: () => ASPECT,
      write,
      rnd: makeRnd(1),
      wall: () => 1_760_000_000_000,
      cameraId: 'fake-cam',
      source: 'fake',
      // Кольцо строк скелета своё: иначе всплеск уходит в настоящий журнал,
      // который в node молчит, и проверить его нечем.
      raw: {
        push: (t, lm) => {
          if (lm) ring.push({ t: Math.round(t), v: [] })
        },
        burst: (why) => {
          if (ring.length === 0) return
          write({ type: 'raw', data: { why, lines: ring.splice(0) } })
        },
        reset: () => void ring.splice(0),
      },
    })

    /** Прогнать кадры верного игрока с `from` до `to`. */
    const run = (from: number, to: number, present = true): void => {
      for (let t = from; t <= to; t += 1000 / HZ) {
        const pose = play.state()?.pose
        const lm = present
          ? stick({
              ...(pose?.requires ?? {}),
              ...(pose ? { orientation: pose.orientation } : {}),
              facing: 'right',
              aspect: ASPECT,
            })
          : null
        play.step(t, [{ t, lm }])
      }
    }

    return { play, log, run }
  }

  test('ручная пауза останавливает забег и пишется в журнал причиной manual', () => {
    const { play, log, run } = interactive({ tier: 1 })
    run(0, 1500)
    expect(play.state()?.phase).toBe('running')

    play.pauseManual(1500)
    expect(play.state()?.phase).toBe('paused')
    expect(play.manual()).toBe(true)

    const pauses = log.filter((e) => e.type === 'pause')
    expect(pauses.length).toBe(1)
    expect(pauses[0].why).toBe('manual')

    // Время забега стоит, хотя кадры идут и ребёнок виден.
    const frozen = play.state()!.elapsedMs
    run(1500 + 1000 / HZ, 5000)
    expect(play.state()?.elapsedMs).toBe(frozen)
  })

  test('АВТОПАУЗА не ручная: меню паузы на ней не показывается', () => {
    /*
     * Главное различие. Ребёнок вышел из кадра — забег ждёт его, а не
     * предлагает всё бросить: таких эпизодов за забег бывает несколько.
     */
    const { play, run } = interactive({ tier: 1 })
    run(0, 1000)
    // Ушёл — присутствие само просит паузу.
    run(1000 + 1000 / HZ, 5000, false)
    expect(play.state()?.phase).toBe('paused')
    expect(play.manual()).toBe(false)
    expect(play.state()?.pauseWhy).not.toBeNull()
  })

  test('возврат с ручной паузы продолжает забег и пишет resume', () => {
    const { play, log, run } = interactive({ tier: 1 })
    run(0, 1500)
    play.pauseManual(1500)

    expect(play.resume(1500)).toBe(true)
    expect(play.state()?.phase).toBe('running')
    expect(play.manual()).toBe(false)
    expect(log.some((e) => e.type === 'resume')).toBe(true)
  })

  test('возврат ОТКАЗАН, пока ребёнок не вернулся в кадр', () => {
    // Он нажал кнопку и ушёл — обычный случай, пауза затем и нужна.
    const { play, run } = interactive({ tier: 1 })
    run(0, 1500)
    play.pauseManual(1500)
    run(1500 + 1000 / HZ, 5000, false)

    expect(play.state()?.canResume).toBe(false)
    expect(play.resume(5000)).toBe(false)
    expect(play.state()?.phase).toBe('paused')
  })

  test('прерывание пишет run.abort и НЕ пишет run.finish', () => {
    // Прерванный забег результатом не является, и смешивать их нельзя: иначе
    // половина забега без конца попадёт и в статистику, и в калибровку.
    const { play, log, run } = interactive({ tier: 1 })
    run(0, 3000)
    play.pauseManual(3000)
    play.abort('pause')

    const abort = log.find((e) => e.type === 'run.abort')
    expect(abort).toBeTruthy()
    expect(abort!.where).toBe('pause')
    expect(abort!.rounds).toBe(play.state()!.outcomes.length)
    expect(log.some((e) => e.type === 'run.finish')).toBe(false)
  })

  test('раунд, прерванный ручной паузой, даёт skip, а не провал', () => {
    // Приговор не вправе наказывать за то, чего игра не видела, — а она не
    // судила этот раунд вовсе.
    const { play, run } = interactive({ tier: 1 })
    run(0, 1500)
    play.pauseManual(1500)
    const last = play.state()!.outcomes.at(-1)
    expect(last?.kind).toBe('skip')
    expect(last?.verdict).toBeNull()
    expect(play.state()!.score).toBe(0)
  })

test('выход из ЗАКОНЧЕННОГО забега не пишет run.abort поверх run.finish', () => {
    /*
     * `run.abort` означает «прерван и НЕ дошёл до конца»
     * (`adapters/log/events.ts`). Дописать его после `run.finish` значит
     * соврать журналу: по нему настраивают пороги, и доигранный забег,
     * помеченный прерванным, портит и статистику, и калибровку.
     *
     * Путь стал достижим вместе с меню законченного забега: прежде выхода с
     * того экрана не было вовсе, и обработчик писался только под паузу.
     */
    const { play, log, run } = interactive({ tier: 1 })
    run(0, DURATION_S * 1000 + 15_000)
    expect(play.state()?.phase).toBe('finished')
    expect(log.some((e) => e.type === 'run.finish')).toBe(true)

    play.abort('menu')

    expect(log.some((e) => e.type === 'run.abort')).toBe(false)
  })

  test('пауза даёт всплеск строк скелета: это интересный для разбора момент', () => {
    const { play, log, run } = interactive({ tier: 1 })
    run(0, 1500)
    play.pauseManual(1500)
    expect(log.some((e) => e.type === 'raw' && e.why === 'pause')).toBe(true)
  })
})

/**
 * Разрыв часов кадра и часов тика — тот самый класс отказов, которого в этом
 * файле не было: и здесь, и в юнитах ядра время кадра совпадало с временем
 * тика ТОЖДЕСТВЕННО, потому что синтетический источник ставит `tCap: t`
 * (`adapters/pose/source.ts`). На телефоне совпадения нет: воркерный конвейер
 * датирует кадр часами видеотрека. В первом живом прогоне разрыв составил
 * ~9.3e8 мс, и забег на 60 секунд кончился за 142 мс — девять несудимых
 * раундов с пустым буфером и счёт ноль, при исправных камере и трекере.
 *
 * Прогон со сдвигом обязан быть НЕОТЛИЧИМ от прогона без него.
 */
describe('часы кадра разошлись с часами тика', () => {
  /** Порядок разрыва тот же, что в журнале с телефона. */
  const SKEW = 900_000

  test('забег со сдвинутыми часами кадра идёт так же, как с совпадающими', async () => {
    const skewed = await playRun({ tier: 3, frameSkew: SKEW })
    const aligned = await playRun({ tier: 3 })

    expect(skewed.state.phase).toBe(aligned.state.phase)
    expect(skewed.state.outcomes.map((o) => o.kind)).toEqual(
      aligned.state.outcomes.map((o) => o.kind),
    )
    expect(skewed.state.score).toBe(aligned.state.score)
  })

  test('забег не схлопывается: раунды судятся по кадрам, а не по пустоте', async () => {
    const { state } = await playRun({ tier: 3, frameSkew: SKEW })

    expect(state.outcomes.length).toBeGreaterThan(0)
    for (const o of state.outcomes) expect(o.verdict!.frames).toBeGreaterThan(0)
  })

  test('сцена рисуется: сдвиг не оставляет экран пустым', async () => {
    const { scenes } = await playRun({ tier: 3, frameSkew: SKEW })

    expect(scenes).toBeGreaterThan(0)
  })
})
