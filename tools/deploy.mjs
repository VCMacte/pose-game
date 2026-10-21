#!/usr/bin/env node
/**
 * Собирает игру и выкладывает её на GitHub Pages.
 *
 * Pages настроен отдавать ветку `gh-pages` целиком, а не собирать сам, и это
 * по-прежнему так.
 *
 * А вот цена, названная здесь прежде, — «выкладывать надо этой командой, а не
 * одним `git push`» — больше не платится: пуш в `master` публикует сам
 * (`.github/workflows/deploy.yml`). Отменяет её то, что воркфлоу зовёт ЭТОТ
 * ЖЕ скрипт, а не собирает заново: право `workflow` нужно, чтобы файл
 * воркфлоу ЗАПУШИТЬ, а не чтобы Actions потом работали. Руками команда тоже
 * осталась — ею выкладывают, не дожидаясь CI.
 *
 * Адрес для пуша берётся из `POSE_GAME_REMOTE`, если он задан: в Actions туда
 * приходит тот же адрес с токеном запуска. Локально переменной нет, и адрес
 * остаётся прежним.
 *
 * Собранное в ветке — НЕ история проекта, а слепок: ветка перезаписывается
 * целиком (`--force`), и копаться в ней незачем. История живёт в `master`.
 *
 * Сборка ДВУХПРОХОДНАЯ (`tools/build.mjs`) — иначе список офлайн-кэша
 * разойдётся с именами чанков. Разбор: `docs/offline-and-build.md`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const REMOTE = process.env.POSE_GAME_REMOTE || 'https://github.com/VCMacte/pose-game.git'

function run(cmd, args, cwd, label) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) {
    process.stderr.write(`публикация оборвалась на шаге «${label}»\n`)
    process.exit(r.status ?? 1)
  }
}

const git = (args, cwd, label) => run('git', args, cwd, label)

/** Короткий хэш исходника: по нему видно, из чего собран слепок. */
function sourceRev() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'неизвестно'
}

run(process.execPath, [join(ROOT, 'tools', 'build.mjs'), ...process.argv.slice(2)], ROOT, 'сборка')

if (!existsSync(DIST)) {
  process.stderr.write('сборка не оставила dist/ — публиковать нечего\n')
  process.exit(1)
}

/*
 * `.nojekyll` обязателен: без него Pages прогоняет содержимое через Jekyll и
 * выбрасывает всё, что начинается с подчёркивания. Сегодня таких файлов нет, а
 * появятся они молча — и офлайн сломается только у ребёнка.
 */
writeFileSync(join(DIST, '.nojekyll'), '')

/*
 * Репозиторий внутри `dist/` — одноразовый: ветка публикуется слепком, и
 * история слепков никому не нужна. Поэтому каждый раз он создаётся заново.
 */
git(['init', '-q', '-b', 'gh-pages'], DIST, 'init')
git(['add', '-A'], DIST, 'add')
git(['-c', 'user.name=vc', '-c', 'user.email=vc@mactelabs.com', 'commit', '-q', '-m', `build: слепок из ${sourceRev()}`], DIST, 'commit')
git(['push', '-q', '--force', REMOTE, 'HEAD:gh-pages'], DIST, 'push')

process.stdout.write('\nвыложено: https://vcmacte.github.io/pose-game/\n')
process.stdout.write('Pages обновляется примерно минуту; версию сборки видно в служебном экране\n')
