import { resolve } from 'node:path'
import { defineConfig } from 'vite'

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
