#!/usr/bin/env node
/**
 * `node tools/replay.mjs <дамп.json>` — гонит записанные строки скелета через
 * то же ядро и ставит рядом приговор, вынесенный тогда. Расхождение —
 * регрессия судейства, и выход тогда ненулевой.
 *
 * Разбор: `docs/log-and-storage.md`.
 */
import { spawnTs } from './lib/spawn-ts.mjs'

spawnTs('cli-replay.ts')
