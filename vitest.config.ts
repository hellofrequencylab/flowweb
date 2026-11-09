import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts', 'e2e/**/*.test.ts'], exclude: ['**/node_modules/**', '.claude/**'], testTimeout: 30000 } });
