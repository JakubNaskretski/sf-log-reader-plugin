import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run the TypeScript sources — not the compiled copies under out/
    // (tsc -p ./ emits out/*.test.js, which vitest must not pick up).
    include: ['src/**/*.test.ts'],
    exclude: ['out/**', 'node_modules/**'],
  },
});
