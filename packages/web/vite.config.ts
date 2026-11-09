import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In production fwd serves the built bundle and the API from the same origin.
// In development the API is proxied to fwd, or to the mock (mock/mock-fwd.mjs).
const target = process.env.FWD_URL ?? 'http://127.0.0.1:7317';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/v1': { target, changeOrigin: true }, '/__mock': { target } },
  },
  test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] },
});
