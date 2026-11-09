#!/usr/bin/env node
// Starts the mock fwd and the Vite dev server together. Ctrl+C stops both.
import { spawn } from 'node:child_process';

const opts = { stdio: 'inherit', shell: process.platform === 'win32' };
const mock = spawn('node', ['mock/mock-fwd.mjs', ...process.argv.slice(2)], opts);
const vite = spawn('npx', ['vite'], { ...opts, env: { ...process.env, FWD_URL: 'http://127.0.0.1:7317' } });
const stop = () => {
  mock.kill();
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
