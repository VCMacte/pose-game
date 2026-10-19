/**
 * Ни один конструктор событий (`src/adapters/log/events.ts`) не имеет права
 * произвести поле с зарезервированным именем конверта (`t`, `type`, `k`,
 * `session`, `_n`, `_lastT` — `RESERVED_KEYS` в `store.ts`).
 *
 * В рантайме такое поле обрезается МОЛЧА (`envelope()` в `store.ts`) — это
 * осознанный выбор: покадровый путь не имеет права бросать исключение.
 * Но молчаливая обрезка — это и место, где опечатка программиста исчезает
 * бесследно: `event.ts` отдаёт конструктор с полем `type` внутри данных, и в
 * продакшене это поле просто пропадает без единого сигнала.
 *
 * Поэтому здесь проверка СТАТИЧЕСКАЯ, не рантаймовая: приговор выносит
 * компилятор при `tsc --noEmit`, которым `npm test` гонит перед тестами.
 * Список резервных имён берётся из store.ts (`RESERVED_KEYS`), а не
 * ретипирован — единственная копия списка остаётся там, где её завели.
 *
 * Множество проверяемых конструкторов собирается МЕХАНИЧЕСКИ: `typeof ev`
 * даёт все экспорты модуля, а отобраны из них те, чья форма ВОЗВРАТА — это
 * форма конструктора события (`{ type: string; data: object }`). Конструктор,
 * добавленный позже, попадает в проверку сам — никому не придётся вспоминать
 * о ней и дописывать список руками.
 */
import { describe, expect, test } from 'vitest'

import * as ev from '../../src/adapters/log/events'
import type { RESERVED_KEYS } from '../../src/adapters/log/store'

type ReservedKey = (typeof RESERVED_KEYS)[number]

type EventModule = typeof ev

/** Форма, которую обязан вернуть любой конструктор события. */
type EventShape = { type: string; data: object }

/**
 * Имена экспортов модуля, которые ПО ФОРМЕ ВОЗВРАТА — конструкторы событий.
 * `loggedPerAxis` сюда не попадает: её возврат — `{ axes, worst }`, не
 * `{ type, data }`, так что проверять в ней нечего.
 */
type EventCtorKeys = {
  [K in keyof EventModule]: EventModule[K] extends (...args: never[]) => infer R
    ? R extends EventShape
      ? K
      : never
    : never
}[keyof EventModule]

/** Параметр данных конструктора — то, что в итоге уходит в `data` записи. */
type DataParamOf<F> = F extends (d: infer D, ...rest: never[]) => unknown ? D : never

/** Есть ли у типа данных хоть одно зарезервированное имя поля. */
type HasReservedKey<T> = [Extract<keyof T, ReservedKey>] extends [never] ? false : true

/**
 * Имена конструкторов, которые НАРУШАЮТ запрет. В норме — `never`: если здесь
 * оказывается хоть одно имя, следующая строка не компилируется.
 */
type Violations = {
  [K in EventCtorKeys]: HasReservedKey<DataParamOf<EventModule[K]>> extends true ? K : never
}[EventCtorKeys]

/**
 * Приговор. Если `Violations` — не `never` (конструктор завёл поле `t`,
 * `type`, `k`, `session`, `_n` или `_lastT`), компиляция падает здесь с
 * TS2344 «Type '<имя конструктора>' does not satisfy the constraint 'never'»
 * — и `npm test` останавливается на `tsc --noEmit`, не доходя до тестов.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertNoReservedKeysLeak<V extends never = Violations> = V

describe('конструкторы событий не заводят зарезервированные имена конверта', () => {
  test('проверка не схлопнулась в пустое множество (иначе это приговор без суда)', () => {
    // Сама проверка — компиляция типа выше; здесь только защита от того, что
    // механический фильтр типов случайно не нашёл НИ ОДНОГО конструктора и
    // статическая проверка стала бы гарантом, который ничего не гарантирует —
    // ровно как найденные в проекте раньше пять таких же.
    const names = Object.entries(ev)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)

    expect(names.length).toBeGreaterThanOrEqual(22)
    expect(names).toEqual(
      expect.arrayContaining([
        'roundPreview',
        'roundWall',
        'roundJudge',
        'roundSkip',
        'runStart',
        'runFinish',
        'health',
        'pause',
        'resume',
        'sessionStart',
        'build',
        'error',
        'errorPromise',
        'visibility',
        'camStart',
        'camFail',
        'camEnded',
        'poseReady',
        'poseFail',
        'calibDone',
        'calibNeed',
        'calibStale',
      ]),
    )
  })
})
