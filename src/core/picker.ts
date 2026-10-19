import { cutouts, type Toggles } from './poses'
import type { PoseSpec } from './types'

export type { Toggles }

/**
 * Разрешено ли выключить тумблер `which` поверх текущих `tg` для ступени
 * `tier`: нет, если это уронит пул вырезов ниже трёх
 * (docs/menu-and-settings.md «Конфликт тумблеров словаря со ступенями»).
 *
 * Выбор следующей позы (`nextPose`) сам состояния «пул опустел» не хранит —
 * вместо этого блокировка живёт здесь, на границе интерфейса.
 */
export function toggleAllowed(tg: Toggles, tier: 1 | 2 | 3, which: keyof Toggles): boolean {
  return cutouts(tier, { ...tg, [which]: false }).length >= 3
}

/** Пара позы и её зеркала по id — той же схемой, что строит `spec()` в poses.ts. */
function mirrorId(p: PoseSpec): string {
  return p.mirror ? p.id.replace(/-mirror$/, '') : `${p.id}-mirror`
}

/**
 * Выбор следующей позы: чистая функция от `rnd` (docs/judging.md «Выбор
 * следующей позы»).
 *
 * Правила: не повторять `prev`, не выдавать её зеркало сразу следом, набирать
 * только из `cutouts(tier, tg)`. Предполагает, что вызывающий не допускает
 * тумблер, роняющий пул ниже трёх (`toggleAllowed`) — тогда исключение не
 * более двух поз (оригинал и зеркало) никогда не опустошает пул.
 */
export function nextPose(
  prev: PoseSpec | null,
  tier: 1 | 2 | 3,
  tg: Toggles,
  rnd: () => number,
): PoseSpec {
  const pool = cutouts(tier, tg)
  const excluded = prev === null ? new Set<string>() : new Set([prev.id, mirrorId(prev)])
  const candidates = pool.filter((p) => !excluded.has(p.id))
  const choices = candidates.length > 0 ? candidates : pool
  const i = Math.min(choices.length - 1, Math.floor(rnd() * choices.length))
  return choices[i]
}
