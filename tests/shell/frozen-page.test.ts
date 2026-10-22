// @vitest-environment happy-dom
/**
 * Замершая страница посреди забега — звонок, будильник, свёрнутое приложение.
 *
 * Такт экрана в это время не вызывается вовсе, а потом приходит ОДИН кадр с
 * разрывом в десятки секунд. Без зажима игрового времени ядро закрывает в этом
 * тике все раунды, чьё время вышло: забег кончается мгновенно, приговоры
 * выходят с пустыми буферами, счёт — ноль. Это тот же наблюдаемый отказ, что
 * убил живой прогон 21.10.2026, только причина внешняя.
 *
 * Проверка идёт ЧЕРЕЗ ПРИЛОЖЕНИЕ, а не через ядро: зажим живёт в оболочке
 * (`src/shell/loop.ts`), и проверять надо всю цепочку такта — иначе
 * проверялась бы арифметика, а не забег.
 *
 * Разбор: `docs/presence-and-pause.md`, `docs/camera-and-pose.md`.
 */
import { beforeEach, describe, expect, test } from 'vitest'

import { startApp } from '../../src/shell/app'
import type { AppDeps } from '../../src/shell/app'
import { makeSettings } from '../../src/adapters/settings'
import { CONFIG } from '../../src/core/config'
import { stick } from '../../src/fake/stick'

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

/** Отношение сторон горизонтального кадра 640×360. */
const ASPECT = 640 / 360

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.appendChild(root)
})

/** Приложение с подконтрольным тактом экрана и кадрами нейтральной стойки. */
function harness(over: AppDeps = {}) {
  let frameCb: ((t: number) => void) | null = null
  let onSample: ((f: { t: number; lm: Float32Array | null }, m: { w: number; h: number }) => void) | null = null
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
    lockOrientation: async () => ({ locked: true }),
    startPose: async (o) => {
      onSample = o.onSample as typeof onSample
      return async () => {}
    },
    ...over,
  })
  return {
    a,
    /** Кадр камеры и кадр экрана на одной отметке — как в обычном такте. */
    beat: (t: number) => {
      onSample?.({ t, lm: stick({ aspect: ASPECT }) }, { w: 640, h: 360 })
      frameCb?.(t)
    },
    /** Только кадр экрана: кадров камеры нет (их источник тоже замер). */
    tick: (t: number) => frameCb?.(t),
  }
}

describe('экран калибровки не пустой', () => {
  test('оболочка РИСУЕТ калибровку, а не оставляет чёрный экран', async () => {
    /*
     * «Смотреть на тёмный экран и ждать неприятно и непонятно». Прежде стадия
     * калибровки не рисовала ничего: сцены не было, рендер не звали. Теперь
     * оболочка отдаёт рендеру сцену калибровки — и делает это ДО первого
     * кадра камеры тоже, иначе темнота остаётся в самом частом случае.
     */
    const calibs: number[] = []
    const scenes: number[] = []
    const h = harness({
      renderer: () => ({
        render: () => void scenes.push(1),
        calibration: () => void calibs.push(1),
      }),
    })
    h.a.go('run')

    // Ни одного кадра камеры ещё не было — а рисовать уже есть что.
    h.tick(16)
    expect(calibs.length).toBeGreaterThan(0)
    expect(scenes.length).toBe(0)

    // Калибровка нейтральной стойкой: сцены забега пойдут после неё.
    for (let t = 50; t <= CONFIG.calibration.durationMs + 2000; t += 50) h.beat(t)
    expect(scenes.length).toBeGreaterThan(0)
  })
})

describe('замершая страница посреди забега', () => {
  test('разрыв в минуту НЕ прокручивает раунды и не кончает забег', () => {
    const wrote: Array<Record<string, unknown>> = []
    const h = harness({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    h.a.go('run')

    // Калибровка, затем несколько секунд обычного забега.
    for (let t = 0; t <= CONFIG.calibration.durationMs + 6000; t += 50) h.beat(t)
    const judgedBefore = wrote.filter((e) => e.type === 'round.judge' || e.type === 'round.skip').length
    expect(wrote.some((e) => e.type === 'run.start')).toBe(true)
    expect(wrote.some((e) => e.type === 'run.finish')).toBe(false)

    // Страница замерла на минуту и вернулась одним кадром экрана.
    const after = CONFIG.calibration.durationMs + 6000 + 60_000
    h.tick(after)

    /*
     * Главное утверждение: забег не кончился, и раундов за один тик закрылось
     * не больше одного. Без зажима здесь закрылись бы ВСЕ оставшиеся.
     */
    expect(wrote.some((e) => e.type === 'run.finish')).toBe(false)
    const judgedAfter = wrote.filter((e) => e.type === 'round.judge' || e.type === 'round.skip').length
    expect(judgedAfter - judgedBefore).toBeLessThanOrEqual(1)
  })

  test('забег продолжается с того же места: кадры после возврата судятся', () => {
    /*
     * Вторая половина опасности зажима: часы тика и часы кадра могут
     * разъехаться, и тогда кадры после возврата не попадут ни в одно окно
     * судейства — забег пойдёт, но ослепнет. Поэтому проверяется, что приговоры
     * ПОСЛЕ разрыва выносятся по непустым буферам.
     */
    const wrote: Array<Record<string, unknown>> = []
    const h = harness({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    h.a.go('run')
    for (let t = 0; t <= CONFIG.calibration.durationMs + 3000; t += 50) h.beat(t)

    const gap = CONFIG.calibration.durationMs + 3000 + 60_000
    h.tick(gap)
    const judgedBefore = wrote.filter((e) => e.type === 'round.judge').length

    // Вернулись и играем дальше настоящими кадрами.
    for (let t = gap + 50; t <= gap + 20_000; t += 50) h.beat(t)

    const judged = wrote.filter((e) => e.type === 'round.judge')
    expect(judged.length).toBeGreaterThan(judgedBefore)
    const fresh = judged.slice(judgedBefore)
    // Кадры в окне есть у каждого приговора после возврата: шкалы совпали.
    for (const e of fresh) expect(Number(e.frames)).toBeGreaterThan(0)
  })
})
