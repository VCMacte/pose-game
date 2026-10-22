// @vitest-environment happy-dom
/**
 * Ориентация экранов в оболочке: забег закрепляется горизонтально, меню —
 * портретом, а неудавшийся замок говорит об этом вслух.
 *
 * Прежде `app.orientation()` ТОЛЬКО объявлял ориентацию, и не делал ничего:
 * ни одного потребителя у него не было. Телефон на штативе от этого стоял как
 * поставили — в живом прогоне 22.10.2026 портретом.
 *
 * Разбор: `docs/render-and-layout.md`.
 */
import { beforeEach, describe, expect, test } from 'vitest'

import { startApp } from '../../src/shell/app'
import type { AppDeps } from '../../src/shell/app'
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

function app(over: AppDeps = {}) {
  return startApp(root, {
    settings: makeSettings({ store: memStore() }),
    audio: { cue: () => {}, hit: () => {}, miss: () => {}, neutral: () => {}, setVolume: () => {} },
    raf: () => 0,
    cancelRaf: () => {},
    now: () => 0,
    renderer: () => ({ render: () => {} }),
    startPose: async () => async () => {},
    ...over,
  })
}

/** Несколько тиков: замок — обещание, и оболочка ждёт его исхода. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ориентация экранов', () => {
  test('забег ЗАКРЕПЛЯЕТ горизонтальную ориентацию', async () => {
    const asked: string[] = []
    const a = app({ lockOrientation: async (w) => {
        asked.push(w)
        return { locked: true }
      },
    })
    a.go('run')
    await settle()
    expect(asked).toContain('landscape')
  })

  test('меню закрепляет ПОРТРЕТ, а не остаётся в горизонтальной', async () => {
    // Иначе телефон, вернувшийся из забега в меню, остаётся лежать боком:
    // меню ребёнок читает с телефона в руках.
    const asked: string[] = []
    const a = app({ lockOrientation: async (w) => {
        asked.push(w)
        return { locked: true }
      },
    })
    a.go('run')
    await settle()
    a.go('menu')
    await settle()
    expect(asked[asked.length - 1]).toBe('portrait')
  })

  test('не закрепилось — ПРОСИТ повернуть телефон и пишет это в журнал', async () => {
    /*
     * На iOS замка нет вовсе, во вкладке без жеста он тоже не проходит. Молча
     * играть боком нельзя: картинка уходит на телевизор 16:9, и ребёнок увидит
     * игру в две полосы, не понимая, почему.
     */
    const wrote: Array<Record<string, unknown>> = []
    const a = app({
      write: (e) => void wrote.push({ type: e.type, ...e.data }),
      lockOrientation: async () => ({ locked: false, why: 'замок не разрешён' }),
    })
    a.go('run')
    await settle()

    expect(root.textContent).toMatch(/поверни телефон/i)
    expect(wrote.some((e) => e.type === 'alarm' && /поверни телефон/i.test(String(e.text)))).toBe(true)
  })
})
