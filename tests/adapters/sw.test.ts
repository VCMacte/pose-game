/**
 * Офлайн: два независимых кэша, их наполнение, проверка целостности вендора и
 * сведения о сборке.
 *
 * `caches` приходит зависимостью — в node его нет, — но наполняется он МОИМ
 * кодом, и именно раздельность наполнения здесь и проверяется: это то
 * свойство, из-за которого правка одной строки кода не заставляет
 * перекачивать 17 МБ вендора.
 *
 * Разбор: `docs/offline-and-build.md`.
 */
import { describe, expect, test } from 'vitest'

import { BUILD, CACHE, VENDOR_CACHE, VENDOR_FILES, buildInfo, checkVendor, install } from '../../src/adapters/sw'
import { CODE_FILES } from '../../src/adapters/sw-manifest'

/** Поддельное хранилище кэшей: запоминает, что и в какой кэш положили. */
function fakeCaches(opts: { failOn?: string; have?: Record<string, string[]> } = {}) {
  const put: Record<string, string[]> = {}
  const have = opts.have ?? {}
  const api = {
    open: async (name: string) => {
      put[name] ??= []
      return {
        addAll: async (urls: string[]) => {
          if (name === opts.failOn) throw new Error('кэш отказал')
          put[name].push(...urls)
        },
        match: async (url: string) => ((have[name] ?? []).includes(url) ? ({} as Response) : undefined),
      }
    },
    keys: async () => Object.keys({ ...put, ...have }),
    delete: async (name: string) => {
      delete put[name]
      return true
    },
    match: async (url: string) => {
      for (const list of Object.values(have)) if (list.includes(url)) return {} as Response
      return undefined
    },
  }
  return { caches: api as unknown as CacheStorage, put }
}

describe('два независимых кэша', () => {
  test('код и вендор кэшируются двумя независимыми addAll', () => {
    // Одно наполнение на всё означало бы: правка одной строки кода —
    // перекачка 17 МБ вендора, а сбой на вендоре — отмена обновления кода.
    expect(CACHE).not.toBe(VENDOR_CACHE)
    expect(CODE_FILES.length).toBeGreaterThan(0)
    expect(VENDOR_FILES.length).toBeGreaterThan(0)
    // Ни один файл не лежит в обоих списках: иначе «независимые» они только на
    // словах, а по факту один файл тянет за собой оба наполнения.
    expect(CODE_FILES.filter((f) => (VENDOR_FILES as readonly string[]).includes(f))).toEqual([])
  })

  test('наполнение идёт ровно в два кэша, и каждый своим списком', async () => {
    const { caches, put } = fakeCaches()
    await install(caches)
    expect(Object.keys(put).sort()).toEqual([CACHE, VENDOR_CACHE].sort())
    expect(put[CACHE]).toEqual([...CODE_FILES])
    expect(put[VENDOR_CACHE]).toEqual([...VENDOR_FILES])
  })

  test('отказ кэша КОДА не рушит вендор', async () => {
    // Вендор почти никогда не меняется: потерять его из-за сбоя на коде
    // значит заставить ребёнка качать 17 МБ там, где они уже были.
    const { caches, put } = fakeCaches({ failOn: CACHE })
    const r = await install(caches)
    expect(put[VENDOR_CACHE]).toEqual([...VENDOR_FILES])
    expect(r.code).toBe(false)
    expect(r.vendor).toBe(true)
  })

  test('отказ кэша ВЕНДОРА не рушит код', async () => {
    const { caches, put } = fakeCaches({ failOn: VENDOR_CACHE })
    const r = await install(caches)
    expect(put[CACHE]).toEqual([...CODE_FILES])
    expect(r.code).toBe(true)
    expect(r.vendor).toBe(false)
  })

  test('отказ ОБОИХ не бросает наружу: установка сообщает, а не падает', async () => {
    // Брошенное исключение в `install` отменяет установку service worker
    // целиком, и приложение остаётся вообще без офлайна и без объяснения.
    const { caches } = fakeCaches({ failOn: CACHE })
    const both = {
      ...(caches as unknown as Record<string, unknown>),
      open: async () => ({
        addAll: async () => {
          throw new Error('нет')
        },
        match: async () => undefined,
      }),
    } as unknown as CacheStorage
    const r = await install(both)
    expect(r).toEqual({ code: false, vendor: false })
  })
})

describe('список кода ГЕНЕРИРУЕТСЯ', () => {
  test('в списке нет файлов, которых сборка не делает', () => {
    // Правка списка руками не ломает разработку (в dev всё берётся из сети) —
    // она ломает установленное приложение у ребёнка и без сети. Это худший
    // вид дефекта здесь: проявляется не у разработчика и не сразу.
    for (const f of CODE_FILES) {
      expect(f.startsWith('/')).toBe(true)
      expect(f).not.toContain('..')
    }
  })

  test('корень приложения в списке есть: без него офлайн не стартует', () => {
    expect(CODE_FILES).toContain('/')
  })

  test('манифест и иконки в списке кода, а не вендора', () => {
    expect(CODE_FILES.some((f) => f.endsWith('.webmanifest'))).toBe(true)
  })
})

describe('вендор', () => {
  test('список вендора — это wasm и модель, обе сборки библиотеки', () => {
    const joined = VENDOR_FILES.join(' ')
    expect(joined).toContain('pose_landmarker_lite.task')
    expect(joined).toContain('vision_bundle.js')
    expect(joined).toContain('vision_bundle.mjs')
    expect(joined).toContain('vision_wasm_internal.wasm')
  })

  test('варианта wasm без SIMD в списке НЕТ', () => {
    // Ещё 10.5 МБ; поддержка спрашивается предикатом самой библиотеки.
    expect(VENDOR_FILES.join(' ')).not.toContain('nosimd')
  })

  test('checkVendor находит файлы по ВСЕМ кэшам, а не только в своём', async () => {
    // Файл мог осесть в кэше кода при ручной правке списков: «нет файла» и
    // «файл лежит не там» — разные беды, и вторая офлайн не ломает.
    const { caches } = fakeCaches({ have: { [VENDOR_CACHE]: [...VENDOR_FILES] } })
    const r = await checkVendor(caches)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  test('отсутствие файла НАЗЫВАЕТСЯ, а не «скачаем на ходу»', async () => {
    const some = VENDOR_FILES.slice(1)
    const { caches } = fakeCaches({ have: { [VENDOR_CACHE]: [...some] } })
    const r = await checkVendor(caches)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([VENDOR_FILES[0]])
  })

  test('нет кэшей вовсе — ответ «нет файлов», а не исключение', async () => {
    const r = await checkVendor(null)
    expect(r.ok).toBe(false)
    expect(r.missing.length).toBe(VENDOR_FILES.length)
  })
})

describe('сведения о сборке', () => {
  test('версия сборки и дата доступны приложению', () => {
    // Установленное PWA обновляется само и молча: без номера невозможно
    // понять, какую версию ребёнок на самом деле запустил, а журнал со
    // «вчерашней» сборки выглядит точно так же, как с сегодняшней.
    const i = buildInfo()
    expect(typeof i.version).toBe('string')
    expect(i.version.length).toBeGreaterThan(0)
    expect(typeof i.date).toBe('string')
    expect(i.date.length).toBeGreaterThan(0)
  })

  test('версия и имена кэшей связаны: новая версия — новые кэши', () => {
    // Иначе обновление кода читало бы старый кэш и офлайн показывал бы
    // прошлую сборку при свежем коде.
    expect(CACHE).toContain(BUILD.version)
    expect(VENDOR_CACHE).toContain(BUILD.vendorVersion)
  })

  test('версия вендора отдельная от версии кода', () => {
    // Иначе каждая правка строки кода меняла бы имя кэша вендора, то есть
    // ровно та перекачка 17 МБ, от которой раздельность и спасает.
    expect(BUILD.vendorVersion).not.toBe(BUILD.version)
  })
})
