import { CONFIG } from './config'
import type { Verdict } from './judge'

/**
 * Применяет приговор раунда к сумме забега.
 *
 * `hit` даёт `+CONFIG.score.hit`, `miss` — `CONFIG.score.miss`, `skip` сумму не
 * трогает вовсе: это раунд, который игра не смогла судить, и ребёнок за него
 * не отвечает (docs/judging.md «Счёт»).
 *
 * Сумма упирается в `CONFIG.score.floor` и ниже не уходит: серия провалов в
 * начале забега не должна загонять ребёнка в яму, из которой уже не
 * выбраться.
 */
export function applyVerdict(total: number, v: Verdict): number {
  if (v.kind === 'skip') return total
  const delta = v.kind === 'hit' ? CONFIG.score.hit : CONFIG.score.miss
  return Math.max(CONFIG.score.floor, total + delta)
}
