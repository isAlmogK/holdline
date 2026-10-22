import { defineConfig } from 'vitest/config'

// Core's tests run first, on their own: its property tests have 5 s timeouts that the CPU load of the
// PGlite suites (analyzer-postgres, cli golden apps) can push past when everything runs at once. The end-to-end
// golden-app suites run last, on their own, for the same reason: with the other PGlite suites they pushed timed
// tests past their limits.
const GOLDEN_APPS = ['packages/cli/test/golden-patch.test.ts', 'packages/cli/test/golden-test.test.ts']

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/test/**/*.test.ts'], sequence: { groupOrder: 0 } } },
      {
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/core/**', '**/node_modules/**', ...GOLDEN_APPS],
          sequence: { groupOrder: 1 },
        },
      },
      { test: { name: 'golden-apps', include: GOLDEN_APPS, sequence: { groupOrder: 2 } } },
    ],
  },
})
