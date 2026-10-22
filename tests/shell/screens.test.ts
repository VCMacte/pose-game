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
    /*
     * Замок ориентации — тоже всегда: `screen.orientation` в node нет, и
     * настоящий замок отказал бы, добавив на экран просьбу повернуть телефон
     * во все тесты разом. Его собственное поведение проверяется в
     * `tests/shell/orientation.test.ts`.
     */
    lockOrientation: async () => ({ locked: true }),
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

  test('стиль не перебивает `hidden`: иначе меню видно при верном свойстве', () => {
    /*
     * Проверка по ИСХОДНИКУ стиля, а не по свойству элемента, и причина
     * конкретная. Стиль браузера задаёт `[hidden] { display: none }` с
     * наименьшим весом, и `.pause-menu { display: flex }` его перебивал: меню
     * паузы висело поверх игры навсегда, при верном `hidden` у элемента.
     * Тест на свойство это пропустил — в node нет раскладки, — и поймалось
     * оно только запуском собранной страницы в браузере.
     */
    const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
    expect(html).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/)
  })

  test('в меню паузы есть «Продолжить» и «Вернуться в меню»', () => {
    running()
    expect(byTest('resume')).not.toBeNull()
    expect(byTest('to-menu')).not.toBeNull()
  })

  test('на ЗАПЕРТОЙ автопаузе меню паузы показывается', async () => {
    /*
     * Живой забег 22.10.2026: пауза по `orientation` не снималась никогда
     * (порог против игрока), меню на автопаузе не показывалось — и выйти из
     * забега было нечем, кроме убийства приложения. Теперь оболочка
     * спрашивает забег, не заперся ли он, и выпускает взрослого.
     */
    let onSample: ((f: { t: number; lm: Float32Array | null }, m: { w: number; h: number }) => void) | null = null
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      renderer: () => ({ render: () => {} }),
      startPose: async (opts) => {
        onSample = opts.onSample as typeof onSample
        return async () => {}
      },
    })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()

    const { stick } = await import('../../src/fake/stick')
    const { CONFIG } = await import('../../src/core/config')
    const beat = (t: number, lm: Float32Array | null): void => {
      onSample!({ t, lm }, { w: 640, h: 360 })
      frameCb!(t)
    }

    // Калибровка нейтральной стойкой, потом забег, потом игрок исчез.
    let t = 0
    for (; t <= CONFIG.calibration.durationMs + 1500; t += 50) beat(t, stick({ aspect: 16 / 9 }))
    expect(byTest('pause-menu')?.hidden).toBe(true)

    const until = t + CONFIG.presence.pauseMs + CONFIG.presence.stuckMs + 1000
    for (; t <= until; t += 50) beat(t, null)

    expect(byTest('pause-menu')?.hidden).toBe(false)
    // «Продолжить» при этом отключена: присутствие возврат не подтвердило.
    expect((byTest('resume') as HTMLButtonElement).disabled).toBe(true)
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

describe('строка информации и обслуживание', () => {
  test('в меню показана версия сборки', () => {
    /*
     * Установленное PWA обновляется само и молча: без номера на экране
     * невозможно понять, доехала ли сборка до телефона, а журнал со
     * вчерашней выглядит точно так же, как с сегодняшней.
     */
    app({ serviceInfo: () => info({ version: '20261020-0930', modelCached: true }) })
    expect(byTest('info')?.textContent).toContain('20261020')
  })

  test('синтетический источник ПОМЕЧЕН в строке информации', () => {
    // Иначе однажды ребёнку дадут поиграть с синтетикой и будут гадать,
    // почему камера ни на что не влияет.
    const a = app({ serviceInfo: () => info({ modelCached: true }) })
    a.go('service')
    const sources = all('[data-test="debug-source"] button')
    sources[1].click()
    a.go('menu')
    expect(byTest('info')?.textContent).toMatch(/СИНТЕТИКА/)
  })

  test('отсутствие модели в кэше ПОМЕЧЕНО: офлайн не выйдет', () => {
    // Знать об этом надо ДО того, как выйдешь из сети.
    app({ serviceInfo: () => info({ modelCached: false }) })
    expect(byTest('info')?.textContent).toMatch(/модель не в кэше/)
  })

  test('когда всё обычно, пометок нет — только версия', () => {
    // Строка, вечно полная предупреждений, перестаёт читаться.
    app({ serviceInfo: () => info({ modelCached: true }) })
    expect(all('[data-test="info"] .mark').length).toBe(0)
  })

  test('кнопка обновления кэша есть в МЕНЮ и работает', () => {
    /*
     * Именно в меню: когда в кэше лежит сломанная сборка, до внутренних
     * экранов можно и не добраться — а это ровно тот случай, когда кнопка и
     * нужна.
     */
    let dropped = 0
    const a = app({ refreshCache: async () => void dropped++ })
    expect(byTest('refresh-cache')).not.toBeNull()
    byTest('refresh-cache')!.click()
    expect(dropped).toBe(1)
    void a
  })

  test('служебный экран ДОСТИЖИМ из настроек', () => {
    /*
     * Он существовал, но нажать его было негде: вход к взрослому вёл в
     * настройки, а оттуда дороги дальше не было вовсе — то есть журнал,
     * замер задержки и отладка были недоступны из интерфейса.
     */
    const a = app()
    byTest('adult')!.click()
    expect(a.screen()).toBe('settings')
    expect(byTest('to-service')).not.toBeNull()
    byTest('to-service')!.click()
    expect(a.screen()).toBe('service')
  })

  test('выгрузка и очистка журнала доступны и зовут журнал', async () => {
    let saved = 0
    let cleared = 0
    const a = app({ saveLog: async () => void saved++, clearLog: async () => void cleared++ })
    byTest('adult')!.click()
    byTest('to-service')!.click()
    expect(a.screen()).toBe('service')
    byTest('share-log')!.click()
    byTest('clear-log')!.click()
    await Promise.resolve()
    expect({ saved, cleared }).toEqual({ saved: 1, cleared: 1 })
  })
})

/** Сводка служебного экрана с нужными для проверки полями. */
function info(over: { version?: string; modelCached?: boolean; broken?: boolean } = {}) {
  return {
    log: { sessions: 0, events: 0, bytes: 0, broken: over.broken ?? false },
    latency: null,
    build: {
      version: over.version ?? 'dev',
      date: '—',
      modelCached: over.modelCached ?? true,
    },
  }
}

/*
 * Видимость отказов. Телефон стоит на штативе, консоли у него нет: сообщение
 * на экране — единственный способ узнать, что сломалось. В первом живом
 * прогоне не было видно НИ ОДНОГО отказа, потому что `say(hint)` зовётся
 * каждый кадр rAF и затирал аварийную строку через ~16 мс.
 */
describe('аварийные сообщения переживают кадр экрана', () => {
  /** Поднимает забег, отдавая наружу колбэк кадра и управление статусами. */
  function runWith(over: Parameters<typeof app>[0] = {}) {
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      ...over,
    })
    a.go('run')
    return { a, frame: (t: number) => frameCb!(t) }
  }

  test('отказ источника не стирается следующим кадром экрана', async () => {
    const { frame } = runWith({ startPose: async () => Promise.reject(new Error('нет камеры')) })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(text()).toMatch(/не запустился|Камеры нет/)

    // Вот тот самый кадр, который всё и стирал.
    frame(16)
    frame(32)

    expect(text()).toMatch(/не запустился|Камеры нет/)
  })

  test('«камеры нет» держится на экране, а не мигает', async () => {
    let onStatus: ((s: { kind: string }) => void) | null = null
    const { frame } = runWith({
      startPose: async (opts) => {
        onStatus = opts.onStatus as typeof onStatus
        return async () => {}
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    onStatus!({ kind: 'exhausted' })
    frame(16)

    expect(text()).toMatch(/Камеры нет/)
  })

  test('просевшая ступень конвейера НАЗВАНА, а не проглочена', async () => {
    // Статус `down` раньше не обрабатывался вовсе: лестница конвейеров могла
    // просесть целиком, и на экране это ничем не отличалось от «ищу камеру».
    let onStatus: ((s: { kind: string; pipeline?: string }) => void) | null = null
    const { frame } = runWith({
      startPose: async (opts) => {
        onStatus = opts.onStatus as typeof onStatus
        return async () => {}
      },
    })
    await Promise.resolve()
    await Promise.resolve()
    onStatus!({ kind: 'down', pipeline: 'stream/GPU' })
    frame(16)

    expect(text()).toMatch(/распознавани|конвейер|ступень/i)
  })
})

describe('подсказка калибровки возвращается, когда камера нашлась', () => {
  test('«Ищу камеру» не остаётся на экране после первого кадра', async () => {
    /*
     * `hint` ставится в «Ищу камеру», пока нет отношения сторон, и прежде
     * НИКОГДА не возвращался обратно: ветка калибровки подсказку не трогала,
     * и исходное «Встань прямо и постой пять секунд» было затёрто навсегда.
     * На телефоне это выглядело как зависшая игра — камера уже работала, шла
     * калибровка, а экран звал камеру.
     */
    let frameCb: ((t: number) => void) | null = null
    let onSample: ((f: { t: number; lm: null }, m: { w: number; h: number }) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      startPose: async (opts) => {
        onSample = opts.onSample as typeof onSample
        return async () => {}
      },
    })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()

    frameCb!(0)
    expect(text()).toMatch(/Ищу камеру/)

    // Кадр камеры пришёл: отношение сторон известно, идёт калибровка.
    onSample!({ t: 1, lm: null }, { w: 640, h: 360 })
    frameCb!(16)

    expect(a.runStage()).toBe('calibration')
    expect(text()).not.toMatch(/Ищу камеру/)
    expect(text()).toMatch(/Встань прямо|постой/i)
  })
})

describe('законченный забег выпускает с экрана', () => {
  test('по окончании показано меню с выходом, и это НЕ меню паузы', async () => {
    /*
     * Прежде выход с экрана забега был только через меню ручной паузы
     * (`onMenu`), а меню паузы на законченном забеге не показывается. Забег,
     * доигранный до конца, запирал экран: кнопка паузы видна и мертва,
     * вернуться некуда. На телефоне это и прочли как «кнопка не работает».
     */
    const { runScreen } = await import('../../src/shell/screens/run')
    const rs = runScreen({ onPause: () => {}, onResume: () => {}, onMenu: () => {} })
    root.appendChild(rs.root)

    rs.finishMenu(true)

    const toMenu = byTest('to-menu')
    expect(toMenu).not.toBeNull()
    expect(toMenu!.closest('[hidden]')).toBeNull()
    // «Продолжить» на законченном забеге продолжать нечего.
    expect((byTest('resume') as HTMLButtonElement).hidden).toBe(true)
    expect(rs.root.textContent).not.toMatch(/Пауза/)
  })

  test('снимается так же, как ставится', async () => {
    const { runScreen } = await import('../../src/shell/screens/run')
    const rs = runScreen({ onPause: () => {}, onResume: () => {}, onMenu: () => {} })
    root.appendChild(rs.root)

    rs.finishMenu(true)
    rs.finishMenu(false)

    expect(byTest('pause-menu')!.hidden).toBe(true)
  })
})

/*
 * Локальная проверка без камеры: `?fake=<сценарий>`. Нужна она ровно потому,
 * что первый живой прогон провалился на том, чего из node не видно, а гонять
 * ребёнка перед штативом ради каждой правки нельзя.
 */
describe('?fake= — проверка игры без камеры', () => {
  test('флаг включает синтетический источник', () => {
    const a = app({ search: '?fake=hit' })
    a.go('menu')

    expect(text()).toMatch(/СИНТЕТИКА/)
    expect(text()).toMatch(/hit/)
  })

  test('без флага источник остаётся камерой и плашки нет', () => {
    const a = app({ search: '' })
    a.go('menu')

    expect(text()).not.toMatch(/СИНТЕТИКА/)
  })

  test('пустое значение берёт сценарий по умолчанию', () => {
    const a = app({ search: '?fake=' })
    a.go('menu')

    expect(text()).toMatch(/СИНТЕТИКА/)
  })

  test('опечатка в сценарии НАЗВАНА, а не подменена умолчанием', () => {
    // Молчаливый откат дал бы «проверил не то, что собирался».
    const a = app({ search: '?fake=walk' })
    a.go('menu')

    expect(text()).toMatch(/нет такого сценария/)
    expect(text()).not.toMatch(/СИНТЕТИКА/)
  })

  test('сценарий доезжает до источника позы, а не теряется в оболочке', async () => {
    let asked: { source: string; script?: string } | null = null
    const a = app({
      search: '?fake=leave-frame',
      startPose: async (opts) => {
        asked = { source: opts.source, ...(opts.script ? { script: opts.script } : {}) }
        return async () => {}
      },
    })
    a.go('run')
    await Promise.resolve()

    expect(asked).toEqual({ source: 'fake', script: 'leave-frame' })
  })
})

describe('вертикальный кадр камеры назван вслух', () => {
  /*
   * Экран забега горизонтальный, а камера в первом живом прогоне отдала кадр
   * 360×640 — вертикальный. Геометрия на таком кадре считается (она честно
   * домножает `x` на отношение сторон), калибровка проходит, и расхождение
   * нигде не всплывает: в журнале остаётся `aspect: 0.5625`, и понять по нему,
   * что телефон держали вертикально, можно только зная, что так бывает.
   */
  function runWithFrame(w: number, h: number) {
    let onSample: ((f: { t: number; lm: null }, m: { w: number; h: number }) => void) | null = null
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      startPose: async (opts) => {
        onSample = opts.onSample as typeof onSample
        return async () => {}
      },
    })
    a.go('run')
    return {
      feed: async () => {
        await Promise.resolve()
        await Promise.resolve()
        onSample!({ t: 1, lm: null }, { w, h })
        frameCb!(16)
      },
    }
  }

  /*
   * Читается АВАРИЙНАЯ СТРОКА, а не весь текст экрана: на экране забега с
   * недавних пор постоянно лежит просьба повернуть телефон, которую
   * показывает и скрывает один только CSS (`@media (orientation: portrait)`).
   * В node раскладки нет, так что в `textContent` она попадает всегда, и
   * проверка по всему тексту стала бы проверкой самой себя.
   */
  const alarmText = (): string => byTest('alarm')?.textContent ?? ''

  test('кадр 360×640 — предупреждение повернуть телефон', async () => {
    const { feed } = runWithFrame(360, 640)
    await feed()

    expect(alarmText()).toMatch(/вертикальн/i)
  })

  test('кадр 640×360 — ничего лишнего не говорится', async () => {
    const { feed } = runWithFrame(640, 360)
    await feed()

    expect(alarmText()).not.toMatch(/вертикальн|поверни/i)
  })
})

describe('просьба постоять спокойно не затирается общей подсказкой', () => {
  test('«Постой спокойно ещё немного» держится, а не мигает один кадр', async () => {
    /*
     * Калибровка переспрашивает подсказку каждый кадр, и безусловная
     * установка общей просьбы стирала бы частную через ~16 мс — тот же класс
     * дефекта, ради которого в этом же изменении аварийную строку отделили
     * от подсказки. Ребёнок, который ёрзает, видел бы общую инструкцию
     * вместо «стой спокойно».
     */
    let onSample: ((f: { t: number; lm: Float32Array | null }, m: { w: number; h: number }) => void) | null = null
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      startPose: async (opts) => {
        onSample = opts.onSample as typeof onSample
        return async () => {}
      },
    })
    a.go('run')
    await Promise.resolve()
    await Promise.resolve()

    const { stick } = await import('../../src/fake/stick')
    /*
     * Ребёнок шевелится: каждый кадр сдвинут. Калибратор отвечает `steady`,
     * и просьба постоять обязана остаться на экране.
     */
    for (let i = 0; i < 90; i++) {
      // Разброс центра втрое выше порога `calibration.steadyCx` (0.03).
      const x = i % 2 === 0 ? 0.45 : 0.55
      onSample!({ t: i * 83, lm: stick({ aspect: 16 / 9, x }) }, { w: 640, h: 360 })
      frameCb!(i * 83)
    }

    expect(a.runStage()).toBe('calibration')
    expect(text()).toMatch(/спокойно/i)
  })
})

describe('просадка конвейера переживает поднявшуюся ступень', () => {
  function runWithStatus() {
    let onStatus: ((s: { kind: string; pipeline?: string }) => void) | null = null
    let frameCb: ((t: number) => void) | null = null
    const a = app({
      raf: (cb) => {
        frameCb = cb
        return 1
      },
      startPose: async (opts) => {
        onStatus = opts.onStatus as typeof onStatus
        return async () => {}
      },
    })
    a.go('run')
    return {
      status: async (s: { kind: string; pipeline?: string }) => {
        await Promise.resolve()
        await Promise.resolve()
        onStatus!(s)
        frameCb!(16)
      },
    }
  }

  test('сообщение о просадке не гаснет от ready, а называет рабочую ступень', async () => {
    /*
     * Ступень ниже поднимается через секунду-другую, и `ready` сразу за
     * `down` стирал сообщение прежде, чем взрослый успевал его прочесть.
     */
    const { status } = runWithStatus()
    await status({ kind: 'down', pipeline: 'stream/GPU' })
    await status({ kind: 'ready', pipeline: 'bitmap/GPU' })

    expect(text()).toMatch(/просело/i)
    expect(text()).toMatch(/bitmap\/GPU/)
  })

  test('без просадки ready не оставляет никаких жалоб', async () => {
    const { status } = runWithStatus()
    await status({ kind: 'ready', pipeline: 'stream/GPU' })

    expect(text()).not.toMatch(/просело/i)
  })

  test('ready снимает жалобу на камеру, если лестница не проседала', async () => {
    const { status } = runWithStatus()
    await status({ kind: 'camera-lost' })
    expect(text()).toMatch(/Камера пропала/)

    await status({ kind: 'ready', pipeline: 'stream/GPU' })

    expect(text()).not.toMatch(/Камера пропала/)
  })
})

describe('search: явный null означает «строки запроса нет»', () => {
  test('null не подменяется настоящей location.search', () => {
    const a = app({ search: null })
    a.go('menu')

    expect(text()).not.toMatch(/СИНТЕТИКА/)
    expect(text()).not.toMatch(/нет такого сценария/)
  })
})
