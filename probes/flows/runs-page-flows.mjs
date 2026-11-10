// Probe for FW-C-075 (flow runs on the Runs page): `pnpm probe flows/runs-page-flows`.
// probe-timeout-s: 180
// Tier 0.
// Surface: packages/web/src/runs/RunsPage.tsx (the /runs page). Its checks are in
// probes/flows/runs-page-flows.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd,
// as probes/flows/drafts-inbox.mjs does.
//
// The surface this probe expects:
//   RunsPage, inside a RouterProvider and a LiveProvider, reads GET /v1/runs as before and also
//   GET /v1/status-reports?kind=run (flow cycles) and GET /v1/status-reports?kind=daily (the digest).
//   It shows:
//     a region named "Last 24 hours" whose count includes flow runs started in that window, and that does not
//       say "No runs started" when one did;
//     a region named "Flow runs" with one table row per flow report, each naming its flow and what it did:
//       "Drafted" and "<n> drafts", "Nothing drafted", "Failed" and its reason, or "Published" for the digest,
//       and "<n> found" when a hunt in that cycle found leads;
//     the summary donut (role img) whose label starts with the total number of runs, flow runs included;
//     agent runs from GET /v1/runs in the runs table, linked to /runs/{id}.
//
// Proves, in order:
//   1. The Runs page reads flow reports.
//   2. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'flows/runs-page-flows';

await probe(NAME, async () => {
  // 1. The page (or the client it calls) reads flow reports.
  const client = readFileSync(join(root, 'packages/web/src/api/client.ts'), 'utf8');
  if (!/status-reports[^\n]*kind:\s*'run'/.test(client))
    missing('the web client never asks fwd for flow cycle reports (status-reports kind run) (row FW-C-075)');

  // 2. The component checks.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('runs-page-flows'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: {
        environment: 'jsdom',
        include: [join(root, 'probes/flows/runs-page-flows.spec.tsx')],
        testTimeout: 30000,
      },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Runs page checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 Runs page checks to pass:\n${out.slice(-400)}`);
});
