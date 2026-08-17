import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is pure TypeScript. It must run in a plain node environment
    // with no DOM shim available, which keeps browser API creep honest.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
