#!/usr/bin/env node
/**
 * Пересобирает список файлов кода для офлайн-кэша и поднимает номер версии.
 *
 * **Список и версия ГЕНЕРИРУЮТСЯ, руками их не правят.** Правка руками не
 * ломает разработку — в dev всё берётся из сети, — она ломает установленное
 * приложение у ребёнка и без сети. Это худший вид дефекта в проекте:
 * проявляется не у разработчика и не сразу.
 *
 * Список берётся из настоящего `dist/`, а не из догадок о том, как Vite
 * назовёт чанки: имена с хэшами меняются каждую сборку, и угадать их нельзя.
 *
 * Версия вендора поднимается ОТДЕЛЬНО, флагом `--vendor`: вендор почти никогда
 * не меняется, а новое имя его кэша означает перекачку 17 МБ.
 *
 * Разбор: `docs/offline-and-build.md`.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'src', 'adapters', 'sw-manifest.ts')

/** Вендор живёт в своём кэше: эти префиксы из списка кода вычитаются. */
const VENDOR_PREFIXES = ['vendor/', 'models/']

/** Рекурсивно перечисляет файлы под `dir`. */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

/** Отметка `ГГГГММДД-ЧЧММ`: по ней видно, какую сборку ребёнок запустил. */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Прошлая версия вендора: без `--vendor` она сохраняется как есть. */
function prevVendorVersion() {
  try {
    const m = /VENDOR_VERSION = '([^']+)'/.exec(readFileSync(OUT, 'utf8'))
    if (m) return m[1]
  } catch {
    // Первого запуска ещё не было.
  }
  /*
   * Первый запуск: вендор — версия `1`, а не отметка времени. Отметка совпала
   * бы с версией кода, и «версии независимы» нельзя было бы ни увидеть, ни
   * проверить; а по смыслу вендор с тех пор и не менялся ни разу.
   */
  return '1'
}

/** Пишет сам файл. Один писатель на оба режима: два разъехались бы. */
function writeManifest(urls, version, vendorVersion) {
  const body = [
    '/**',
    ' * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Править руками нельзя — пересоберите:',
    ' *',
    ' *     npm run build',
    ' *',
    ' * Разбор, почему именно так: `docs/offline-and-build.md`.',
    ' */',
    '',
    '/** Версия кода: меняется каждой сборкой, вместе с именем кэша кода. */',
    "export const CODE_VERSION = '" + version + "'",
    '',
    '/**',
    ' * Версия вендора. Поднимается ОТДЕЛЬНО (`node tools/make-sw.mjs --vendor`):',
    ' * новое имя кэша вендора означает перекачку 17 МБ, и платить её при каждой',
    ' * правке строки кода незачем.',
    ' */',
    "export const VENDOR_VERSION = '" + vendorVersion + "'",
    '',
    '/** Файлы кода для офлайн-кэша — ровно то, что сделала сборка. */',
    'export const CODE_FILES = Object.freeze([',
    urls.map((u) => "  '" + u + "',").join('\n'),
    '] as const)',
    '',
  ].join('\n')
  writeFileSync(OUT, body, 'utf8')
}

function main() {
  const version = process.env.SW_VERSION ?? stamp()
  const vendorVersion = process.argv.includes('--vendor') ? stamp() : prevVendorVersion()

  /*
   * Прекэш самого себя — задача с курицей и яйцом: список берётся из `dist/`, а
   * `dist/` собирается из кода, который этот список импортирует. Поэтому сборка
   * ДВУХПРОХОДНАЯ (`npm run build`: собрать → пересобрать список → собрать
   * снова), а здесь есть холостой режим: без `dist/` пишется список из одного
   * корня, чтобы первый проход вообще скомпилировался.
   *
   * Список сходится со второго прохода: имена чанков приложения от содержимого
   * `sw.js` не зависят, а сам `sw.js` в список не входит.
   */
  let files = null
  try {
    files = listFiles(DIST)
  } catch {
    files = null
  }

  if (files === null) {
    writeManifest(['/'], version, vendorVersion)
    console.log('sw-manifest: холостой режим (нет ' + relative(ROOT, DIST) + ') — только корень')
    return
  }

  const code = files
    .map((f) => '/' + relative(DIST, f).split('\\').join('/'))
    .filter((url) => !VENDOR_PREFIXES.some((p) => url.startsWith('/' + p)))
    // `index.html` кэшируется как корень: офлайн открывают по `/`, а не по
    // имени файла, и без корня в списке приложение не стартует вовсе.
    .filter((url) => url !== '/index.html')
    /*
     * Сам worker в свой же кэш НЕ кладётся. Закэшированный worker отдаётся из
     * кэша и себя же обновить не может: приложение застревает на той сборке,
     * которая однажды установилась, и чинится только сбросом данных.
     */
    .filter((url) => url !== '/sw.js')
    .sort()

  const urls = ['/', ...code]
  writeManifest(urls, version, vendorVersion)
  console.log('sw-manifest: ' + urls.length + ' файлов кода, версия ' + version + ', вендор ' + vendorVersion)
}

main()
