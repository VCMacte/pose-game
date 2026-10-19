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
 * - **Время приходит аргументом.** `performance.now()` здесь сделал бы автомат
 *   непроверяемым и сломал бы replay журнала из node.
 */

/** Почему кадр не годен. Порядок перечисления — порядок проверок. */
export type PresenceReason = 'none' | 'lowvis' | 'jump' | 'scale' | 'orientation' | 'edge'

/** Приговор присутствия для одного кадра. `why` есть ровно при `ok: false`. */
export type PresenceVerdict = { ok: boolean; why?: PresenceReason }

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
  const why = reason(gm, t, st, expect)

  if (why === undefined) {
    // Доверенный торс обновляется ЗДЕСЬ и только здесь — на подтверждённом кадре.
    st.trustedS = gm!.S
    st.trustedCx = gm!.cx
    st.badSince = null
    st.goodSince = st.goodSince ?? t
    return { ok: true }
  }

  st.badSince = st.badSince ?? t
  st.goodSince = null
  return { ok: false, why }
}

/** Первая сработавшая причина отказа, либо `undefined`, если кадр годен. */
function reason(
  gm: Geometry | null,
  t: number,
  st: PresenceState,
  expect: Orientation,
): PresenceReason | undefined {
  if (gm === null) return 'none'

  const c = CONFIG.presence

  if (gm.vis < CONFIG.visibility.min) return 'lowvis'

  if (trusted(st, t) && (jumped(gm, st) || grown(gm, st))) return 'jump'

  if (gm.S > c.scale.torsoMax) return 'scale'
  if (gm.shoulderRatio * gm.S < c.scale.shoulderMin) return 'scale'

  if (!oriented(gm, expect)) return 'orientation'

  if (gm.cx < c.edge.margin || gm.cx > 1 - c.edge.margin) return 'edge'

  return undefined
}

/**
 * Есть ли субъект, с которым сравнивать. Доверие истекает за время паузы: на
 * паузе судейства нет, и первый видимый кадр после неё заводит субъекта
 * заново. Иначе ребёнок, вернувшийся не на то же место, получал бы `jump`
 * вечно — забег запирался бы насмерть.
 */
function trusted(st: PresenceState, t: number): boolean {
  return st.trustedS !== null && st.trustedCx !== null && !pauseRequested(st, t)
}

/** Скачок центра тела: другой человек встал в кадр рядом. */
function jumped(gm: Geometry, st: PresenceState): boolean {
  return Math.abs(gm.cx - st.trustedCx!) > CONFIG.presence.jump.cx
}

/** Рост торса кратно: другой человек встал ближе к камере. */
function grown(gm: Geometry, st: PresenceState): boolean {
  return gm.S > st.trustedS! * CONFIG.presence.jump.torsoGrowth
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
