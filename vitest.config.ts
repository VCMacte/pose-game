import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
  },
})
