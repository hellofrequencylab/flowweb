#!/usr/bin/env node
// `fw`: run with `pnpm fw ...` (tsx packages/cli/src/bin.ts).
import { main } from './main.ts';

process.exitCode = await main(process.argv.slice(2));
