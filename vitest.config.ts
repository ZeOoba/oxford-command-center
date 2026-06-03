import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@contracts': fileURLToPath(new URL('./src/contracts', import.meta.url)),
      '@analytics': fileURLToPath(new URL('./src/analytics', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // Node 24 + Windows: the default forks pool hits a tinypool spawn fault.
    // Single-thread workers avoid the child_process spawn path and run reliably.
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    isolate: false,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/analytics/**', 'src/contracts/**', 'src/lib/**'],
    },
  },
});
