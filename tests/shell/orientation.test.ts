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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('отказ замка НЕ пишет тревогу: о повороте говорит CSS, а не рапорт', () => {
    /*
     * Урок `run-game`: подсказка про поворот живёт на CSS, по
     * `@media (orientation: portrait)`, и от успеха замка НЕ зависит. Замок
     * способен отрапортовать успех на всё ещё портретном экране и отказать
     * на уже горизонтальном — тревога по его ответу врала бы в обе стороны.
     */
    const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')
    // Правило показа привязано к ОРИЕНТАЦИИ экрана, а не к классу, который
    // ставил бы код: иначе ответ замка всё равно решал бы, видно ли подсказку.
    expect(html).toMatch(/@media\s*\(orientation:\s*portrait\)[\s\S]{0,200}\.rotate/)

    // А сама подсказка на экране забега есть всегда — её прячет только стиль.
    const a = app()
    a.go('run')
    expect(root.querySelector('[data-test="rotate"]')).not.toBeNull()
  })

  test('возврат видимости ЗАНОВО просит замок ориентации', async () => {
    /*
     * Измерено в `run-game` 14.10: будильник увёл страницу в `hidden`, и на
     * возврате сорвался полный экран, а за ним повернулся кадр камеры в
     * портрет — забег встал ложной паузой на 13.5 секунды. Полный экран они
     * возвращают на каждом удобном событии, а ОРИЕНТАЦИЮ не возвращают вовсе:
     * это их незакрытая дыра, и закрывается она здесь.
     */
    const asked: string[] = []
    const a = app({
      lockOrientation: async (w) => {
        asked.push(w)
        return { locked: true }
      },
    })
    a.go('run')
    await settle()
    const afterGo = asked.length

    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(asked.length).toBeGreaterThan(afterGo)
    // Просится ориентация ТЕКУЩЕГО экрана, а не та, с которой уходили.
    expect(asked[asked.length - 1]).toBe('landscape')
  })

  test('остановленное приложение видимость больше не слушает', async () => {
    /*
     * Слушатель висит на `document`, а приложений за сессию несколько (тесты,
     * пересоздание). Не снятый, он пишет в журнал от имени уже погашенного
     * приложения и держит его замыкание живым.
     */
    const wrote: Array<Record<string, unknown>> = []
    const a = app({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    a.go('run')
    a.stop()
    const before = wrote.filter((e) => e.type === 'visibility').length

    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(wrote.filter((e) => e.type === 'visibility').length).toBe(before)
  })

  test('уход страницы из видимости пишется в журнал', async () => {
    /*
     * Страница уходит в `hidden` не только от сна экрана: в `run-game` это
     * сделал БУДИЛЬНИК — и вместе с видимостью сорвался полный экран и
     * повернулся кадр. Без записи такой эпизод в выгрузке неотличим от
     * необъяснимой паузы.
     */
    const wrote: Array<Record<string, unknown>> = []
    const a = app({ write: (e) => void wrote.push({ type: e.type, ...e.data }) })
    a.go('run')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    const seen = wrote.find((e) => e.type === 'visibility')
    expect(seen).toBeDefined()
    expect(seen!.state).toBe('visible')
  })
})
