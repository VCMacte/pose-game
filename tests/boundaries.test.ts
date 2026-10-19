import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = join(__dirname, '..')

/** Рекурсивно собирает пути всех файлов под `dir`. */
function listFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...listFiles(full))
    } else {
      files.push(full)
    }
  }
  return files
}

test('ядро не импортирует адаптеры и оболочку', () => {
  const coreFiles = listFiles(join(ROOT, 'src/core')).filter((f) => f.endsWith('.ts'))
  const forbidden = /from\s+['"](\.\.\/adapters|\.\.\/shell|adapters\/|shell\/)/

  const violations: string[] = []
  for (const file of coreFiles) {
    const content = readFileSync(file, 'utf-8')
    if (forbidden.test(content)) {
      violations.push(file)
    }
  }

  expect(violations).toEqual([])
})

test('console не используется в src', () => {
  const srcFiles = listFiles(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'))
  const consoleUsage = /\bconsole\s*\./

  const hits: string[] = []
  for (const file of srcFiles) {
    const content = readFileSync(file, 'utf-8')
    if (consoleUsage.test(content)) {
      hits.push(file)
    }
  }

  expect(hits).toEqual([])
})

test('vitest сконфигурирован с потолком воркеров', () => {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf-8')
  const hasCap =
    /maxWorkers/.test(config) ||
    /maxForks/.test(config) ||
    /poolOptions/.test(config) ||
    /fileParallelism\s*:\s*false/.test(config)

  expect(hasCap).toBe(true)
})
