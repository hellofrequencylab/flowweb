import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['probes/**/*.test.ts'], testTimeout: 120000, root: process.env.FW_REPO_ROOT } });
