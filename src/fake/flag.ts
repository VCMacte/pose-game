/**
 * Перечень сценариев синтетического игрока и разбор флага `?fake=`.
 *
 * Отдельно от `player.ts` — чтобы оболочка, которой нужен только разбор
 * адреса, не тянула в основной бандл самого игрока с его фигурой и
 * кинематикой. Сам игрок грузится динамическим импортом и только когда его
 * попросили.
 *
 * → `docs/camera-and-pose.md`
 */

export const SCRIPTS = [
  'still',
  'hit',
  'miss-one-axis',
  'leave-frame',
  'turn-profile',
  'subject-swap',
] as const

export type FakeScript = (typeof SCRIPTS)[number]

/**
 * Размер кадра, который синтетический игрок ВЫДАЁТ ЗА СВОЙ.
 *
 * Он обязателен, а не украшение: отношение сторон игра берёт из размера кадра,
 * и без него геометрия честно отказывается считать — экран навсегда остаётся
 * с надписью «Ищу камеру». Синтетика, не назвавшая размер, выглядит как
 * не открывшаяся камера.
 *
 * Отношение 16:9 — то же, в котором `player.ts` строит фигуру: разойтись им
 * нельзя, иначе судили бы в одной системе координат, а размечали в другой.
 */
export const FAKE_FRAME = Object.freeze({ w: 640, h: 360 })

/** Сценарий по умолчанию: игрок повторяет позы верно — «работает ли игра вообще». */
export const DEFAULT_FAKE_SCRIPT: FakeScript = 'hit'

/**
 * Само значение `?fake=`, как его написали, либо `null`, если флага нет.
 *
 * Разделение «нет флага» и «пустое значение» существенно: `?fake=` — это
 * просьба «проверь игру хоть как-нибудь», а отсутствие флага — обычный запуск
 * с камерой. Модель та же, что у `?pipeline=` (`adapters/pose/pipelines.ts`):
 * разбор — чистая функция, чтобы его проверяли из node, а `location` трогала
 * одна строка в оболочке.
 */
export function fakeFlagValue(input: string | null): string | null {
  if (input === null || input === '') return null
  return new URLSearchParams(input.startsWith('?') ? input.slice(1) : input).get('fake')
}

/**
 * Сценарий по значению `?fake=`: пустое значение — умолчание, неизвестное —
 * `null`.
 *
 * Неизвестное имя НЕ откатывается на умолчание молча: опечатка в сценарии
 * прошла бы незамеченной, и проверяли бы не то, что собирались.
 */
export function fakeScript(value: string | null): FakeScript | null {
  if (value === null) return null
  if (value === '') return DEFAULT_FAKE_SCRIPT
  return (SCRIPTS as readonly string[]).includes(value) ? (value as FakeScript) : null
}
