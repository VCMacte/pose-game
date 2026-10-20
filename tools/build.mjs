#!/usr/bin/env node
/**
 * Сборка в два прохода с ОДНОЙ отметкой версии.
 *
 * Прекэш самого себя — задача с курицей и яйцом: список файлов берётся из
 * `dist/`, а `dist/` собирается из кода, который этот список импортирует.
 * Отсюда два прохода: собрать → пересобрать список → собрать снова.
 *
 * **Отметка версии считается ОДИН раз и подаётся обоим проходам.** Иначе
 * второй проход получил бы другую версию, другое содержимое и другие имена
 * чанков — то есть список, сделанный между проходами, указывал бы на файлы,
 * которых в итоговой сборке нет. Этот дефект уже был допущен и ловится тестом
 * «каждый файл списка СУЩЕСТВУЕТ в сборке».
 *
 * Сходимость при этом держится на том, что бандл ПРИЛОЖЕНИЯ не зависит от
 * генерируемого списка: список попадает только в `sw.js`, а `sw.js` в список
 * не входит. За это отвечает отдельный модуль `src/adapters/sw-install.ts`.
 *
 * Разбор: `docs/offline-and-build.md`.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Отметка `ГГГГММДД-ЧЧММ`: по ней видно, какую сборку ребёнок запустил. */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

const version = process.env.SW_VERSION ?? stamp()
const env = { ...process.env, SW_VERSION: version }

/** Шаг сборки. Падение любого — падение всей сборки: половина её бесполезна. */
function step(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
  if (r.status !== 0) {
    process.stderr.write(`сборка оборвалась на шаге «${label}»\n`)
    process.exit(r.status ?? 1)
  }
}

const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const makeSw = join(ROOT, 'tools', 'make-sw.mjs')
const vendorFlag = process.argv.includes('--vendor') ? ['--vendor'] : []

console.log(`сборка, версия ${version}`)
step([vite, 'build'], 'первый проход')
step([makeSw, ...vendorFlag], 'список офлайн-кэша')
step([vite, 'build'], 'второй проход')
console.log(`готово: версия ${version}`)
