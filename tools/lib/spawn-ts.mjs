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
 * уже лежит в зависимостях (его тянет vitest) и разрешает импорты ТЕМ ЖЕ
 * резолвером, которым их разрешают тесты, — то есть replay и тесты видят
 * одинаковое ядро, а не похожее.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/*
 * Запускается НАСТОЯЩИЙ вход `vite-node`, а не шим из `.bin`. Шим на Windows —
 * `.cmd`, его исполняет оболочка, и путь проекта с пробелом (`D:\pet
 * progects\…`) в ней рвётся на «D:\pet» и «progects». Прямой запуск через
 * `process.execPath` оболочки не касается вовсе.
 */
const BIN = join(HERE, '..', '..', 'node_modules', 'vite-node', 'vite-node.mjs')

/** `name` — файл в `tools/lib/`, например `cli-replay.ts`. */
export function spawnTs(name) {
  const r = spawnSync(process.execPath, [BIN, join(HERE, name), '--', ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  // Код выхода пробрасывается: расхождение в replay — ненулевой выход, и этим
  // инструмент годится для CI, а не только для чтения глазами.
  process.exit(r.status ?? 1)
}
