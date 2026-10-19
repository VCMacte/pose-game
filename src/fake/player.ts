import { POSES } from '../core/poses'
import type { Frame } from '../core/types'
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
 * **Самомаркировка.** Источник подключается только динамическим импортом на
 * localhost или явным параметром (дело оболочки, задача 19 — этот файл сам по
 * себе ничего не решает про загрузку). Но ни один замер с него не имеет права
 * быть принят за настоящий (иначе калибровка порогов задачи 23 считает по
 * синтетике), поэтому `fakeSource()` возвращает не голый `AsyncIterable`, а
 * объект с ДОПОЛНИТЕЛЬНЫМ свойством `marker` — готовая запись журнала
 * `{ type: 'fake.source', data: { script, hz } }`. Она не пишется сюда сама:
 * `fakeSource()` не знает журнала и не обязан его знать (сигнатура
 * `(script, hz) → AsyncIterable<Frame>` остаётся ровно той, что задана
 * интерфейсом задачи), — но её нельзя не получить вместе с кадрами: журнал
 * пишет её оболочка (`journal.write(source.marker)`) ДО начала забега, и это
 * ровно тот факт, по которому потом видно в дампе, что сессия синтетическая.
 */

const ASPECT = 16 / 9

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

export const SCRIPTS = [
  'still',
  'hit',
  'miss-one-axis',
  'leave-frame',
  'turn-profile',
  'subject-swap',
] as const

export type FakeScript = (typeof SCRIPTS)[number]

/** Готовая запись журнала, которой источник отличает себя от настоящей камеры. */
export type FakeMarker = { type: 'fake.source'; data: { script: FakeScript; hz: number } }

export type FakeSource = AsyncIterable<Frame> & { readonly marker: FakeMarker }

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
 */
export function fakeSource(script: FakeScript, hz: number): FakeSource {
  if (!SCRIPTS.includes(script)) {
    throw new Error(`fakeSource: нет сценария «${String(script)}», есть: ${SCRIPTS.join(', ')}`)
  }
  if (!Number.isFinite(hz) || hz <= 0) {
    throw new Error('fakeSource: hz обязан быть положительным числом')
  }

  const periodMs = 1000 / hz

  async function* gen(): AsyncGenerator<Frame> {
    let i = 0
    let t = 0
    for (;;) {
      const d = bodyAt(script, i)
      yield { t, lm: d === null ? null : stick({ aspect: ASPECT, ...d }) }
      i += 1
      t += periodMs
      await sleep(periodMs)
    }
  }

  return {
    marker: { type: 'fake.source', data: { script, hz } },
    [Symbol.asyncIterator]: gen,
  }
}
