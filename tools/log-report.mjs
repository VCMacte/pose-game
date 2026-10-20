#!/usr/bin/env node
/**
 * `node tools/log-report.mjs <дамп.json>` — сводка по журналу: исходы раундов,
 * паузы по причинам, промахи по осям, какая поза чаще всего не даётся.
 *
 * Разбор: `docs/log-and-storage.md`.
 */
import { spawnTs } from './lib/spawn-ts.mjs'

spawnTs('cli-report.ts')
