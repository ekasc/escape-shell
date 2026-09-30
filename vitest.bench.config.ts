import { defineConfig } from 'vitest/config'

/**
 * Benchmarks only.
 *
 * The default run picks up every *.test.tsx, which would put a timing suite
 * behind the fast gate. These measure wall-clock, so their output is noise in a
 * correctness run and they should be asked for explicitly:
 *
 *   bun run bench:harness
 */
export default defineConfig({
  test: {
    include: ['bench-harness.tsx'],
  },
})
