import { POSES } from '../core/poses'
import type { Frame } from '../core/types'
import { FAKE_FRAME, SCRIPTS } from './flag'
import type { FakeScript } from './flag'
import { stick, type StickDesc } from './stick'

/**
 * Синтетический игрок: источник кадров вместо камеры. Им проверяется вся игра
 * без ребёнка и без телефона — см. docs/log-and-storage.md «Синтетический
 * игрок».
 *
 * Отдаёт `Frame`, а не `CheckedFrame`: присутствие и судейство — не его дело
 * (см. `src/core/run.ts` — забег строит `CheckedFrame` из `presence()` сам,
 * судья только читает). Сценарии проверяют это ядро сквозь настоящие
 * `geometry()` → `presence()` → `judgeWindow()`, а не фактом выдачи кадров —
 * см. `tests/fake/player.test.ts`.
 *
 * **Самомаркировка обязательна.** Источник подключается только динамическим
 * импортом на localhost или явным параметром (дело оболочки, задача 19 —
 * этот файл сам по себе ничего не решает про загрузку). Но ни один замер с
 * него не имеет права быть принят за настоящий: журнал — единственный вход
 * калибровки порогов задачи 23, и если задача 19 забудет пометить сессию,
 * синтетические числа сидят в журнале неотличимо от живых — калибровка на
 * них хуже отсутствия калибровки, потому что выглядит доказательством.
 *
 * Поэтому `onMark` — ТРЕТИЙ ОБЯЗАТЕЛЬНЫЙ параметр `fakeSource`, а не опция:
 * вызов без него не компилируется и бросает в рантайме. Источник зовёт его
 * РОВНО ОДИН РАЗ, СИНХРОННО, В МОМЕНТ СОЗДАНИЯ — до первого `.next()` и даже
 * если ни одного кадра так и не будет взято. Так источник не может
 * существовать, не объявив себя. `fakeSource()` при этом не знает журнала —
 * берёт колбэк, а не адаптер (`src/adapters/log/*`), поэтому не тянет в этот
 * файл зависимость, которой по брифу здесь нет; куда идёт пометка, решает
 * вызывающий (обычно — `journal.write`, задача 19).
 */

/** Отношение сторон синтетического кадра. Размер объявлен в `flag.ts`. */
const ASPECT = FAKE_FRAME.w / FAKE_FRAME.h

/** 13 названий, 18 вырезов — «Звезда» годится: фронтальная, симметричная, ступень 1. */
const STAR = POSES.find((p) => p.id === 'star')
if (STAR === undefined) throw new Error('fakeSource: позы «star» нет в наборе')

/** Полностью совпадающее со «Звездой» описание скелета — сценарий `hit`. */
const HIT_DESC: Partial<StickDesc> = { ...STAR.requires }

/**
 * То же самое тело с ОДНИМ промахом: левое плечо `side` вместо `diag-up`.
 * Плечо — независимая ось (`leftShoulder` в `AXES`), остальные девять осей
 * «Звезды» остаются верными — промах ровно один, как того требует сценарий.
 */
const MISS_DESC: Partial<StickDesc> = { ...STAR.requires, leftShoulder: 'side' }

/** Нейтральная стойка — сценарий `still`. */
const NEUTRAL_DESC: Partial<StickDesc> = {}

/** После какого кадра сценарии со сменой состояния переключаются. Даёт время presence накопить доверенный торс. */
const SWITCH_AT = 5

export { DEFAULT_FAKE_SCRIPT, SCRIPTS, fakeFlagValue, fakeScript } from './flag'
export type { FakeScript } from './flag'

/** Готовая запись журнала, которой источник отличает себя от настоящей камеры. */
export type FakeMarker = { type: 'fake.source'; data: { script: FakeScript; hz: number } }

/** Получает самомаркировку — единожды, при создании источника. */
export type OnMark = (marker: FakeMarker) => void

export type FakeSource = AsyncIterable<Frame>

/**
 * Скелет кадра номер `i` для данного сценария, либо `null` — трекер «потерял»
 * игрока (сценарий `leave-frame`).
 */
function bodyAt(script: FakeScript, i: number): Partial<StickDesc> | null {
  switch (script) {
    case 'still':
      return NEUTRAL_DESC
    case 'hit':
      return HIT_DESC
    case 'miss-one-axis':
      return MISS_DESC
    case 'leave-frame':
      return i < SWITCH_AT ? NEUTRAL_DESC : null
    case 'turn-profile':
      // Фронт, затем поворот боком — присутствие ждёт фронт (ориентация позы
      // раунда), и после поворота обязано отказать причиной `orientation`.
      return i < SWITCH_AT ? NEUTRAL_DESC : { orientation: 'profile', facing: 'right' }
    case 'subject-swap':
      // Тот же нейтральный силуэт, но другой центр кадра: не «тот же ребёнок
      // шагнул», а другой человек встал на его место.
      return i < SWITCH_AT ? { x: 0.5 } : { x: 0.8 }
  }
}

/** Пауза в реальном времени между кадрами — фактическая частота, не только отметка `t`. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Чем источник выдерживает частоту. Подменяется, и только затем, чтобы забег
 * можно было проиграть БЫСТРЕЕ реального времени.
 *
 * Зачем это понадобилось: сквозной тест (задача 22) проигрывает забег на 90
 * игровых секунд, и на настоящих паузах он длился бы те же 90 секунд — то
 * есть единственная проверка, проходящая весь путь целиком, не могла бы
 * входить в обычный прогон вовсе. Отметка `t` внутри кадра от этого не
 * зависит: она растёт на `1000 / hz` всегда, и окно судейства видит те же
 * 7±1 кадр при любой подмене.
 */
export type Pace = (ms: number) => Promise<void>

/**
 * Источник кадров вместо камеры: один из шести сценариев темы «Синтетический
 * игрок», на заданной частоте `hz`.
 *
 * Бесконечный — как и трек настоящей камеры: вызывающий решает, когда
 * прекратить потребление (конец забега, `break` в `for await`). Сценарии со
 * сменой состояния (`leave-frame`, `turn-profile`, `subject-swap`) после
 * переключения остаются в новом состоянии, а не моргают одним кадром — это
 * устойчивая ситуация, а не всплеск.
 *
 * Первый кадр отдаётся немедленно, каждый следующий — через `1000 / hz` мс
 * РЕАЛЬНОГО времени: частота проверяется тестом именно по этой паузе, а не
 * только по отметке `t` внутри кадра (`t` растёт той же величиной, чтобы
 * окно судейства 600 мс держало ожидаемые 7±1 кадра на 11–12 Гц).
 *
 * `onMark` — обязателен, не опция: без него вызов не компилируется (TS) и
 * бросает (JS/рантайм, если тип обойдён). Вызывается синхронно здесь же, до
 * возврата объекта и до единого кадра — источник не может быть создан, не
 * объявив себя синтетическим.
 *
 * `pace` — ЧЕТВЁРТЫМ и необязательным: по умолчанию настоящая пауза, то есть
 * настоящая частота. Подменяют его только тесты, и только чтобы не ждать
 * девяносто секунд забега в реальном времени; порядок параметров оставлен
 * прежним намеренно — обязательность `onMark` ослаблять нельзя.
 */
export function fakeSource(script: FakeScript, hz: number, onMark: OnMark, pace: Pace = sleep): FakeSource {
  if (!SCRIPTS.includes(script)) {
    throw new Error(`fakeSource: нет сценария «${String(script)}», есть: ${SCRIPTS.join(', ')}`)
  }
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new Error('fakeSource: hz обязан быть положительным числом')
  }
  if (typeof onMark !== 'function') {
    throw new Error('fakeSource: onMark обязателен — источник обязан объявить себя синтетическим')
  }

  onMark({ type: 'fake.source', data: { script, hz } })

  const periodMs = 1000 / hz

  async function* gen(): AsyncGenerator<Frame> {
    let i = 0
    let t = 0
    for (;;) {
      const d = bodyAt(script, i)
      yield { t, lm: d === null ? null : stick({ aspect: ASPECT, ...d }) }
      i += 1
      t += periodMs
      await pace(periodMs)
    }
  }

  return { [Symbol.asyncIterator]: gen }
}

