import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The same `@/*` mapping tsconfig.json gives the app, so a module can be
    // imported one way rather than two.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The engine is pure TypeScript. It must run in a plain node environment
    // with no DOM shim available, which keeps browser API creep honest. The
    // storage tests run here too, against `fake-indexeddb`, which is the real
    // IndexedDB algorithms in memory and needs no DOM either.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
