// @vitest-environment happy-dom
/**
 * Экраны: что видит ребёнок, чего он не видит, и как взрослый попадает к себе.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */
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

  test('никакого распознавателя удержания в оболочке не осталось', () => {
    // Сторож против возврата ритуала «заодно, на всякий случай».
    const a = app()
    expect((a as unknown as Record<string, unknown>).longPress).toBeUndefined()
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

  test('кнопка замера задержки есть', () => {
    const a = app()
    a.go('service')
    expect(byTest('measure-latency')).not.toBeNull()
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
