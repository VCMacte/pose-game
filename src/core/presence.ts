import { CONFIG } from './config'
import type { Geometry } from './geometry'
import type { Orientation } from './types'

/**
 * Присутствие игрока: виден ли он и тот ли это игрок.
 *
 * Читать вместе с docs/presence-and-pause.md. Это код про анти-цель, а не про
 * фичу: приговор не вправе наказывать за то, чего игра не видела, и кадр, в
 * котором трекер потерял ребёнка, обязан быть НЕВАЛИДНЫМ, а не промахнувшимся
 * (→ docs/judging.md: знаменатель голосования — валидные кадры). Обратная
 * ошибка так же плоха: слишком покладистое присутствие делает игроком
 * вошедшую в кадр маму, и ребёнок получает приговор за чужую позу.
 *
 * Три правила держат весь файл:
 *
 * - **Причины проверяются в объявленном порядке, первая же возвращается.**
 *   Порядок выбран не по удобству, а по тому, какой ответ полезнее для разбора
 *   журнала; он проверяется тестом очистки по одной причине.
 * - **`jump` сравнивает с последним ДОВЕРЕННЫМ торсом, а не с предыдущим
 *   кадром,** и доверенное значение обновляется ТОЛЬКО на подтверждённых
 *   кадрах. С предыдущим кадром защита рассыпается: подмена, растянутая на
 *   несколько кадров, проходит незамеченной — каждый отдельный шаг мал.
 * - **Проверка размера торса симметрична** — ловит и рост (вошли ближе), и
 *   убыль (вошли дальше) против одного и того же порога `torsoGrowth`.
 * - **Время приходит аргументом.** `performance.now()` здесь сделал бы автомат
 *   непроверяемым и сломал бы replay журнала из node.
 */

/** Почему кадр не годен. Порядок перечисления — порядок проверок. */
export type PresenceReason = 'none' | 'lowvis' | 'jump' | 'scale' | 'orientation' | 'edge'

/** Приговор присутствия для одного кадра. `why` есть ровно при `ok: false`. */
export type PresenceVerdict = { ok: true } | { ok: false; why: PresenceReason }

/**
 * Тот же приговор, но годная ветка несёт ГЕОМЕТРИЮ подтверждённого кадра.
 *
 * Внутри файла это итог проверки причин. Наружу он нужен тем, кто получает
 * валидность уже вычисленной и не вправе считать её заново — судейством
 * (docs/judging.md, «Валидность приходит вместе с кадрами»): без суженной
 * геометрии судье пришлось бы держать недостижимые проверки на `null` ради
 * одних только типов.
 */
export type PresenceResult = { ok: true; gm: Geometry } | { ok: false; why: PresenceReason }

/**
 * Память присутствия между кадрами. Меняется `presence()` на месте: это
 * автомат одного забега, а не значение.
 */
export type PresenceState = {
  /** Длина торса последнего ПОДТВЕРЖДЁННОГО кадра; `null` — доверять нечему. */
  trustedS: number | null
  /** Центр тела последнего подтверждённого кадра, в долях ширины кадра. */
  trustedCx: number | null
  /** Когда начался текущий непрерывный отказ; `null` — отказа нет. */
  badSince: number | null
  /** Когда началась текущая непрерывная серия подтверждений; `null` — её нет. */
  goodSince: number | null
}

export function newPresenceState(): PresenceState {
  return { trustedS: null, trustedCx: null, badSince: null, goodSince: null }
}

/** Непрерывный отказ дотянул до `pauseMs` — забег просит автопаузу. */
export function pauseRequested(st: PresenceState, t: number): boolean {
  return st.badSince !== null && t - st.badSince >= CONFIG.presence.pauseMs
}

/** Игрок виден непрерывно `resumeMs` — можно запускать отсчёт «3, 2, 1». */
export function resumeReady(st: PresenceState, t: number): boolean {
  return st.goodSince !== null && t - st.goodSince >= CONFIG.presence.resumeMs
}

/**
 * Решает годность одного кадра и ведёт память присутствия.
 *
 * `expect` — ориентация, которую требует ПОЗА текущего раунда, а не режим
 * игры: в раунде с `profile` боком — норма, а фронтальная стойка даёт отказ.
 */
export function presence(
  gm: Geometry | null,
  t: number,
  st: PresenceState,
  expect: Orientation,
): PresenceVerdict {
  const r = reason(gm, t, st, expect)

  if (r.ok) {
    // Доверенный торс обновляется ЗДЕСЬ и только здесь — на подтверждённом кадре.
    st.trustedS = r.gm.S
    st.trustedCx = r.gm.cx
    st.badSince = null
    st.goodSince = st.goodSince ?? t
    return { ok: true }
  }

  st.badSince = st.badSince ?? t
  st.goodSince = null
  return { ok: false, why: r.why }
}

/** Первая сработавшая причина отказа, либо годная геометрия кадра. */
function reason(
  gm: Geometry | null,
  t: number,
  st: PresenceState,
  expect: Orientation,
): PresenceResult {
  if (gm === null) return { ok: false, why: 'none' }

  const c = CONFIG.presence

  if (gm.vis < CONFIG.visibility.min) return { ok: false, why: 'lowvis' }

  const trust = trusted(st, t)
  if (trust !== null && (jumped(gm, trust) || scaleJumped(gm, trust))) {
    return { ok: false, why: 'jump' }
  }

  if (gm.S > c.scale.torsoMax) return { ok: false, why: 'scale' }
  if (gm.shoulderRatio * gm.S < c.scale.shoulderMin) return { ok: false, why: 'scale' }

  if (!oriented(gm, expect)) return { ok: false, why: 'orientation' }

  if (gm.cx < c.edge.margin || gm.cx > 1 - c.edge.margin) return { ok: false, why: 'edge' }

  return { ok: true, gm }
}

/**
 * Есть ли субъект, с которым сравнивать, и если да — его торс и центр.
 * Доверие истекает за время паузы: на паузе судейства нет, и первый видимый
 * кадр после неё заводит субъекта заново. Иначе ребёнок, вернувшийся не на то
 * же место, получал бы `jump` вечно — забег запирался бы насмерть.
 */
function trusted(st: PresenceState, t: number): { S: number; cx: number } | null {
  if (st.trustedS === null || st.trustedCx === null || pauseRequested(st, t)) return null
  return { S: st.trustedS, cx: st.trustedCx }
}

/** Скачок центра тела: другой человек встал в кадр рядом. */
function jumped(gm: Geometry, trust: { cx: number }): boolean {
  return Math.abs(gm.cx - trust.cx) > CONFIG.presence.jump.cx
}

/**
 * Торс изменился кратно: другой человек встал ближе (торс вырос) ИЛИ дальше
 * (торс сжался) от камеры. Проверка симметрична: один и тот же порог
 * `torsoGrowth` держит обе границы, иначе они могли бы разъехаться. Это не
 * перестраховка — человек дальше ребёнка — самый частый случай, и оказавшись
 * лишь на ~0.2 ширины кадра в стороне, он не ловится скачком центра вовсе.
 */
function scaleJumped(gm: Geometry, trust: { S: number }): boolean {
  const ratio = gm.S / trust.S
  const bound = CONFIG.presence.jump.torsoGrowth
  return ratio > bound || ratio < 1 / bound
}

/**
 * Та ли ориентация, которую ждёт поза. Пороги и их смысл — те же, что у оси
 * `orientation` в `axes.ts`: отношение ширины плеч к длине торса. Полоса между
 * порогами — «не знаю», и для присутствия это отказ: судить кадр, про который
 * неизвестно, фронт он или профиль, нельзя.
 */
function oriented(gm: Geometry, expect: Orientation): boolean {
  return expect === 'front'
    ? gm.shoulderRatio > CONFIG.orientation.front
    : gm.shoulderRatio < CONFIG.orientation.profile
}
