import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Suites also spawn reference runners; more workers oversubscribe the
    // host and time out fast-check and loopback tests without finding bugs.
    maxWorkers: 2,
  },
});
