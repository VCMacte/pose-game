import { resolve } from 'node:path'
import { defineConfig } from 'vite'

import base from './base.json'

/**
 * Две точки входа: приложение и service worker.
 *
 * Worker собирается ОТДЕЛЬНЫМ файлом с постоянным именем `sw.js` — без хэша.
 * Имя с хэшем означало бы, что при каждой сборке регистрируется новый worker, а
 * старый остаётся жить рядом; браузер различает их по URL, и два живых worker'а
 * на одном приложении дают кэш, который невозможно объяснить.
 *
 * Разбор: `docs/offline-and-build.md`.
 */
export default defineConfig({
  root: '.',
  /*
   * Базовый путь берётся из `base.json` — ОДНОГО места, общего с генератором
   * списка офлайн-кэша. GitHub Pages отдаёт проект по `/<имя-репозитория>/`, и
   * две копии этого пути разъехались бы молча: приложение открылось бы, а
   * офлайн искал бы файлы не там.
   */
  base: base.base,
  /*
   * Версия сборки подставляется ЗДЕСЬ, из той же отметки, что получает
   * генератор списка (`tools/build.mjs` подаёт её обоим через `SW_VERSION`).
   * Приложение читает её, не импортируя генерируемый файл, — иначе от списка
   * зависел бы бандл приложения, а список от имён его чанков, и двухпроходная
   * сборка не сходилась бы.
   */
  define: {
    __BUILD_VERSION__: JSON.stringify(process.env.SW_VERSION ?? 'dev'),
  },
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        sw: resolve(__dirname, 'src/sw-entry.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
