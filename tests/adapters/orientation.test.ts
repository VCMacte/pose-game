/**
 * Замок ориентации: забег горизонтальный, меню портретное.
 *
 * **Порядок и сроки здесь не выдуманы, а перенесены из `run-game`** — того же
 * телефона и той же трансляции на телевизор. Три его вывода:
 *
 * 1. `lock()` на Android без полноэкранного режима просто отказывает, поэтому
 *    полный экран просится ПЕРЕД замком;
 * 2. ориентация просится ДАЖЕ если полный экран отказал — кнопка «Назад» не
 *    даёт жеста, `requestFullscreen()` отклоняется, и забег открывался бы
 *    вертикальной вёрсткой;
 * 3. любое из этих обещаний может не завершиться НИКОГДА, отсюда сроки.
 *
 * У установленного приложения полный экран — режим окна, а не состояние, и
 * просить его там нечего.
 *
 * Разбор: `docs/render-and-layout.md`.
 */
import { describe, expect, test } from 'vitest'

import { ORIENTATION, lockOrientation } from '../../src/adapters/orientation'

/** Поддельный браузер: порядок вызовов и управляемые отказы. */
function fake(
  opts: { lockFails?: boolean; fullscreenFails?: boolean; lockHangs?: boolean; installed?: boolean } = {},
) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      installed: opts.installed ?? false,
      lock: (want: string): Promise<void> => {
        calls.push(`lock:${want}`)
        if (opts.lockHangs) return new Promise<void>(() => {})
        return opts.lockFails ? Promise.reject(new Error('замок отказан')) : Promise.resolve()
      },
      fullscreen: (): Promise<void> => {
        calls.push('fullscreen')
        return opts.fullscreenFails ? Promise.reject(new Error('полный экран отказан')) : Promise.resolve()
      },
    },
  }
}

describe('замок ориентации', () => {
  test('полный экран просится ПЕРЕД замком', async () => {
    const f = fake()
    const r = await lockOrientation('landscape', f.deps)
    expect(f.calls).toEqual(['fullscreen', 'lock:landscape'])
    expect(r.locked).toBe(true)
  })

  test('отказ полного экрана НЕ отменяет просьбу об ориентации', async () => {
    /*
     * Урок `run-game`: кнопка «Назад» телефона не даёт жеста, без жеста
     * `requestFullscreen()` отклоняется — и забег открывался бы вертикальной
     * вёрсткой, потому что замок просто не запрашивался.
     */
    const f = fake({ fullscreenFails: true })
    const r = await lockOrientation('landscape', f.deps)
    expect(f.calls).toEqual(['fullscreen', 'lock:landscape'])
    expect(r.locked).toBe(true)
  })

  test('установленному приложению полный экран не нужен: это режим окна', async () => {
    const f = fake({ installed: true })
    await lockOrientation('landscape', f.deps)
    expect(f.calls).toEqual(['lock:landscape'])
  })

  test('отказ замка — НЕ исключение наружу', async () => {
    // На iOS замка нет вовсе, и игра обязана играться и там. Экран скажет о
    // повороте сам, подсказкой на CSS, — от этого ответа она не зависит.
    const f = fake({ lockFails: true })
    const r = await lockOrientation('landscape', f.deps)
    expect(r.locked).toBe(false)
    expect(r.why).toMatch(/замок/i)
  })

  test('зависшее обещание кончается СРОКОМ, а не висит вечно', async () => {
    /*
     * «Любое обещание разрешений, полного экрана и ориентации может не
     * завершиться никогда» — измерено в `run-game`, где без срока приложение
     * вставало на экране загрузки.
     */
    const f = fake({ lockHangs: true })
    const r = await lockOrientation('landscape', f.deps, { lockMs: 20 })
    expect(r.locked).toBe(false)
    expect(r.why).toMatch(/нет ответа/i)
  })

  test('ориентация экранов перечислена ОДНИМ местом', () => {
    // Запасной план `run-game`, если поэкранная смена окажется ненадёжной:
    // сделать всё горизонтальным — это одна таблица, а не семь мест в коде.
    expect(ORIENTATION.run).toBe('landscape')
    expect(ORIENTATION.menu).toBe('portrait')
    expect(ORIENTATION.settings).toBe('portrait')
    expect(ORIENTATION.service).toBe('portrait')
  })
})
