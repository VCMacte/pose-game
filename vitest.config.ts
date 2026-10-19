import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        maxForks: 8,
        // Без явного minForks Tinypool падает конфликтом min/max, когда
        // maxForks меньше числа ядер.
        minForks: 1,
      },
    },
  },
})
