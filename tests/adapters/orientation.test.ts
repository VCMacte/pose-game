/**
 * Замок ориентации: забег горизонтальный ПРИНУДИТЕЛЬНО, меню портретное.
 *
 * Прежде ориентация только ОБЪЯВЛЯЛАСЬ (`app.orientation()`), и не действовало
 * ничего: телефон на штативе отдавал портретный кадр, а экран забега считал
 * себя горизонтальным. В живом прогоне 22.10.2026 камера так и дала 360×640.
 *
 * Браузер и его отказы приходят ЗАВИСИМОСТЬЮ: `screen.orientation` в node нет,
 * а проверяется именно поведение при отказе — он здесь норма, не исключение.
 *
 * Разбор: `docs/render-and-layout.md`.
 */
import { describe, expect, test } from 'vitest'

import { lockOrientation } from '../../src/adapters/orientation'

/** Поддельный браузер: замок и полный экран с управляемым исходом. */
function fake(opts: { lockFails?: number; fullscreenFails?: boolean } = {}) {
  const calls: string[] = []
  let left = opts.lockFails ?? 0
  return {
    calls,
    deps: {
      lock: async (want: string): Promise<void> => {
        calls.push(`lock:${want}`)
        if (left > 0) {
          left -= 1
          throw new Error('замок не разрешён вне полного экрана')
        }
      },
      fullscreen: async (): Promise<void> => {
        calls.push('fullscreen')
        if (opts.fullscreenFails) throw new Error('полный экран отказан')
      },
    },
  }
}

describe('замок ориентации', () => {
  test('закрепляет запрошенную ориентацию', async () => {
    const f = fake()
    const r = await lockOrientation('landscape', f.deps)
    expect(r.locked).toBe(true)
    expect(f.calls).toEqual(['lock:landscape'])
  })

  test('отказ замка — повод попросить полный экран и повторить', async () => {
    /*
     * Chrome не даёт закрепить ориентацию странице, которая не на полном
     * экране. В установленном приложении (`display: fullscreen`) замок обычно
     * проходит сразу, во вкладке — только после `requestFullscreen`, а он
     * требует жеста. Поэтому полный экран просится ПОСЛЕ первого отказа, на
     * том же нажатии «ИГРАТЬ», а не вместо замка.
     */
    const f = fake({ lockFails: 1 })
    const r = await lockOrientation('landscape', f.deps)
    expect(r.locked).toBe(true)
    expect(f.calls).toEqual(['lock:landscape', 'fullscreen', 'lock:landscape'])
  })

  test('отказали оба — это НЕ исключение наружу', async () => {
    /*
     * Игра обязана играться и на телефоне, где закрепить ориентацию нельзя
     * (так ведёт себя iOS целиком). Исход сообщается значением, чтобы
     * оболочка могла попросить взрослого повернуть телефон сама.
     */
    const f = fake({ lockFails: 9, fullscreenFails: true })
    const r = await lockOrientation('landscape', f.deps)
    expect(r.locked).toBe(false)
    expect(r.why).toMatch(/замок|экран/i)
  })

  test('меню просит ПОРТРЕТ: ориентация поэкранная, а не на всё приложение', async () => {
    const f = fake()
    const r = await lockOrientation('portrait', f.deps)
    expect(r.locked).toBe(true)
    expect(f.calls).toEqual(['lock:portrait'])
  })
})
