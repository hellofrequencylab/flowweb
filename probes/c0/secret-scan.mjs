// Probe c0/secret-scan (WS-P0-005; backlog verify_probe security/secret-scan-fixture).
// Acceptance:
//   - Committing a string matching an API key pattern is blocked locally: .husky/pre-commit runs
//     gitleaks, and in a scratch repo with that hook installed a commit of a fake key is refused
//     while a clean commit goes through.
//   - CI fails on the same string: the secret-scan job runs gitleaks with .gitleaks.toml (no longer
//     the placeholder), and gitleaks with that config exits nonzero on the fake key.
//   - An allowlist file exists and is Tier 0: .gitleaks.toml exists and scripts/check-tier0.mjs
//     classifies it as Tier 0.
// The fake key is assembled at runtime; no secret-shaped literal is stored in this file.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, fakeSecret, git, missing, probe, root, tmpDir, writeFiles } from './_lib.mjs';

await probe('c0/secret-scan', async () => {
  const cfg = join(root, '.gitleaks.toml');
  if (!existsSync(cfg)) missing('.gitleaks.toml does not exist (secret-scan allowlist, row WS-P0-005)');
  const hook = join(root, '.husky/pre-commit');
  if (!existsSync(hook)) missing('.husky/pre-commit does not exist (local secret scan, row WS-P0-005)');
  check(/gitleaks/.test(readFileSync(hook, 'utf8')), '.husky/pre-commit does not run gitleaks');

  const { matchTier0 } = await import(join(root, 'scripts/check-tier0.mjs'));
  check(matchTier0('.gitleaks.toml'), '.gitleaks.toml is not a Tier 0 path in scripts/check-tier0.mjs');

  const wf = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = wf.split(/\n {2}(?=[a-z0-9-]+:\n)/).find((b) => b.startsWith('secret-scan:')) ?? '';
  check(job, 'ci.yml has no secret-scan job');
  check(!/placeholder/i.test(job), 'the ci.yml secret-scan job is still the placeholder');
  check(/gitleaks/.test(job), 'the ci.yml secret-scan job does not run gitleaks');

  const v = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (v.error) missing('gitleaks is not installed on this machine (absent is reported, never treated as clean)');

  // CI-equivalent: gitleaks with the repo config flags the fake key, passes a clean tree.
  const dirty = tmpDir('leak');
  writeFiles(dirty, { 'config.ts': `export const key = '${fakeSecret('anthropic')}';\n` });
  const clean = tmpDir('noleak');
  writeFiles(clean, { 'config.ts': "export const key = process.env.API_KEY ?? '';\n" });
  const scan = (dir) =>
    spawnSync('gitleaks', ['detect', '--no-git', '--source', dir, '--config', cfg, '--no-banner', '--redact'], {
      encoding: 'utf8',
    }).status;
  check(scan(dirty) !== 0, 'gitleaks with .gitleaks.toml exits 0 on a tree holding an API-key-shaped string');
  check(scan(clean) === 0, 'gitleaks with .gitleaks.toml flags a clean tree');

  // Local: the pre-commit hook refuses the commit.
  const repo = tmpDir('hook');
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, '.git/hooks'), { recursive: true });
  copyFileSync(hook, join(repo, '.git/hooks/pre-commit'));
  chmodSync(join(repo, '.git/hooks/pre-commit'), 0o755);
  copyFileSync(cfg, join(repo, '.gitleaks.toml'));
  writeFiles(repo, { 'ok.txt': 'fine\n' });
  spawnSync('git', ['add', '.'], { cwd: repo });
  const ok = spawnSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@example.invalid', 'commit', '-qm', 'ok'], {
    cwd: repo,
    encoding: 'utf8',
  });
  check(ok.status === 0, `pre-commit hook refuses a clean commit: ${ok.stderr.trim().split('\n')[0]}`);
  writeFiles(repo, { 'leak.ts': `const k = '${fakeSecret('anthropic')}';\n` });
  spawnSync('git', ['add', '.'], { cwd: repo });
  const bad = spawnSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@example.invalid', 'commit', '-qm', 'leak'], {
    cwd: repo,
    encoding: 'utf8',
  });
  check(bad.status !== 0, 'pre-commit hook lets a commit with an API-key-shaped string through');
});
