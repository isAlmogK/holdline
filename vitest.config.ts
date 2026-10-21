import { defineConfig } from 'vitest/config'

// Core's tests run first, on their own: its property tests have 5 s timeouts that the CPU load of the
// PGlite suites (analyzer-postgres, cli golden apps) can push past when everything runs at once.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], sequence: { groupOrder: 0 } } },
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/core/**', '**/node_modules/**'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
