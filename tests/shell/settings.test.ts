/**
 * Настройки: перечень значений, живое чтение, блокировка тумблеров и такт по
 * ступени.
 *
 * Хранилище приходит зависимостью — `localStorage` в node нет, а поведение при
 * его отказе (приватный режим, исчерпанная квота) обязано быть «игра
 * играется», а не исключение наружу.
 *
 * Разбор: `docs/menu-and-settings.md`.
 */
import { beforeEach, describe, expect, test } from 'vitest'

import { OPTIONS, makeSettings, nearestLatencyMs, timingsFor, toggleBlocked } from '../../src/adapters/settings'
import { cutouts } from '../../src/core/poses'

/** Хранилище в памяти: то же поведение, что у `localStorage`, без браузера. */
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

/** Хранилище, которое всегда отказывает: приватный режим, кончилась квота. */
const brokenStore = (): Storage =>
  ({
    length: 0,
    clear: () => {
      throw new Error('нет')
    },
    getItem: () => {
      throw new Error('нет')
    },
    key: () => null,
    removeItem: () => {
      throw new Error('нет')
    },
    setItem: () => {
      throw new Error('нет')
    },
  }) as unknown as Storage

describe('перечень значений', () => {
  test('OPTIONS перечисляет значения из спека', () => {
    expect(OPTIONS.durationSec).toEqual([60, 90, 120])
    expect(OPTIONS.tier).toEqual([1, 2, 3])
    expect(OPTIONS.previewMs).toEqual([1500, 2000, 2500, 3000])
    expect(OPTIONS.wallMs).toEqual([1500, 2000, 2500, 3000])
    expect(OPTIONS.verdictMs).toEqual([500, 800, 1200])
    /*
     * Ступени сдвига доходят до 1200 мс, и верхние три — не запас «на всякий
     * случай». Живой замер 22.10.2026 дал медиану 1166 мс: Miracast в
     * неигровом режиме отдаёт около секунды, а перечень, упиравшийся в 400,
     * не позволял выставить измеренное вовсе.
     */
    expect(OPTIONS.latencyMs).toEqual([0, 150, 250, 400, 600, 900, 1200])
    expect(OPTIONS.strictness).toEqual(['soft', 'normal', 'strict'])
    expect(OPTIONS.cameraPreview).toEqual(['on', 'field', 'off'])
  })

  test('порог голосования и длина окна в OPTIONS не вынесены', () => {
    // Это не вкусовые параметры, а следствия измеренной частоты кадров:
    // вынести их в настройки значило бы предложить взрослому подкрутить
    // то, что он не может измерить.
    const keys = Object.keys(OPTIONS)
    expect(keys).not.toContain('voteRatio')
    expect(keys).not.toContain('windowMs')
    expect(keys).not.toContain('minValid')
  })

  test('замеренная задержка кладётся на БЛИЖАЙШУЮ ступень', () => {
    /*
     * Иначе замер остаётся числом на служебном экране, а судит игра по
     * прежней настройке: в живом забеге 22.10.2026 замер дал 1166 мс, а
     * `run.start` ушёл с `latencyMs: 250`.
     */
    expect(nearestLatencyMs(1166)).toBe(1200)
    expect(nearestLatencyMs(230)).toBe(250)
    // Выше всего перечня — верхняя ступень, а не отказ: сдвиг обязан быть.
    expect(nearestLatencyMs(5000)).toBe(1200)
  })

  test('перечень заморожен: подправить его на ходу нельзя', () => {
    expect(Object.isFrozen(OPTIONS)).toBe(true)
    expect(Object.isFrozen(OPTIONS.durationSec)).toBe(true)
  })
})

describe('чтение и запись', () => {
  let s: ReturnType<typeof makeSettings>
  beforeEach(() => {
    s = makeSettings({ store: memStore() })
  })

  test('по умолчанию — значения из перечня, а не undefined', () => {
    expect(OPTIONS.durationSec).toContain(s.get('durationSec'))
    expect(OPTIONS.tier).toContain(s.get('tier'))
    expect(OPTIONS.strictness).toContain(s.get('strictness'))
  })

  test('настройки читаются ЖИВО: записанное видно сразу', () => {
    // Взрослый подкручивает строгость рядом с играющим ребёнком; забег при
    // этом обрывать нельзя, значит значение берётся на каждом раунде заново.
    s.set('strictness', 'strict')
    expect(s.get('strictness')).toBe('strict')
    s.set('strictness', 'soft')
    expect(s.get('strictness')).toBe('soft')
  })

  test('значение вне перечня отвергается, а прежнее остаётся', () => {
    // Иначе одна опечатка в служебном экране уводит забег в состояние,
    // которого в спеке нет вовсе.
    const was = s.get('durationSec')
    expect(s.set('durationSec', 75 as 60)).toBe(false)
    expect(s.get('durationSec')).toBe(was)
  })

  test('запись переживает пересоздание: настройки хранятся, а не живут в памяти', () => {
    const store = memStore()
    makeSettings({ store }).set('tier', 3)
    expect(makeSettings({ store }).get('tier')).toBe(3)
  })

  test('мусор в хранилище не роняет игру: берутся значения по умолчанию', () => {
    const store = memStore()
    store.setItem('pose-game.settings', '{это не json')
    expect(OPTIONS.tier).toContain(makeSettings({ store }).get('tier'))
  })

  test('негодное значение В ХРАНИЛИЩЕ тоже отвергается', () => {
    // Хранилище переживает обновления игры: перечень мог измениться с тех пор.
    const store = memStore()
    store.setItem('pose-game.settings', JSON.stringify({ tier: 9, durationSec: 60 }))
    const fresh = makeSettings({ store })
    expect(OPTIONS.tier).toContain(fresh.get('tier'))
    expect(fresh.get('durationSec')).toBe(60)
  })

  test('отказ хранилища — игра играется, настройки живут сеанс', () => {
    // Приватный режим и исчерпанная квота: ни одного исключения наружу.
    const s2 = makeSettings({ store: brokenStore() })
    expect(() => s2.set('tier', 2)).not.toThrow()
    expect(s2.get('tier')).toBe(2)
    expect(s2.broken).toBe(true)
  })

  test('нет хранилища вовсе — то же самое', () => {
    const s2 = makeSettings({ store: null })
    expect(() => s2.set('tier', 2)).not.toThrow()
    expect(s2.get('tier')).toBe(2)
  })
})

describe('тумблеры словаря', () => {
  test('тумблер, роняющий пул ниже 3 поз, заблокирован', () => {
    // Так выбор следующей позы остаётся чистой функцией и не обзаводится
    // состоянием «пул опустел» — а именно в нём игра либо падает, либо выдаёт
    // одну позу подряд.
    const s = makeSettings({ store: memStore() })
    s.set('tier', 1)

    // Ступень 1 — это фронтальные симметричные; выключать там нечего, но
    // проверка обязана опираться на РЕАЛЬНЫЙ пул, а не на знание о наборе.
    for (const tag of ['crouch', 'lean', 'asymmetric', 'profile', 'one-leg'] as const) {
      const after = cutouts(1, { ...s.toggles(), [tag]: false }).length
      expect(toggleBlocked(s, tag)).toBe(after < 3)
    }
  })

  test('заблокированный тумблер НЕ выключается, а не выключается молча', () => {
    const s = makeSettings({ store: memStore() })
    s.set('tier', 1)
    const blocked = (['crouch', 'lean', 'asymmetric', 'profile', 'one-leg'] as const).filter((t) =>
      toggleBlocked(s, t),
    )
    for (const tag of blocked) {
      expect(s.setToggle(tag, false)).toBe(false)
      expect(s.toggles()[tag]).not.toBe(false)
    }
  })

  test('включить обратно можно ВСЕГДА: включение пул не роняет', () => {
    const s = makeSettings({ store: memStore() })
    s.set('tier', 3)
    for (const tag of ['crouch', 'lean', 'asymmetric', 'profile', 'one-leg'] as const) {
      expect(s.setToggle(tag, true)).toBe(true)
    }
  })

  test('пул при любых допустимых тумблерах не меньше трёх поз', () => {
    // Сам инвариант, а не его проверка по одному тумблеру: перебираются все
    // комбинации, и ни одна достижимая не роняет пул.
    const s = makeSettings({ store: memStore() })
    const tags = ['crouch', 'lean', 'asymmetric', 'profile', 'one-leg'] as const
    for (const tier of [1, 2, 3] as const) {
      s.set('tier', tier)
      for (let mask = 0; mask < 1 << tags.length; mask++) {
        // Воспроизводим только ДОСТИЖИМЫЕ состояния: каждое выключение
        // проходит через `setToggle`, который блокировку и соблюдает.
        const fresh = makeSettings({ store: memStore() })
        fresh.set('tier', tier)
        tags.forEach((t, i) => {
          if (mask & (1 << i)) fresh.setToggle(t, false)
        })
        expect(cutouts(tier, fresh.toggles()).length).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('такт по ступени', () => {
  test('ступень задаёт такт: 1 → 3.0/3.0, 2 → 2.5/2.5, 3 → 2.0/2.0', () => {
    const s = makeSettings({ store: memStore() })
    s.set('tier', 1)
    expect(timingsFor(s).previewMs).toBe(3000)
    expect(timingsFor(s).wallMs).toBe(3000)
    s.set('tier', 3)
    expect(timingsFor(s).previewMs).toBe(2000)
    expect(timingsFor(s).wallMs).toBe(2000)
  })

  test('взрослый перебивает такт ступени, и это видно живо', () => {
    // Иначе настройка такта в экране взрослого не делала бы ничего, а выглядела
    // бы работающей.
    const s = makeSettings({ store: memStore() })
    s.set('tier', 1)
    s.set('previewMs', 1500)
    expect(timingsFor(s).previewMs).toBe(1500)
    expect(timingsFor(s).wallMs).toBe(3000)
  })

  test('сброс к такту ступени возможен: перебивка не навсегда', () => {
    const s = makeSettings({ store: memStore() })
    s.set('tier', 2)
    s.set('previewMs', 1500)
    s.set('previewMs', null)
    expect(timingsFor(s).previewMs).toBe(2500)
  })

  test('сдвиг на задержку попадает в такт, а не теряется', () => {
    const s = makeSettings({ store: memStore() })
    s.set('latencyMs', 250)
    expect(timingsFor(s).latencyMs).toBe(250)
  })
})
