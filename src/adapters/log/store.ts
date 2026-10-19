/**
 * Журнал событий: пишется на телефон, выгружается файлом, разбирается потом.
 *
 * Зачем вообще: телефон стоит на штативе в комнате ребёнка, консоли у него нет,
 * а необработанное исключение выглядит снаружи просто как «игра зависла».
 * Ребёнок не расскажет, что случилось, а переигрывать спорный раунд с ним ради
 * диагноза — это и есть то, чего проект избегает. Поэтому журнал — единственный
 * диагностический аппарат проекта: чего в нём нет, того не было. Вывод в
 * консоль браузера в `src/` не используется нигде (сторож — tests/boundaries),
 * и даже упомянуть его здесь нельзя иначе как словами: сторож смотрит текстом.
 *
 * Почему IndexedDB, а не `localStorage`: у второго около пяти мегабайт и
 * синхронный доступ, то есть каждая запись подвешивает кадр — ровно то, что мы
 * и собираемся измерять.
 *
 * Почему сброс на диск раз в две секунды, а не в конце забега: самые ценные
 * записи — те, после которых приложение умерло. Их в памяти не остаётся.
 *
 * Почему наружу не летит ни одного исключения: недоступная база (приватный
 * режим, исчерпанная квота, отказ открытия) не имеет права помешать игре
 * играться. Отказ поднимает `broken`, журнал молча выключается, игра идёт.
 *
 * Разбор: docs/log-and-storage.md
 */

import type { Landmarks } from '../../core/types'

/**
 * Потолки журнала. Числа — из `docs/log-and-storage.md`; менять их здесь и в
 * теме одним изменением.
 */
export const LIMITS = Object.freeze({
  /** 25 МБ на всю базу: через месяц без потолка телефон ребёнка забит журналами. */
  bytes: 25 * 1024 * 1024,
  /** Сессий приложения, не забегов. */
  sessions: 20,
  flushMs: 2000,
  /**
   * Сколько одинаковых событий подряд склеивать в одну запись.
   *
   * Без склейки один залипший признак даёт тысячи записей за минуту, а потолки
   * работают ЦЕЛЫМИ сессиями — то есть один дефект вытесняет из журнала
   * свидетельства всех прошлых сессий.
   *
   * Склейка не бесконечная: после `repeat` повторов копится следующая запись.
   * Так видно, что поток продолжается, а не кончился, — иначе по журналу нельзя
   * отличить «упало 500 раз» от «упало 500 раз и падает до сих пор».
   */
  repeat: 500,
  /**
   * Байт в очереди, после которых сброс не ждёт `flushMs`, а назначается сразу.
   *
   * Очередь — единственное место журнала, которое ничем не ограничено: между
   * двумя сбросами в неё помещается сколько угодно. Обычные две секунды игры —
   * это десятки килобайт (агрегат раз в секунду, события раунда), и даже пара
   * всплесков строк скелета (по ~40 КБ) порога не достают: он для потока,
   * которого никто не предвидел. Сброс при этом всё равно откладывается на
   * таймер — покадровый путь в базу не ходит ни при каких обстоятельствах.
   */
  queueBytes: 256 * 1024,
  /** Строк скелета в кольце — окно судейства целиком, а не пара кадров. */
  rawLines: 45,
  /** Всплесков строк скелета ЗА ЗАБЕГ: пишутся только спорные моменты. */
  rawBursts: 8,
  /**
   * Оценка одной строки скелета в байтах (132 числа с тремя знаками). Нужна
   * ровно затем, чтобы бюджет всплесков был посчитан, а не на глаз:
   * `rawBursts × rawLines × rawLineBytes` обязан оставаться в пределах 5%
   * потолка, иначе сырые строки вытеснят приговоры, ради которых всё и затеяно.
   */
  rawLineBytes: 800,
})

/** Конверт записи до попадания в журнал: `t` приставляет сам журнал. */
export type LogEvent = { type: string; data: object }

/** Почему записан всплеск строк скелета. `debug` — сплошная запись тумблером. */
export type RawWhy = 'miss' | 'pause' | 'debug'

/** Чем кончилось системное «Поделиться». */
export type Shared = 'shared' | 'cancelled' | 'failed' | 'unavailable'

export type SaveResult = {
  name: string
  bytes: number
  /** Файл отдан браузеру. `true` не значит «лёг на диск»: см. `sweepExported`. */
  saved: boolean
  shared: Shared
  sessions: number
  broken: boolean
}

export type Status = {
  broken: boolean
  /**
   * Удалось ли прочитать базу. `false` значит «не читается», а не «пусто»:
   * `sessions: 0` у обеих одинаков, и без этого поля вызывающий не отличит
   * честный пустой журнал от того, чья сводка сейчас недостоверна. Отказ
   * чтения не поднимает `broken` (см. `broken` там же) — сама запись цела,
   * недостоверна только ЭТА сводка. Нужно в первую очередь служебному экрану
   * задачи 19: родитель обязан узнать «журнал не читается», а не увидеть
   * молчаливый ноль, который неотличим от реально пустого журнала.
   */
  readable: boolean
  sessions: number
  events: number
  bytes: number
  /** Доля занятого потолка: по ней экран настроек показывает заполнение. */
  share: number
  from: string | null
  to: string | null
}

/**
 * Всё, что журнал берёт из окружения. Подменяется в тестах и в инструментах
 * разбора: иначе «база отказала» и «часы пошли назад» проверить нечем.
 */
export type JournalDeps = {
  /** Монотонные часы, мс. По умолчанию `performance.now()`. */
  now: () => number
  /** Настенные часы для имён файлов и отметок сессии. По умолчанию `Date.now()`. */
  wall: () => number
  /** `null` — IndexedDB в этом окружении нет вовсе. */
  idb: IDBFactory | null
  dbName: string
  /** Сессия — один запуск приложения. По умолчанию — настенное время старта. */
  sessionId: number
  ua: string
  /** Скачивание файлом. Возвращает `false`, если браузер отказал сразу. */
  download: (blob: Blob, name: string) => boolean
  canShare: (files: File[]) => boolean
  share: (files: File[], text: string) => Promise<void>
}

export type Journal = {
  readonly sessionId: number
  /** База отказала — журнал выключился сам, игра идёт дальше. */
  readonly broken: boolean
  /** Событий в очереди на сброс. Для тестов и экрана настроек. */
  readonly queued: number
  event(type: string, data?: object): void
  /** То же, но готовым конвертом из `events.ts` — путь для типизированных событий. */
  write(e: LogEvent): void
  flush(): Promise<void>
  /** Сколько сессий удалено. При отказе базы — 0, без исключения. */
  trim(): Promise<number>
  status(): Promise<Status>
  save(): Promise<SaveResult>
  sweepExported(): Promise<{ sessions: number; marked: number; bytes: number }>
  clear(): Promise<void>
  /** Строка скелета в кольцевой буфер. Кадр без скелета пропускается. */
  rawPush(t: number, lm: Landmarks | null): void
  /** Выгрузить кольцо всплеском, если бюджет забега не исчерпан. */
  rawBurst(why: RawWhy): void
  /** Новый забег: бюджет всплесков и кольцо с нуля. */
  rawReset(): void
}

const DB_VERSION = 1

const encoder = new TextEncoder()

/** Размер записи в байтах. Несчитаемое (цикл в данных) считается нулём. */
function bytesOf(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

/**
 * Отпечаток события: всё, кроме времени и полей конверта.
 *
 * Сравнение по ПОЛЯМ, а не по типу: две разные ошибки склеивать нельзя — из
 * журнала исчезла бы вторая. Сериализацией, а не обходом: поля вложенные
 * (`perAxis`, `lines`), и глубокое сравнение было бы второй копией логики
 * сравнения в проекте.
 *
 * Поля конверта названы с подчёркиванием не для красоты: `n` в полезной
 * нагрузке занято (`health`, всплески), и счётчик повторов с тем же именем
 * затирал бы её молча.
 *
 * Экспортируется ради проверки: очередь приватна, а решение «это тот же поток
 * или новый» обязано быть под тестом.
 */
export function eventKey(e: object): string | null {
  try {
    const { t: _t, _n, _lastT, ...rest } = e as Record<string, unknown>
    void _t
    void _n
    void _lastT
    return JSON.stringify(rest)
  } catch {
    return null
  }
}

/** Одинаковы ли два события с точностью до времени и счётчика повторов. */
export function sameEvent(a: object | null | undefined, b: object | null | undefined): boolean {
  if (!a || !b) return false
  if ((a as { type?: unknown }).type !== (b as { type?: unknown }).type) return false
  const ka = eventKey(a)
  return ka != null && ka === eventKey(b)
}

/**
 * Имена, которые полезная нагрузка не имеет права занять.
 *
 * `t` и `type` — конверт, `session` приставляется при записи, `k` — keyPath
 * стора событий, `_n`/`_lastT` — склейка. Поля склейки названы с подчёркиванием
 * затем, что `n` в нагрузке занято; но `t`, `type` и `k` имена ходовые, и
 * событие с полем `t` молча затирало бы время записи — то есть журнал
 * сообщал бы неправду именно там, где его читают. Поэтому нагрузка
 * обрезается, а не доспоривает с конвертом.
 *
 * Единственная копия списка — здесь. `RESERVED_KEYS` экспортируется ради
 * `tests/adapters/log-events-reserved.test-d.ts`: статическая проверка
 * конструкторов `events.ts` берёт список отсюда, а не ретипирует его заново.
 */
export const RESERVED_KEYS = ['t', 'type', 'k', 'session', '_n', '_lastT'] as const
const RESERVED = new Set<string>(RESERVED_KEYS)

/** Запись в очереди: конверт плюс поля склейки. */
type Queued = { t: number; type: string; _n?: number; _lastT?: number } & Record<string, unknown>

const ask = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

/**
 * Курсор продвигается в собственном `onsuccess`: `continue()` ничего не
 * возвращает, результат приходит в тот же запрос.
 */
function dropEvents(store: IDBObjectStore, index: IDBIndex, session: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = index.openKeyCursor(IDBKeyRange.only(session))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve()
        return
      }
      store.delete(cursor.primaryKey)
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })
}

/** Скачивание файлом — по умолчанию через невидимую ссылку. */
function browserDownload(blob: Blob, name: string): boolean {
  try {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    return true
  } catch {
    return false
  }
}

type ShareNavigator = Navigator & {
  canShare?: (data: { files: File[] }) => boolean
  share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>
}

const shareNav = (): ShareNavigator | undefined =>
  (globalThis as { navigator?: ShareNavigator }).navigator

/**
 * Журнал на заданном окружении.
 *
 * Модуль держит один журнал по умолчанию (экспорты ниже) — его и зовёт игра.
 * Фабрика нужна тестам и инструментам: подменить часы, базу и пути выгрузки.
 */
export function makeJournal(over: Partial<JournalDeps> = {}): Journal {
  const wall = over.wall ?? (() => Date.now())
  const deps: JournalDeps = {
    now: over.now ?? (() => performance.now()),
    wall,
    // `undefined` значит «возьми из окружения», `null` — «её тут нет вовсе».
    idb: over.idb !== undefined ? over.idb : ((globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null),
    dbName: over.dbName ?? 'pose-game-log',
    sessionId: over.sessionId ?? wall(),
    ua: over.ua ?? shareNav()?.userAgent ?? 'unknown',
    download: over.download ?? browserDownload,
    canShare:
      over.canShare ??
      ((files) => {
        try {
          const nav = shareNav()
          return Boolean(nav?.canShare?.({ files }) && nav.share)
        } catch {
          return false
        }
      }),
    share: over.share ?? ((files, text) => shareNav()!.share!({ files, title: 'Журнал «Стены с позами»', text })),
  }

  // Сессия — один запуск приложения, а не один забег: падение приложения тем и
  // примечательно, что забег после него не закончился, и привязывать записи к
  // забегу значило бы терять ровно интересные случаи.
  const { sessionId } = deps
  const startedAt = new Date(sessionId).toISOString()
  const t0 = deps.now()

  let queue: Queued[] = []
  /** Отпечаток последней записи в очереди: иначе две сериализации на событие. */
  let prevKey: string | null = null
  let queuedBytes = 0
  let lastT = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Назначенный сброс — срочный (по порогу очереди), а не обычный по таймеру. */
  let urgent = false
  let broken = false
  let dbPromise: Promise<IDBDatabase> | null = null

  /** Кольцо строк скелета и бюджет всплесков текущего забега. */
  let ring: { t: number; v: number[] }[] = []
  let bursts = 0

  function cancelTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
    urgent = false
  }

  /**
   * Назначает сброс. Уже назначенный переставляется только на более ранний
   * срок: порог очереди обязан уметь поторопить таймер, а обычное событие —
   * не обязано отодвигать уже назначенный срочный сброс.
   */
  function armFlush(ms: number): void {
    if (timer !== null) {
      if (ms !== 0 || urgent) return
      clearTimeout(timer)
      timer = null
    }
    urgent = ms === 0
    timer = setTimeout(() => {
      void flush()
    }, ms)
    // В node таймер не должен держать прогон тестов живым.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function open(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      /* Отказ ОТКРЫТИЯ — это и есть «база непригодна»: приватный режим,
         исчерпанная квота, запрет хранения. Только здесь и при обрыве
         readwrite-транзакции (см. `rw`) поднимается `broken`; отказ отдельной
         операции чтения журнал не выключает, иначе взгляд на диагностику
         выключал бы диагностику. */
      const fail = (err: unknown): void => {
        broken = true
        reject(err)
      }
      try {
        if (!deps.idb) {
          fail(new Error('IndexedDB недоступна'))
          return
        }
        const req = deps.idb.open(deps.dbName, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' })
          if (!db.objectStoreNames.contains('events')) {
            db.createObjectStore('events', { keyPath: 'k', autoIncrement: true }).createIndex('session', 'session')
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => fail(req.error)
      } catch (err) {
        // На некоторых сборках `open()` бросает прямо, не отвечая запросом с ошибкой.
        fail(err)
      }
    })
    return dbPromise
  }

  /**
   * Readwrite-транзакция с наблюдателем за обрывом.
   *
   * Обрыв транзакции записи — второе (и последнее) доказательство того, что
   * база непригодна: записать не удалось. Наблюдатель ставится при создании, а
   * не при ожидании завершения, иначе отказ, случившийся до `done(tx)`, остался
   * бы незамеченным.
   */
  function rw(db: IDBDatabase, stores: string[]): IDBTransaction {
    const tx = db.transaction(stores, 'readwrite')
    tx.addEventListener('abort', () => {
      broken = true
    })
    return tx
  }

  /** Записей в очереди с учётом склейки: залипшее событие — это `_n`, а не одна. */
  function pending(): number {
    let n = 0
    for (const e of queue) n += e._n ?? 1
    return n
  }

  /**
   * Конверт записи: `t` и `type` впереди, за ними поля данных.
   *
   * Нагрузка кладётся ПОСЛЕ конверта по имени, а не разворотом поверх него:
   * иначе событие с полем `type` или `t` подменило бы конверт собой.
   */
  function envelope(t: number, type: string, data?: object): Queued {
    const e: Record<string, unknown> = { t, type }
    if (data) {
      for (const k in data) {
        if (!RESERVED.has(k)) e[k] = (data as Record<string, unknown>)[k]
      }
    }
    return e as Queued
  }

  /** Ставит событие в очередь. Никогда не бросает: журнал не роняет игру. */
  function event(type: string, data?: object): void {
    if (broken) return
    const t = Math.max(lastT, Math.round(deps.now() - t0))
    lastT = t
    const e = envelope(t, type, data)

    /* Повтор подряд — не новая запись, а счётчик у прошлой. Склейка живёт
       здесь, в общем месте, а не у вызывающих: непредвиденный поток событий —
       это и есть тот случай, который журнал обязан выдержать, и предвидеть его
       у каждого вызывающего по отдельности нельзя по определению.

       `t` первой записи не меняется: по нему видно, когда поток начался.
       `_lastT` говорит, когда пришёл последний повтор, иначе длительность
       потока по журналу не восстановить. */
    const prev = queue[queue.length - 1]
    const key = eventKey(e)
    if (prev && key != null && key === prevKey && (prev._n ?? 1) < LIMITS.repeat) {
      prev._n = (prev._n ?? 1) + 1
      prev._lastT = t
      return
    }

    queue.push(e)
    prevKey = key
    /* Байты считаются по уже готовому отпечатку, а не второй сериализацией:
       худшая запись — всплеск строк скелета, 45 x 132 числа, около 40 КБ JSON,
       и приходит она ровно в тот момент (провал раунда, пауза), длительность
       которого журнал и заведён измерять. Отпечаток не содержит `t`, `_n` и
       `_lastT`, то есть счёт идёт с недостачей в десяток байт на запись —
       оценка и так ниже занятого места на диске (docs/log-and-storage.md). */
    queuedBytes += key?.length ?? 0
    // Очередь переросла порог — сброс не ждёт двух секунд, но и не пишет здесь.
    armFlush(queuedBytes >= LIMITS.queueBytes ? 0 : LIMITS.flushMs)
  }

  async function flush(): Promise<void> {
    cancelTimer()
    if (broken || queue.length === 0) return

    const batch = queue
    queue = []
    prevKey = null
    queuedBytes = 0

    try {
      const db = await open()
      const bytes = bytesOf(batch)
      const tx = rw(db, ['events', 'sessions'])
      const events = tx.objectStore('events')
      for (const e of batch) events.add({ ...e, session: sessionId })

      const sessions = tx.objectStore('sessions')
      const prev = (await ask(sessions.get(sessionId))) as { events?: number; bytes?: number } | undefined
      sessions.put({
        id: sessionId,
        startedAt,
        ua: deps.ua,
        events: (prev?.events ?? 0) + batch.length,
        bytes: (prev?.bytes ?? 0) + bytes,
        updatedAt: new Date(deps.wall()).toISOString(),
      })
      await done(tx)
      await trimUnsafe()
    } catch {
      /* Записать не удалось. `broken` здесь не ставится руками: его поднимает
         отказ `open()` или обрыв readwrite-транзакции — то есть ровно
         непригодность базы. Отказ одной операции (скажем, `DataError` на
         чтении счётчиков сессии) стоит партии записей, но не журнала: иначе
         один сбой выключал бы диагностику до конца сессии молча. */
    }
  }

  /**
   * Чистка по двум условиям сразу: больше `sessions` сессий или больше `bytes`
   * байт. Удаляются всегда самые старые: свежая запись полезнее, а падение,
   * которое разбирают, случилось только что.
   *
   * Текущая сессия не удаляется никогда: иначе журнал съест сам себя на длинном
   * забеге и останется пустым ровно тогда, когда нужен.
   */
  async function trimUnsafe(): Promise<number> {
    const db = await open()
    const tx = rw(db, ['sessions', 'events'])
    const sessions = tx.objectStore('sessions')
    const all = ((await ask(sessions.getAll())) as { id: number; bytes?: number }[]).sort((a, b) => a.id - b.id)

    let total = all.reduce((s, x) => s + (x.bytes ?? 0), 0)
    const doomed: { id: number; bytes?: number }[] = []

    for (const s of all) {
      if (s.id === sessionId) continue
      if (all.length - doomed.length <= LIMITS.sessions && total <= LIMITS.bytes) break
      doomed.push(s)
      total -= s.bytes ?? 0
    }

    if (doomed.length) {
      const store = tx.objectStore('events')
      const index = store.index('session')
      for (const s of doomed) {
        sessions.delete(s.id)
        await dropEvents(store, index, s.id)
      }
    }
    await done(tx)
    return doomed.length
  }

  async function trim(): Promise<number> {
    if (broken) return 0
    try {
      return await trimUnsafe()
    } catch {
      // Чистка не удалась — потолок подождёт следующего сброса. Запись цела.
      return 0
    }
  }

  /**
   * Сводка для служебного экрана.
   *
   * Экран этот родитель открывает именно тогда, когда что-то не так, поэтому
   * отказ ЧТЕНИЯ здесь не поднимает `broken`: иначе один взгляд на диагностику
   * выключал бы запись до конца сессии. Не прочитав базу, отдаём то, что знаем
   * наверняка — очередь в памяти, — и `broken` как он есть.
   */
  async function status(): Promise<Status> {
    // И при `broken`, и при отказе самого чтения сводка одинаково
    // недостоверна («не читается», а не «пусто») — `readable: false` здесь
    // общее для обеих причин, а `broken` рядом говорит, какая именно.
    const unread = (): Status => ({
      broken,
      readable: false,
      sessions: 0,
      events: pending(),
      bytes: queuedBytes,
      share: queuedBytes / LIMITS.bytes,
      from: null,
      to: null,
    })
    if (broken) return unread()
    try {
      const db = await open()
      const all = (await ask(
        db.transaction('sessions').objectStore('sessions').getAll(),
      )) as { bytes?: number; events?: number; startedAt?: string }[]
      const bytes = all.reduce((s, x) => s + (x.bytes ?? 0), 0) + queuedBytes
      // Склеенная запись в очереди — это `_n` событий, а не одно: залипшее
      // событие иначе показалось бы родителю единственным.
      const events = all.reduce((s, x) => s + (x.events ?? 0), 0) + pending()
      const dates = all.map((s) => s.startedAt ?? '').sort()
      return {
        // Не `false` литералом: сброс рядом мог оборваться, пока мы читали.
        broken,
        readable: true,
        sessions: all.length,
        events,
        bytes,
        share: bytes / LIMITS.bytes,
        from: dates[0] ?? null,
        to: dates[dates.length - 1] ?? null,
      }
    } catch {
      // Чтение сводки не удалось (например, `DataError`). Это отказ ОПЕРАЦИИ,
      // а не доказательство непригодности базы: `broken` здесь не трогаем —
      // запись продолжается, недостоверна только эта сводка.
      return unread()
    }
  }

  type Dump = {
    exportedAt: string
    limits: typeof LIMITS
    sessions: (Record<string, unknown> & { log: Record<string, unknown>[] })[]
  }

  /**
   * Собирает дамп ПО СЕССИЯМ, а не одним `getAll()` по всем событиям.
   *
   * Потолок базы — 25 МБ, и один `getAll()` над стором событий просил бы у
   * телефона ребёнка все 25 МБ одной аллокацией. По сессии за раз запрос
   * ограничен одной сессией, а не базой, — а именно отказ этой аллокации и
   * был бы тем отказом, после которого журнал раньше замолкал совсем.
   */
  async function collect(): Promise<Dump> {
    await flush()
    const db = await open()
    const sessions = (
      (await ask(db.transaction('sessions').objectStore('sessions').getAll())) as { id: number }[]
    ).sort((a, b) => a.id - b.id)

    const out: Dump['sessions'] = []
    for (const s of sessions) {
      // Своя транзакция на сессию: транзакция чтения живёт ровно пока у неё
      // есть незакрытые запросы, а между сессиями мы ждём разбора.
      const rows = (await ask(
        db.transaction('events').objectStore('events').index('session').getAll(IDBKeyRange.only(s.id)),
      )) as { k: number; session: number }[]
      const log = rows
        .sort((a, b) => a.k - b.k)
        .map((e) => {
          const { k: _k, session: _s, ...rest } = e as Record<string, unknown> & { k: number; session: number }
          void _k
          void _s
          return rest
        })
      out.push({ ...s, log })
    }
    return { exportedAt: new Date(deps.wall()).toISOString(), limits: LIMITS, sessions: out }
  }

  /**
   * Сохраняет журнал файлом и открывает «Поделиться».
   *
   * Именно в таком порядке и обязательно оба. Файл должен лечь на телефон
   * независимо от того, чем кончится шторка: её можно закрыть случайно,
   * промахнуться мимо мессенджера, передумать — и журнал не должен при этом
   * пропасть. А шторка нужна потому, что на Android путь «найти файл в
   * Загрузках» регулярно оказывается тупиком, и какой из двух путей живой —
   * зависит от версии и настроек.
   */
  async function save(): Promise<SaveResult> {
    let data: Dump
    try {
      data = await collect()
    } catch {
      /* Дамп не собрался. Запись при этом НЕ выключается: `collect()` — чтение,
         а не доказательство непригодности базы. Иначе одно неудавшееся нажатие
         «СОХРАНИТЬ И ПОДЕЛИТЬСЯ» лишало бы журнала весь остаток сессии —
         молча, потому что сломалось бы ровно то, что об этом сообщает.

         `broken` в ответе — состояние ЖУРНАЛА, а не исход выгрузки: за исход
         отвечают `saved` и `shared`. */
      return { name: '', bytes: 0, saved: false, shared: 'unavailable', sessions: 0, broken }
    }

    const stamp = new Date(deps.wall()).toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const name = `pose-game-log-${stamp}.json`
    const body = JSON.stringify(data)

    let saved = false
    let bytes = 0
    let file: File | null = null
    try {
      const blob = new Blob([body], { type: 'application/json' })
      bytes = blob.size
      file = new File([blob], name, { type: 'application/json' })
      saved = deps.download(blob, name)
    } catch {
      saved = false
    }

    let shared: Shared = 'unavailable'
    if (file) {
      const files = [file]
      let can = false
      try {
        can = deps.canShare(files)
      } catch {
        can = false
      }
      if (can) {
        try {
          await deps.share(files, `Журнал «Стены с позами», сессий: ${data.sessions.length}`)
          shared = 'shared'
        } catch (e) {
          shared = (e as { name?: string } | null)?.name === 'AbortError' ? 'cancelled' : 'failed'
        }
      }
    }

    return { name, bytes, saved, shared, sessions: data.sessions.length, broken: false }
  }

  /**
   * Уборка выгруженного — в ДВА приёма, через пометку.
   *
   * Удалять сразу нельзя: `download()` возвращает `true`, когда клик не бросил,
   * а браузер отказывает в загрузке ПОСЛЕ клика и молча — кончилось место,
   * загрузка заблокирована. Иначе вышло бы: родитель жмёт «сохранить» на
   * телефоне без места, Chrome показывает «Загрузка не удалась», а приложение
   * сносит двадцать забегов, которых больше нигде нет.
   *
   * Поэтому сессия сперва ПОМЕЧАЕТСЯ выгруженной, а удаляется та, что была
   * помечена в прошлый раз: чтобы потерять сессию, надо, чтобы ДВЕ выгрузки
   * подряд не доехали до диска. Текущая не помечается и не удаляется — в неё
   * сейчас пишут, и `flush()` пометку бы стёр.
   */
  async function sweepExported(): Promise<{ sessions: number; marked: number; bytes: number }> {
    const nothing = { sessions: 0, marked: 0, bytes: 0 }
    if (broken) return nothing
    try {
      const db = await open()
      const tx = rw(db, ['sessions', 'events'])
      const sessions = tx.objectStore('sessions')
      const store = tx.objectStore('events')
      const index = store.index('session')
      const all = (await ask(sessions.getAll())) as { id: number; bytes?: number; exported?: boolean }[]

      const doomed: { id: number; bytes?: number }[] = []
      let marked = 0
      let bytes = 0

      for (const s of all) {
        if (s.id === sessionId) continue
        if (s.exported) {
          doomed.push(s)
          bytes += s.bytes ?? 0
        } else {
          sessions.put({ ...s, exported: true })
          marked++
        }
      }

      for (const s of doomed) {
        sessions.delete(s.id)
        await dropEvents(store, index, s.id)
      }
      await done(tx)
      return { sessions: doomed.length, marked, bytes }
    } catch {
      // Уборка не удалась — ничего не помечено и не удалено, что и сказано
      // нулями. Запись не выключаем: уборка не доказывает непригодность базы.
      return nothing
    }
  }

  async function clear(): Promise<void> {
    cancelTimer()
    queue = []
    prevKey = null
    queuedBytes = 0
    ring = []
    bursts = 0
    if (broken) return
    try {
      const db = await open()
      const tx = rw(db, ['sessions', 'events'])
      tx.objectStore('sessions').clear()
      tx.objectStore('events').clear()
      await done(tx)
    } catch {
      // Опустошить не удалось. Очередь и кольцо уже чисты, запись цела.
    }
  }

  /**
   * Строки скелета живут в кольце, а не пишутся сплошь: сплошная запись — это
   * десятки мегабайт за сессию при потолке 25. Всплеск выгружается в спорный
   * момент — провал раунда и пауза, — и только пока не исчерпан бюджет забега.
   */
  function rawPush(t: number, lm: Landmarks | null): void {
    if (broken || !lm) return
    const v = new Array<number>(lm.length)
    for (let i = 0; i < lm.length; i++) v[i] = Math.round(lm[i]! * 1000) / 1000
    ring.push({ t: Math.round(t), v })
    if (ring.length > LIMITS.rawLines) ring.splice(0, ring.length - LIMITS.rawLines)
  }

  function rawBurst(why: RawWhy): void {
    if (broken || ring.length === 0 || bursts >= LIMITS.rawBursts) return
    const lines = ring
    ring = []
    bursts++
    event('raw', { why, lines })
  }

  function rawReset(): void {
    ring = []
    bursts = 0
  }

  return {
    sessionId,
    get broken() {
      return broken
    },
    get queued() {
      return queue.length
    },
    event,
    write: (e) => event(e.type, e.data),
    flush,
    trim,
    status,
    save,
    sweepExported,
    clear,
    rawPush,
    rawBurst,
    rawReset,
  }
}

/** Журнал приложения. Включения и выключения у него нет: он работает всегда. */
export const journal = makeJournal()

export const event: Journal['event'] = (type, data) => journal.event(type, data)
export const write: Journal['write'] = (e) => journal.write(e)
export const flush: Journal['flush'] = () => journal.flush()
export const trim: Journal['trim'] = () => journal.trim()
export const status: Journal['status'] = () => journal.status()
export const save: Journal['save'] = () => journal.save()
export const sweepExported: Journal['sweepExported'] = () => journal.sweepExported()
export const clear: Journal['clear'] = () => journal.clear()
export const rawPush: Journal['rawPush'] = (t, lm) => journal.rawPush(t, lm)
export const rawBurst: Journal['rawBurst'] = (why) => journal.rawBurst(why)
export const rawReset: Journal['rawReset'] = () => journal.rawReset()
