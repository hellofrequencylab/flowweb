// Probe c0/git-edge (WS-P0-036; backlog verify_probe adapters/git-edge).
// Surface: the GitHost port in packages/daemon/src/edge-git/ (exported by packages/daemon/src/index.ts):
//   new LocalBareHost(barePath)   a local bare repository host (PRs stored in <bare>.prs/)
//   new GhHost({ repo, env, retries?, baseDelayMs?, log? })   shells out to gh and git (argv only)
// Methods: pushBranch({ cwd, branch }) -> { branch, sha }, openPullRequest({ title, body, head, base })
// -> { number, url, head_sha }, getPrStatus(number) (re-fetched from the host), verifyTokenScope()
// -> { ok, reason, token_kind, scopes, repo_admin } (GhHost). The GhHost cases use a stub `gh` placed
// first on PATH in the env given to GhHost, so the real exec path runs and nothing reaches GitHub.
// Acceptance:
//   - PR creation against a sandbox repo returns URL and head SHA (local bare host, and the gh path)
//   - token scope check refuses a token with admin rights (classic admin scope, or admin permission
//     on the repository for a fine-grained token); a narrow token passes
//   - rate-limit and 5xx responses are retried with backoff and logged (stub gh fails twice)
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { fixtureProject, git, requireExport, tmpDir, writeFiles } from './_lib.mjs';

type PrRef = { number: number; url: string; head_sha: string };
type Host = {
  pushBranch: (i: { cwd: string; branch: string }) => Promise<{ branch: string; sha: string }>;
  openPullRequest: (i: { title: string; body: string; head: string; base: string }) => Promise<PrRef>;
  getPrStatus: (n: number) => Promise<{ state: string; head_sha: string; url: string }>;
  verifyTokenScope: () => Promise<{ ok: boolean; reason: string; scopes: string[]; repo_admin: boolean | null }>;
};
type LogEntry = { event: string; cmd: string; attempt: number; delay_ms?: number; reason: string };

const HEAD = 'a'.repeat(40);

/** A `gh` stand-in. STUB_SCOPES: x-oauth-scopes header ('' = fine-grained), STUB_ADMIN: repo admin. */
function stubGh() {
  const dir = tmpDir('gh-stub');
  const state = join(dir, 'state');
  writeFileSync(state, '0');
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const env = process.env;
if (a[0] === 'api' && a.includes('--include') && a.includes('user')) {
  process.stdout.write('HTTP/2.0 200 OK\\r\\n' + (env.STUB_SCOPES ? 'x-oauth-scopes: ' + env.STUB_SCOPES + '\\r\\n' : '') + '\\r\\n{"login":"probe"}\\n');
  process.exit(0);
}
if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+$/.test(a[1])) { console.log(env.STUB_ADMIN === '1' ? 'true' : 'false'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') {
  const n = Number(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  fs.writeFileSync(${JSON.stringify(state)}, String(n + 1));
  if (n === 0) { console.error('HTTP 429: API rate limit exceeded (https://api.github.com/graphql)'); process.exit(1); }
  if (n === 1) { console.error('HTTP 502: Bad Gateway (https://api.github.com/graphql)'); process.exit(1); }
  console.log('https://github.com/probe/fixture/pull/7'); process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') {
  console.log(JSON.stringify({ number: 7, url: 'https://github.com/probe/fixture/pull/7', state: 'OPEN', headRefName: 'fw/FW-C-901/run_probegh01',
    baseRefName: 'main', headRefOid: '${HEAD}', mergeCommit: null }));
  process.exit(0);
}
console.error('stub gh: unexpected ' + JSON.stringify(a)); process.exit(1);
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

function ghEnv(stubDir: string, extra: Record<string, string>) {
  return { PATH: `${stubDir}:${process.env.PATH}`, HOME: tmpDir('gh-home'), GH_TOKEN: 'probe-not-a-token', ...extra };
}

describe('c0/git-edge', () => {
  test('local bare host: push and PR creation return the URL and head SHA, status is re-fetched', async () => {
    const LocalBareHost = (await requireExport('daemon', 'LocalBareHost', 'WS-P0-036')) as new (p: string) => Host;
    const proj = fixtureProject();
    const branch = 'fw/FW-C-901/run_probeedge01';
    git(proj.work, 'checkout', '-q', '-b', branch);
    writeFiles(proj.work, { 'fw-fake/edge.md': 'one\n' });
    git(proj.work, 'add', '-A');
    git(proj.work, 'commit', '-qm', 'edge one');
    const local = git(proj.work, 'rev-parse', 'HEAD');

    const host = new LocalBareHost(proj.remote);
    const pushed = await host.pushBranch({ cwd: proj.work, branch });
    expect(pushed.sha, 'the pushed sha is the local head').toBe(local);
    const pr = await host.openPullRequest({ title: 'probe', body: 'probe body', head: branch, base: 'main' });
    expect(pr.url, 'a PR URL').toMatch(/\S/);
    expect(pr.head_sha, 'the PR head SHA').toBe(local);

    writeFiles(proj.work, { 'fw-fake/edge.md': 'two\n' });
    git(proj.work, 'commit', '-qam', 'edge two');
    await host.pushBranch({ cwd: proj.work, branch });
    const status = await host.getPrStatus(pr.number);
    expect(status.state).toBe('open');
    expect(status.head_sha, 'the status follows the host, not a cached value').toBe(git(proj.work, 'rev-parse', 'HEAD'));
  });

  test('token scope check refuses admin rights and accepts a narrow token', async () => {
    const GhHost = (await requireExport('daemon', 'GhHost', 'WS-P0-036')) as new (o: Record<string, unknown>) => Host;
    const stub = stubGh();
    const check = (extra: Record<string, string>) =>
      new GhHost({ repo: 'probe/fixture', env: ghEnv(stub, extra), retries: 0 }).verifyTokenScope();

    const classicAdmin = await check({ STUB_SCOPES: 'repo, admin:org', STUB_ADMIN: '0' });
    expect(classicAdmin.ok, 'a classic token with admin:org is refused').toBe(false);
    expect(classicAdmin.reason).toMatch(/admin/);

    const repoAdmin = await check({ STUB_SCOPES: '', STUB_ADMIN: '1' });
    expect(repoAdmin.ok, 'a token with admin permission on the repository is refused').toBe(false);
    expect(repoAdmin.repo_admin).toBe(true);

    const narrow = await check({ STUB_SCOPES: 'repo', STUB_ADMIN: '0' });
    expect(narrow.ok, `a narrow token passes: ${narrow.reason}`).toBe(true);

    const none = await new GhHost({ repo: 'probe/fixture', env: { PATH: `${stub}:${process.env.PATH}` } }).verifyTokenScope();
    expect(none.ok, 'no token at all is refused').toBe(false);
  });

  test('rate-limit and 5xx responses are retried with backoff and logged', async () => {
    const GhHost = (await requireExport('daemon', 'GhHost', 'WS-P0-036')) as new (o: Record<string, unknown>) => Host;
    const log: LogEntry[] = [];
    const host = new GhHost({
      repo: 'probe/fixture',
      env: ghEnv(stubGh(), {}),
      retries: 3,
      baseDelayMs: 20,
      log: (e: LogEntry) => log.push(e),
    });
    const pr = await host.openPullRequest({ title: 'probe', body: 'b', head: 'fw/FW-C-901/run_probegh01', base: 'main' });
    expect(pr.url).toBe('https://github.com/probe/fixture/pull/7');
    expect(pr.head_sha, 'the head SHA comes from the host').toBe(HEAD);
    const retries = log.filter((e) => e.event === 'git_host.retry');
    expect(retries.length, 'the 429 and the 502 are each retried and logged').toBe(2);
    expect(retries[0]!.reason).toMatch(/429|rate limit/i);
    expect(retries[1]!.reason).toMatch(/502/);
    expect(retries[1]!.delay_ms!, 'the delay backs off').toBeGreaterThan(retries[0]!.delay_ms!);
  });
});
