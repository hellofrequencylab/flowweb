// Probe c0/git-edge (WS-P0-036; backlog verify_probe adapters/git-edge).
// Surface: createGitEdge(options) exported by packages/daemon/src/index.ts (files_hint
// packages/daemon/src/edge-git/). Two kinds behind one port (core_adaptation):
//   { kind: 'local', remote }                         a local bare repo host for tests
//   { kind: 'github', repo, ghBin, onEvent? }         shells out to gh
// Methods: preflight(), pushBranch(worktreePath, branch), createPr({ branch, base, title, body })
//   -> { url, head_sha }, readPr(url) -> { head_sha, state }.
// Acceptance:
//   - PR creation against a sandbox repo returns URL and head SHA (local bare host)
//   - token scope check refuses a token with admin rights (stub gh reports admin scope)
//   - rate-limit and 5xx responses are retried with backoff and logged (stub gh fails twice)
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fixtureProject, git, requireExport, tmpDir, writeFiles } from './_lib.mjs';

type Edge = {
  preflight: () => Promise<void>;
  pushBranch: (wt: string, branch: string) => Promise<void>;
  createPr: (o: Record<string, string>) => Promise<{ url: string; head_sha: string }>;
  readPr: (url: string) => Promise<{ head_sha: string }>;
};
type CreateGitEdge = (o: Record<string, unknown>) => Edge;

function stubGh({ scopes, failPrCreate }: { scopes: string; failPrCreate: number }) {
  const dir = tmpDir('gh-stub');
  const log = join(dir, 'calls.log');
  const state = join(dir, 'state');
  const bin = join(dir, 'gh');
  writeFileSync(state, '0');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'auth' && a[1] === 'status') {
  console.error("github.com\\n  Logged in to github.com account probe\\n  Token scopes: ${scopes}");
  process.exit(0);
}
if (a[0] === 'api' && a.some((x) => String(x).includes('user'))) {
  console.log(JSON.stringify({ login: 'probe' })); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'create') {
  const n = Number(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(state)}, String(n + 1));
  if (n < ${failPrCreate}) { console.error('HTTP 502: Bad Gateway (https://api.github.com/graphql)'); process.exit(1); }
  console.log('https://github.com/probe/fixture/pull/7'); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') {
  console.log(JSON.stringify({ headRefOid: '${'a'.repeat(40)}', state: 'OPEN', url: 'https://github.com/probe/fixture/pull/7' }));
  process.exit(0);
}
console.log('{}');
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

describe('c0/git-edge', () => {
  test('local host: push and PR return URL and head SHA', async () => {
    const createGitEdge = (await requireExport('daemon', 'createGitEdge', 'WS-P0-036')) as CreateGitEdge;
    const proj = fixtureProject();
    git(proj.work, 'checkout', '-qb', 'row/FW-C-901');
    writeFiles(proj.work, { 'src/feature.txt': 'feature\n' });
    git(proj.work, 'add', '.');
    git(proj.work, 'commit', '-qm', 'feature');
    const head = git(proj.work, 'rev-parse', 'HEAD');
    const edge = createGitEdge({ kind: 'local', remote: proj.remote });
    await edge.pushBranch(proj.work, 'row/FW-C-901');
    expect(git(proj.remote, 'rev-parse', 'refs/heads/row/FW-C-901')).toBe(head);
    const pr = await edge.createPr({ branch: 'row/FW-C-901', base: 'main', title: 'FW-C-901', body: 'probe' });
    expect(pr.url, 'PR url').toMatch(/\S+/);
    expect(pr.head_sha).toBe(head);
    expect((await edge.readPr(pr.url)).head_sha).toBe(head);
  });

  test('a token with admin rights is refused', async () => {
    const createGitEdge = (await requireExport('daemon', 'createGitEdge', 'WS-P0-036')) as CreateGitEdge;
    const gh = stubGh({ scopes: "'admin:org', 'repo', 'workflow'", failPrCreate: 0 });
    const edge = createGitEdge({ kind: 'github', repo: 'probe/fixture', ghBin: gh.bin });
    await expect(edge.preflight(), 'admin-scoped token refused').rejects.toThrow(/admin/i);
    const ok = stubGh({ scopes: "'repo'", failPrCreate: 0 });
    await expect(createGitEdge({ kind: 'github', repo: 'probe/fixture', ghBin: ok.bin }).preflight()).resolves.not.toThrow();
  });

  test('5xx is retried with backoff and logged', async () => {
    const createGitEdge = (await requireExport('daemon', 'createGitEdge', 'WS-P0-036')) as CreateGitEdge;
    const gh = stubGh({ scopes: "'repo'", failPrCreate: 2 });
    const events: unknown[] = [];
    const edge = createGitEdge({ kind: 'github', repo: 'probe/fixture', ghBin: gh.bin, onEvent: (e: unknown) => events.push(e) });
    const pr = await edge.createPr({ branch: 'row/FW-C-901', base: 'main', title: 't', body: 'b' });
    expect(pr.url).toContain('/pull/7');
    const creates = existsSync(gh.log)
      ? readFileSync(gh.log, 'utf8')
          .trim()
          .split('\n')
          .filter((l) => l.includes('"pr","create"'))
      : [];
    expect(creates.length, 'two failures then a success').toBe(3);
    expect(JSON.stringify(events), 'retries are logged').toMatch(/retry/i);
  }, 60_000);
});
