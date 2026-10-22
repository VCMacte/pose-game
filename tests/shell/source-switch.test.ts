// @vitest-environment happy-dom
/**
 * Смена источника позы между забегами: отношение сторон и опознание камеры.
 *
 * Оба дефекта здесь — из журнала первого живого забега с ребёнком (22.10.2026).
 * Синтетический забег шёл первым, живой — вторым, и живой забег судил по
 * калибровке, снятой НА СИНТЕТИЧЕСКОМ ИГРОКЕ: `calib.done` второго забега
 * побайтно совпал с первым, включая `aspect: 1.7778`, тогда как камера отдала
 * 360×640, то есть 0.5625.
 *
 * Сторож на это есть — `isStale()` сравнивает отношение сторон, — но он
 * сравнил СТАРОЕ значение само с собой: забег стартует раньше, чем открывается
 * камера, а источники отношения сторон жили один раз на всё приложение и между
 * забегами не сбрасывались.
 *
 * Разбор: `docs/calibration.md`, `docs/camera-and-pose.md`.
 */
import { beforeEach, describe, expect, test } from 'vitest'

import { startApp } from '../../src/shell/app'
import type { AppDeps, StartPoseOpts } from '../../src/shell/app'
import { makeSettings } from '../../src/adapters/settings'
import { CONFIG } from '../../src/core/config'
import { stick } from '../../src/fake/stick'
import type { Frame } from '../../src/core/types'

/** Хранилище в памяти: настройки не должны течь между тестами. */
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

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.appendChild(root)
})

/** Кадр без скелета: проверяется отношение сторон, а не геометрия. */
const blank = (t: number): Frame => ({ t, lm: null })

/**
 * Приложение с подконтрольным источником позы и тактом экрана.
 *
 * Источник отдаётся наружу целиком: проверяется именно то, что оболочка делает
 * с кадрами и их размером, а кадры в бою приходят только оттуда.
 */
function harness(over: AppDeps = {}) {
  let frameCb: ((t: number) => void) | null = null
  let opts: StartPoseOpts | null = null
  const a = startApp(root, {
    settings: makeSettings({ store: memStore() }),
    audio: { cue: () => {}, hit: () => {}, miss: () => {}, neutral: () => {}, setVolume: () => {} },
    raf: (cb) => {
      frameCb = cb
      return 1
    },
    cancelRaf: () => {},
    now: () => 0,
    renderer: () => ({ render: () => {} }),
    startPose: async (o) => {
      opts = o
      return async () => {}
    },
    ...over,
  })
  return {
    a,
    frame: (t: number) => frameCb?.(t),
    /** Кадр от источника с объявленным размером — так его отдаёт конвейер. */
    sample: (t: number, w: number | null, h: number | null) => opts?.onSample(blank(t), { w, h }),
    /** Кадр со скелетом в нейтральной стойке: им сдаётся калибровка. */
    neutral: (t: number) => opts?.onSample({ t, lm: stick({ aspect: ASPECT }) }, { w: 640, h: 360 }),
    /** Камера открылась и назвала себя — это происходит ПОСЛЕ старта забега. */
    camera: (deviceId: string) => opts?.onCamera?.({ deviceId }),
    source: () => opts?.source ?? null,
  }
}

/** Отношение сторон горизонтального кадра 640×360 — того, что отдаёт камера. */
const ASPECT = 640 / 360

const hint = (): string => root.querySelector('[data-test="hint"]')?.textContent ?? ''

describe('смена источника позы между забегами', () => {
  test('отношение сторон НЕ переносится из прошлого забега', () => {
    /*
     * Что сломалось бы без этого: забег считает и калибрует по отношению
     * сторон прошлого источника, пока новый не отдал ни кадра. На живом
     * телефоне этим в живой забег ушла калибровка синтетического игрока —
     * `isStale()` сравнил 1.7778 сам с собой и признал её свежей.
     */
    const h = harness()
    h.a.go('run')
    h.sample(0, 640, 360)
    h.frame(16)
    expect(hint()).not.toBe('Ищу камеру')

    h.a.go('menu')
    h.a.go('run')
    // Новый источник ещё не отдал ни одного кадра — считать нечем.
    h.frame(32)
    expect(hint()).toBe('Ищу камеру')
  })

  test('калибровка запоминает ТУ камеру, на которой снята', () => {
    /*
     * `cameraId` в калибровке существует, чтобы `isStale()` отбраковал её при
     * смене камеры. В журнале живого забега он был `'unknown'` — оболочка
     * настоящее опознание в забег не передавала вовсе, хотя `cam.start` его
     * пишет. Эта половина сторожа сравнивала `'unknown'` с `'unknown'`, то
     * есть не работала ни разу.
     *
     * Опознание приходит ПОСЛЕ старта забега (камера открывается не мгновенно),
     * поэтому забег обязан спрашивать его в момент съёма калибровки, а не
     * получать значением при создании.
     */
    const wrote: Array<Record<string, unknown>> = []
    const h = harness({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    h.a.go('run')
    h.camera('cam-a')

    for (let t = 0; t <= CONFIG.calibration.durationMs + 1000; t += 50) {
      h.neutral(t)
      h.frame(t)
    }

    const calib = wrote.find((e) => e.type === 'calib.done')
    expect(calib).toBeDefined()
    expect(calib!.cameraId).toBe('cam-a')
  })
})

describe('замер задержки на служебном экране', () => {
  test('замер НАЗЫВАЕТ ближайшую ступень сдвига, но не выставляет её', async () => {
    /*
     * Присваивать нельзя: замер измеряет задержку ЗВУКА, а видеопуть совпадает
     * с ней только пока телевизор держит A/V-синхронизацию, — поэтому сдвиг
     * остаётся ручной подкруткой ПОВЕРХ замера. Но и числом на экране замер
     * оставаться не должен: в живом забеге 22.10.2026 он дал 1166 мс, а
     * перечень ступеней упирался в 400, так что выставить измеренное было
     * нельзя вовсе — и забег ушёл с прежними 250.
     * → `docs/audio-and-latency.md`
     */
    const h = harness({ measureLatency: async () => ({ medianMs: 1166, spreadMs: 40 }) })
    h.a.go('service')
    root.querySelector<HTMLElement>('[data-test="measure-latency"]')!.click()
    // Несколько тиков: обещание замера проходит через собственные микрозадачи.
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(root.textContent).toContain('1200')
    // Выставляет ступень ВЗРОСЛЫЙ: присваивание отменило бы его подкрутку.
    expect(h.a.settings.get('latencyMs')).toBe(250)
  })

  test('отказавший замер ГОВОРИТ об отказе, а не молчит', async () => {
    /*
     * Замер отказывает штатно: телевизор приглушён, микрофон не дал
     * разрешения, выстрелы разбежались. Молчание здесь неотличимо от «не
     * мерили», а взрослый на штативе второго источника правды не имеет.
     */
    const h = harness({
      measureLatency: async () => Promise.reject(new Error('выстрелы разбежались')),
    })
    h.a.go('service')
    root.querySelector<HTMLElement>('[data-test="measure-latency"]')!.click()
    // Несколько тиков: обещание замера проходит через собственные микрозадачи.
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(root.textContent).toMatch(/не удался|разбежались/i)
    expect(h.a.screen()).toBe('service')
  })
})

describe('тревоги экрана забега', () => {
  test('вертикальный кадр камеры попадает в ЖУРНАЛ, а не только на экран', () => {
    /*
     * Телефон на штативе, консоли нет: всё, что взрослый видит на экране,
     * обязано быть и в журнале — иначе разобрать забег постфактум нечем.
     *
     * Это ровно случай живого забега 22.10.2026: камера отдала 360×640,
     * предупреждение на экране было, а в журнале его нет — и установить по
     * журналу, показалось ли оно, невозможно.
     * → `docs/log-and-storage.md`
     */
    const wrote: Array<Record<string, unknown>> = []
    const h = harness({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    h.a.go('run')
    h.sample(0, 360, 640)

    const alarm = wrote.find((e) => e.type === 'alarm')
    expect(alarm).toBeDefined()
    expect(String(alarm!.text)).toMatch(/вертикальный/i)
  })

  test('одна и та же тревога пишется ОДИН раз, а не на каждый кадр', () => {
    /*
     * Кадры идут пятьдесят раз в секунду, и тревога на каждом из них съела бы
     * бюджет журнала за минуту, вытеснив из него сам забег. Повтор без
     * изменения текста — не новость.
     */
    const wrote: Array<Record<string, unknown>> = []
    const h = harness({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    h.a.go('run')
    for (let t = 0; t < 10; t++) h.sample(t, 360, 640)

    expect(wrote.filter((e) => e.type === 'alarm').length).toBe(1)
  })
})
