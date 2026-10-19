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

/**
 * Выбор следующей позы: чистая функция от `rnd` (docs/judging.md «Выбор
 * следующей позы»).
 *
 * Правила: не повторять `prev`, не выдавать её зеркало сразу следом (зеркало
 * берётся из `prev.mirrorId`, который строит `poses.ts` при сборке `POSES` —
 * здесь схема id не реконструируется), набирать только из `cutouts(tier, tg)`.
 * Предполагает, что вызывающий не допускает тумблер, роняющий пул ниже трёх
 * (`toggleAllowed`) — тогда исключение не более двух поз (оригинал и зеркало)
 * никогда не опустошает пул. Если пул всё же опустел, это расхождение с
 * гарантией `toggleAllowed`, и функция бросает исключение вместо того, чтобы
 * молча вернуть повтор или зеркало (docs/judging.md «Выбор следующей позы»).
 */
export function nextPose(
  prev: PoseSpec | null,
  tier: 1 | 2 | 3,
  tg: Toggles,
  rnd: () => number,
): PoseSpec {
  const pool = cutouts(tier, tg)
  const excluded =
    prev === null
      ? new Set<string>()
      : new Set([prev.id, ...(prev.mirrorId !== undefined ? [prev.mirrorId] : [])])
  const candidates = pool.filter((p) => !excluded.has(p.id))
  if (candidates.length === 0) {
    throw new Error(
      `nextPose: пул опустел (${pool.length} поз) после исключения предыдущей позы ` +
        `«${prev?.id}» и зеркала [${[...excluded].join(', ')}] — toggleAllowed должна была ` +
        'запретить тумблер, уронивший пул ниже трёх',
    )
  }
  const i = Math.min(candidates.length - 1, Math.floor(rnd() * candidates.length))
  return candidates[i]
}
