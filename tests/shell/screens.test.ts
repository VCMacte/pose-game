// @vitest-environment happy-dom
/**
 * Экраны: что видит ребёнок, чего он не видит, и как взрослый попадает к себе.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

import { startApp } from '../../src/shell/app'
import { makeSettings } from '../../src/adapters/settings'

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

/** Приложение с подменёнными зависимостями: ни камеры, ни WebAudio в node нет. */
function app(over: Parameters<typeof startApp>[1] = {}) {
  return startApp(root, {
    settings: makeSettings({ store: memStore() }),
    audio: { cue: () => {}, hit: () => {}, miss: () => {}, neutral: () => {}, setVolume: () => {} },
    raf: () => 0,
    cancelRaf: () => {},
    now: () => 0,
    // Источник позы подменён ВСЕГДА: по умолчанию он динамически грузит
    // семнадцать мегабайт вендора MediaPipe, которых в node нет и быть не должно.
    startPose: async () => async () => {},
    ...over,
  })
}

const q = (sel: string): HTMLElement | null => root.querySelector(sel)
const all = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel))
const byTest = (id: string): HTMLElement | null => q(`[data-test="${id}"]`)
const text = (): string => root.textContent ?? ''

describe('главное меню — экран ребёнка', () => {
  test('показывает ИГРАТЬ, результаты, длину забега и сложность — и только их', () => {
    const a = app()
    expect(a.screen()).toBe('menu')
    expect(byTest('play')).not.toBeNull()
    expect(byTest('best')).not.toBeNull()
    expect(all('[data-test="duration"] button').length).toBe(3)
    expect(all('[data-test="tier"] button').length).toBe(3)
  })

  test('кнопки «Тренировка» нет', () => {
    // Не-цель первой версии: силуэт включается тумблером в настройках забега,
    // а отдельного режима тренировки в игре нет вовсе.
    app()
    expect(text()).not.toMatch(/тренировк/i)
    expect(byTest('training')).toBeNull()
  })

  test('отдельной кнопки калибровки нет: забег начинается с неё сам', () => {
    // Ребёнок не должен выбирать между «играть» и «сначала калибровка» — он
    // не знает, что такое калибровка.
    app()
    expect(byTest('calibrate')).toBeNull()
    expect(text()).not.toMatch(/калибровк/i)
  })

  test('длина забега и сложность переключаются и держатся', () => {
    const a = app()
    const btn = all('[data-test="tier"] button')[2]
    btn.click()
    expect(a.settings.get('tier')).toBe(3)
    const d = all('[data-test="duration"] button')[0]
    d.click()
    expect(a.settings.get('durationSec')).toBe(60)
  })
})

describe('вход на экраны взрослого', () => {
  test('это ПРОСТАЯ КНОПКА на главном экране, без удержаний и углов', () => {
    // Прежний приём — долгое удержание правого верхнего угла — снят: см.
    // разворот в docs/menu-and-settings.md.
    const a = app()
    const btn = byTest('adult')
    expect(btn).not.toBeNull()
    btn!.click()
    expect(a.screen()).not.toBe('menu')
  })

  test('вход срабатывает от ОДНОГО клика, без удержания', () => {
    /*
     * Сторож против возврата ритуала. Прошлая версия проверяла отсутствие
     * поля `longPress` у объекта, у типа которого такого поля нет вовсе, —
     * то есть не могла не пройти.
     *
     * Проверяется наблюдаемое поведение: экран меняется на первом же клике, а
     * не после паузы и не после второго.
     */
    const a = app()
    expect(a.screen()).toBe('menu')
    byTest('adult')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(a.screen()).toBe('settings')
  })

  test('в исходниках оболочки нет распознавателя удержания', () => {
    // Вторая половина того же сторожа, уже по коду: ритуал возвращают не
    // переименованием кнопки, а новым таймером «подержи подольше».
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'shell', 'app.ts'), 'utf8')
    expect(src).not.toMatch(/longPress|holdMs|cornerFrac/)
  })

  test('с экранов взрослого есть путь назад', () => {
    // Иначе взрослый, заглянувший в настройки, обрывает забег перезагрузкой.
    const a = app()
    byTest('adult')!.click()
    expect(byTest('back')).not.toBeNull()
    byTest('back')!.click()
    expect(a.screen()).toBe('menu')
  })

  test('настройки и служебный экран — разные экраны, оба достижимы', () => {
    const a = app()
    a.go('settings')
    expect(a.screen()).toBe('settings')
    a.go('service')
    expect(a.screen()).toBe('service')
  })
})

describe('настройки забега — экран взрослого', () => {
  test('перечисляет группы из спека', () => {
    const a = app()
    a.go('settings')
    for (const group of ['такт', 'помощь', 'судейство', 'словарь', 'звук']) {
      expect(text().toLowerCase()).toContain(group)
    }
  })

  test('порога голосования и длины окна здесь НЕТ', () => {
    // Это следствия измеренной частоты кадров, а не вкусовые параметры:
    // предлагать их взрослому значит предлагать сломать судейство.
    const a = app()
    a.go('settings')
    expect(text().toLowerCase()).not.toContain('порог голосования')
    expect(text().toLowerCase()).not.toContain('окно судейства')
  })

  test('смена строгости видна живо, без перезапуска забега', () => {
    const a = app()
    a.go('settings')
    const strict = all('[data-test="strictness"] button')
    expect(strict.length).toBe(3)
    strict[2].click()
    expect(a.settings.get('strictness')).toBe('strict')
  })

  test('заблокированный тумблер словаря показан отключённым, а не молча не работает', () => {
    // Тумблер, который нажимается и ничего не делает, выглядит сломанным.
    const a = app()
    a.settings.set('tier', 1)
    a.go('settings')
    const toggles = all('[data-test^="toggle-"]') as HTMLButtonElement[]
    expect(toggles.length).toBeGreaterThan(0)
    for (const t of toggles) {
      const tag = t.dataset.test!.replace('toggle-', '')
      const blocked = t.hasAttribute('disabled')
      // Блокировка в интерфейсе обязана совпадать с блокировкой в данных.
      expect(blocked).toBe(a.blockedToggle(tag))
    }
  })

  test('у заблокированного тумблера есть ПОЯСНЕНИЕ', () => {
    const a = app()
    a.settings.set('tier', 1)
    a.go('settings')
    const blocked = (all('[data-test^="toggle-"]') as HTMLButtonElement[]).filter((t) =>
      t.hasAttribute('disabled'),
    )
    for (const t of blocked) expect(t.title.length).toBeGreaterThan(0)
  })
})

describe('служебный экран', () => {
  test('перечисляет группы из спека', () => {
    const a = app()
    a.go('service')
    for (const group of ['журнал', 'задержка', 'версия', 'отладка']) {
      expect(text().toLowerCase()).toContain(group)
    }
  })

  test('кнопка замера задержки ДЕЛАЕТ замер, а не просто есть', async () => {
    /*
     * Прошлая версия проверяла лишь наличие кнопки — и проходила, пока все
     * кнопки служебного экрана были заглушками `() => {}`. Кнопка, которая
     * нажимается и ничего не меняет, выглядит сломанной игрой, а отличить её
     * от сломанной на штативе нечем.
     */
    let asked = 0
    const a = app({
      measureLatency: async () => {
        asked++
        return { medianMs: 240, spreadMs: 12 }
      },
    })
    a.go('service')
    expect(byTest('measure-latency')).not.toBeNull()
    byTest('measure-latency')!.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(asked).toBe(1)
    expect(a.latency).toEqual({ medianMs: 240, spreadMs: 12 })
    // И результат ПОКАЗАН, а не только сохранён.
    expect(text()).toContain('240')
  })

  test('кнопки журнала зовут журнал, а не молчат', async () => {
    let saved = 0
    let cleared = 0
    const a = app({
      saveLog: async () => void saved++,
      clearLog: async () => void cleared++,
    })
    a.go('service')
    byTest('share-log')!.click()
    byTest('clear-log')!.click()
    await Promise.resolve()
    expect(saved).toBe(1)
    expect(cleared).toBe(1)
  })

  test('пересдача калибровки забывает её: следующий забег начнётся со стадии', () => {
    const a = app()
    a.go('service')
    byTest('recalibrate')!.click()
    a.go('run')
    expect(a.runStage()).toBe('calibration')
  })
})

describe('ориентация — поэкранно, не манифестом', () => {
  test('меню портретное, забег горизонтальный', () => {
    // Манифест задал бы одну ориентацию на всё приложение.
    const a = app()
    expect(a.orientation()).toBe('portrait')
    a.go('run')
    expect(a.orientation()).toBe('landscape')
  })
})

describe('забег', () => {
  test('нет калибровки — забег начинается с неё, а не с раунда', () => {
    const a = app()
    a.go('run')
    expect(a.runStage()).toBe('calibration')
  })

  test('забег ПРОДВИГАЕТСЯ кадрами и рисует, а не стоит заглушкой', () => {
    /*
     * Прошлая версия тестов экрана забега проходила при `step`, который ничего
     * не делал: `runStage()` возвращал константу, рендер не звался ни разу.
     * Здесь кадр экрана прогоняется руками, а рендер и журнал подменены.
     */
    let rendered = 0
    const wrote: string[] = []
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      renderer: () => ({
        render: () => {
          rendered++
        },
      }),
      write: (e) => void wrote.push(e.type),
    })
    a.go('run')
    expect(frameCb).not.toBeNull()

    // Без отношения сторон кадра игра честно отказывается считать: ни одного
    // кадра от камеры ещё не было.
    frameCb!(0)
    expect(rendered).toBe(0)
    expect(a.runStage()).toBe('calibration')
    // Журнал при этом не молчит об ошибках и не пишет лишнего.
    expect(wrote).not.toContain('round.judge')
  })

  test('экран забега не показывает ни одной настройки', () => {
    // Всё, что мог бы нажать ребёнок посреди забега, спрятано под взрослого.
    const a = app()
    a.go('run')
    expect(all('[data-test="duration"] button').length).toBe(0)
    expect(all('[data-test="strictness"] button').length).toBe(0)
  })

  test('на экране забега есть холст, и он один', () => {
    const a = app()
    a.go('run')
    expect(all('canvas').length).toBe(1)
  })

  test('уход с забега гасит такт экрана: кадры не продолжают идти', () => {
    // Иначе два забега подряд дают два живых цикла rAF на одном Adreno 619.
    let cancelled = 0
    const a = app({ raf: () => 7, cancelRaf: () => void cancelled++ })
    a.go('run')
    a.go('menu')
    expect(cancelled).toBeGreaterThan(0)
  })

  test('stop гасит всё и зовётся повторно без последствий', () => {
    const a = app()
    a.go('run')
    expect(() => {
      a.stop()
      a.stop()
    }).not.toThrow()
  })
})

describe('источник позы', () => {
  test('кадры идут в буфер, а не в рендер: такты независимы', async () => {
    let rendered = 0
    let sampled: Array<number> = []
    let onSample: ((f: { t: number; lm: null }, m: { w: number; h: number }) => void) | null = null
    const a = app({
      renderer: () => ({ render: () => void rendered++ }),
      startPose: async (opts) => {
        onSample = opts.onSample as typeof onSample
        return async () => {}
      },
    })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()
    expect(onSample).not.toBeNull()

    // Три кадра камеры — и ни одной отрисовки: рисует только кадр экрана.
    for (const t of [1, 2, 3]) {
      onSample!({ t, lm: null }, { w: 640, h: 360 })
      sampled.push(t)
    }
    expect(sampled.length).toBe(3)
    expect(rendered).toBe(0)
  })

  test('уход с забега ГАСИТ источник позы', async () => {
    // Оставленный жить источник держит камеру занятой, а индикатор — горящим
    // при погашенной игре.
    let stops = 0
    const a = app({ startPose: async () => async () => void stops++ })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()
    a.go('menu')
    expect(stops).toBe(1)
  })

  test('источник, поднявшийся ПОСЛЕ ухода с забега, гасится сразу', async () => {
    /*
     * Камера открывается не мгновенно (лестница ограничений, потолок на
     * ступень). Ребёнок успевает уйти в меню, и поток приезжает в игру,
     * которой он уже не нужен: погасить его больше некому.
     */
    let stops = 0
    let resolve: ((stop: () => Promise<void>) => void) | null = null
    const a = app({
      startPose: () =>
        new Promise((res) => {
          resolve = res
        }),
    })
    a.go('run')
    a.go('menu')
    resolve!(async () => void stops++)
    await Promise.resolve()
    await Promise.resolve()
    expect(stops).toBe(1)
  })

  test('отказ источника называется вслух, а не молчит', async () => {
    const a = app({ startPose: async () => Promise.reject(new Error('нет камеры')) })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(text()).toMatch(/не запустился|Камеры нет/)
  })
})

/*
 * Меню паузы. Модель взята из `run-game`: ручная пауза и автоматическая
 * различаются полем, и меню показывается только на ручной.
 */
describe('меню паузы', () => {
  /** Приложение с поднятым забегом и подконтрольным кадром экрана. */
  function running(over: Parameters<typeof startApp>[1] = {}) {
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      renderer: () => ({ render: () => {} }),
      ...over,
    })
    a.go('run')
    return { a, frame: (t: number) => frameCb?.(t) }
  }

  test('на экране забега есть кнопка паузы', () => {
    const { a } = running()
    expect(byTest('pause')).not.toBeNull()
    void a
  })

  test('меню паузы по умолчанию СКРЫТО: забег идёт', () => {
    running()
    expect(byTest('pause-menu')?.hidden).toBe(true)
  })

  test('в меню паузы есть «Продолжить» и «Вернуться в меню»', () => {
    running()
    expect(byTest('resume')).not.toBeNull()
    expect(byTest('to-menu')).not.toBeNull()
  })

  test('«Вернуться в меню» уводит в меню и ПРЕРЫВАЕТ забег', () => {
    /*
     * Продолжать с середины нечего: ребёнок уже ушёл от камеры, а половина
     * забега без конца результатом не является. Прерывание обязано быть
     * записано — иначе забег выглядит в журнале оборванным без причины.
     */
    const wrote: string[] = []
    const { a } = running({ write: (e) => void wrote.push(e.type) })
    byTest('to-menu')!.click()
    expect(a.screen()).toBe('menu')
    expect(wrote).toContain('run.abort')
    // Прерванный забег НЕ дописывается `run.finish`: он не результат.
    expect(wrote).not.toContain('run.finish')
  })

  test('кнопка паузы не ломает экран, пока забег не начался', () => {
    // Идёт калибровка: паузить нечего, и нажатие обязано быть безвредным.
    const { a } = running()
    expect(a.runStage()).toBe('calibration')
    expect(() => byTest('pause')!.click()).not.toThrow()
    expect(byTest('pause-menu')?.hidden).toBe(true)
  })

  test('уход с забега кнопкой «назад» тоже записывается как прерывание', () => {
    const wrote: string[] = []
    const { a } = running({ write: (e) => void wrote.push(e.type) })
    // Забег ещё на калибровке — прерывать нечего, записи быть не должно.
    a.go('menu')
    expect(wrote.filter((t) => t === 'run.abort').length).toBe(0)
  })
})
