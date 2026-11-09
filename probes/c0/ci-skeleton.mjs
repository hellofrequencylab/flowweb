// Probe c0/ci-skeleton (WS-P0-004; backlog verify_probe devex/ci-skeleton).
// Acceptance lines and how this probe proves each one offline:
//   - "A PR with a type error fails CI": the checks job runs `pnpm typecheck`, and a copy of the
//     workspace with an injected type error makes `tsc` exit nonzero.
//   - "A PR that edits a file under probes/ from an agent identity fails CI": a probe-immutability job
//     runs scripts/check-tier0.mjs over probes/, and that script exits 1 for a [bot] author editing
//     probes/ in a real git history (and 0 for the Owner).
//   - "CI runtime on an empty change is under 4 minutes": NOT provable offline. When gh is
//     authenticated and FW_CI_REPO=<owner/repo> is set, the probe reads the latest successful ci run
//     on main and requires its duration under 240 s; otherwise it prints SKIPPED for that line.
// Also: every `uses:` in the workflow is pinned by a full 40-hex commit SHA.
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, copyDir, fail, git, probe, root, tmpDir, writeFiles } from './_lib.mjs';

await probe('c0/ci-skeleton', async () => {
  const wf = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const uses = [...wf.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  check(uses.length > 0, 'ci.yml has no `uses:` steps');
  for (const u of uses) check(/@[0-9a-f]{40}$/.test(u), `action ${u} is not pinned by a full commit SHA`);
  for (const cmd of ['pnpm lint', 'pnpm typecheck', 'pnpm test']) {
    check(new RegExp(`run:\\s*${cmd.replace(' ', '\\s+')}\\b`).test(wf), `ci.yml checks job does not run "${cmd}"`);
  }
  check(/^ {2}probe-immutability:/m.test(wf), 'ci.yml has no probe-immutability job');
  check(
    /check-tier0\.mjs --only [^\n]*probes\//.test(wf),
    'probe-immutability does not run scripts/check-tier0.mjs over probes/',
  );

  // Type error fails tsc.
  const ws = tmpDir('ci-tsc');
  copyDir(join(root, 'packages'), join(ws, 'packages'));
  for (const f of ['tsconfig.json', 'package.json']) writeFileSync(join(ws, f), readFileSync(join(root, f)));
  symlinkSync(join(root, 'node_modules'), join(ws, 'node_modules'));
  writeFileSync(join(ws, 'packages/contracts/src/type-error.ts'), 'export const n: number = "not a number";\n');
  const tsc = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 180000,
  });
  check(tsc.status !== 0, 'tsc exits 0 on a workspace with an injected type error');
  check(/type-error\.ts/.test(tsc.stdout), `tsc failed, but not on the injected error: ${tsc.stdout.split('\n')[0]}`);

  // Agent edit under probes/ fails check-tier0.
  const repo = tmpDir('ci-git');
  git(repo, 'init', '-q', '-b', 'main');
  writeFiles(repo, { 'probes/c0/x.mjs': 'a\n', 'src/a.ts': 'a\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFiles(repo, { 'probes/c0/x.mjs': 'loosened\n' });
  git(repo, 'commit', '-qam', 'edit probe');
  const head = git(repo, 'rev-parse', 'HEAD');
  const run = (author) =>
    spawnSync(
      process.execPath,
      [join(root, 'scripts/check-tier0.mjs'), '--repo', repo, '--only', 'probes/,ledger/rows/'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, PR_AUTHOR: author, BASE_SHA: base, HEAD_SHA: head } },
    ).status;
  check(run('fw-worker[bot]') === 1, 'check-tier0 does not fail an agent PR that edits probes/');
  check(run('hellofrequencylab') === 0, 'check-tier0 fails an Owner PR that edits probes/ (code-owner review handles that)');

  // CI runtime (optional, needs gh).
  const repoSlug = process.env.FW_CI_REPO;
  if (!repoSlug) {
    console.log('SKIPPED c0/ci-skeleton: "CI runtime under 4 minutes" needs FW_CI_REPO=<owner/repo> and gh auth');
    return;
  }
  const gh = spawnSync(
    'gh',
    ['run', 'list', '-R', repoSlug, '-w', 'ci', '-b', 'main', '-s', 'success', '-L', '1', '--json', 'createdAt,updatedAt'],
    { encoding: 'utf8' },
  );
  if (gh.status !== 0) fail(`gh run list failed: ${gh.stderr.trim()}`);
  const [last] = JSON.parse(gh.stdout);
  check(last, 'no successful ci run on main to measure');
  const secs = (Date.parse(last.updatedAt) - Date.parse(last.createdAt)) / 1000;
  check(secs < 240, `last green ci run on main took ${secs} s, want under 240 s`);
});
