/**
 * Запускает TypeScript-вход инструмента через `vite-node`.
 *
 * Логика инструментов на TypeScript, и иначе быть не может: она импортирует
 * ЯДРО — в этом весь смысл replay, прогонять записанные строки через ТОТ ЖЕ
 * код, а не через его копию на JS, которая разъехалась бы в первую же неделю.
 *
 * **`vite-node`, а не `node --experimental-strip-types`.** Снятие типов в node
 * требует явных расширений в каждом импорте, а ядро импортирует себя без них —
 * как и весь остальной код проекта. Переписать все импорты ядра ради
 * инструмента значило бы менять стиль ядра под нужды его читателя. `vite-node`
 * разрешает импорты ТЕМ ЖЕ резолвером, которым их разрешают тесты, — то есть
 * replay и тесты видят одинаковое ядро, а не похожее.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Путь к входу `vite-node` — РАЗРЕШАЕТСЯ, а не прописывается.
 *
 * Прописанный `node_modules/vite-node/vite-node.mjs` уже сломался однажды: у
 * разных раскладок пакета вход лежит по-разному (`./vite-node.mjs` против
 * `./dist/cli.mjs`), и инструмент падал с `MODULE_NOT_FOUND` на ровном месте.
 * Поле `bin` спрашивается у самого пакета и переживает смену раскладки.
 */
function resolveViteNode() {
  const pkgUrl = import.meta.resolve('vite-node/package.json')
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['vite-node']
  return fileURLToPath(new URL(bin, pkgUrl))
}

/** `name` — файл в `tools/lib/`, например `cli-replay.ts`. */
export function spawnTs(name) {
  let bin
  try {
    bin = resolveViteNode()
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    process.stderr.write(`не найден vite-node: ${why}\n`)
    process.stderr.write('он в devDependencies — поставьте зависимости: npm install\n')
    process.exit(2)
  }

  /*
   * Дочерний `node` с явным путём, а не шим из `.bin`: шим на Windows — `.cmd`,
   * его исполняет оболочка, и путь проекта с пробелом в ней рвётся на части.
   */
  const r = spawnSync(process.execPath, [bin, join(HERE, name), '--', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  // Код выхода пробрасывается: расхождение в replay — ненулевой выход, и этим
  // инструмент годится для CI, а не только для чтения глазами.
  process.exit(r.status ?? 1)
}
