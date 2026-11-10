// Probe for FW-C-014 (verifier role: read-only, clean context, different vendor):
// `pnpm probe runtime/verifier-role`. Tier 0.
// probe-timeout-s: 180
// Surfaces: the exports below on scratch git repos; prompts/review-adversarial.md.
// The surface this probe expects:
//   pickReviewer({ maker, available: string[] }) [@fw/adapters] -> { adapter, same_vendor_review }:
//     another vendor's adapter when one is available (maker claude with claude and codex -> codex,
//     same_vendor_review false); the maker's own adapter with same_vendor_review true when it is the
//     only one. Order of preference follows config/routing.json "prefer".
//   verifierExec({ worktree, argv }) [@fw/daemon] -> { code, stdout, stderr }: runs a command the way
//     the verifier runs its tools, with the worktree read-only; a write into the worktree fails
//     (nonzero exit) and leaves no file, whoever the process runs as.
//   runVerifier({ adapter: "fake", worktree, base, head, probe_command }) [@fw/daemon] ->
//     { verdict: "concur" | "object", same_vendor_review, findings: [{ summary, repro_command }] }.
//     The fake verifier path runs probe_command read-only in a clean context; on failure it objects
//     with a finding whose repro_command, run in the worktree, fails the same way. A correct change
//     gets concur and no findings.
//   prompts/review-adversarial.md exists and names no vendor.
//
// Proves, in order:
//   1. Reviewer choice: a different vendor when two are configured, same_vendor_review when one.
//   2. The verifier cannot write to the worktree.
//   3. A planted bug is caught by the fake verifier with a reproduction command that fails; the fixed
//      change is concurred.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, git, missing, probe, projectFromFiles, requireExport, root, writeFiles } from '../c0/_lib.mjs';

const ROW = 'FW-C-014';
const TEST = `import { add } from './add.mjs';
if (add(2, 3) !== 5) { console.error('add(2, 3) is ' + add(2, 3) + ', want 5'); process.exit(1); }
`;

await probe('runtime/verifier-role', async () => {
  const pickReviewer = await requireExport('adapters', 'pickReviewer', ROW);
  const verifierExec = await requireExport('daemon', 'verifierExec', ROW);
  const runVerifier = await requireExport('daemon', 'runVerifier', ROW);

  // 1. Reviewer choice.
  const two = pickReviewer({ maker: 'claude', available: ['claude', 'codex'] });
  check(two?.adapter === 'codex' && two.same_vendor_review === false, `maker claude with claude and codex got ${JSON.stringify(two)}`);
  const back = pickReviewer({ maker: 'codex', available: ['claude', 'codex'] });
  check(back?.adapter === 'claude' && back.same_vendor_review === false, `maker codex with claude and codex got ${JSON.stringify(back)}`);
  const one = pickReviewer({ maker: 'claude', available: ['claude'] });
  check(one?.adapter === 'claude' && one.same_vendor_review === true, `a single-vendor config got ${JSON.stringify(one)}`);

  const promptPath = join(root, 'prompts/review-adversarial.md');
  if (!existsSync(promptPath)) missing('prompts/review-adversarial.md does not exist');
  check(!/\b(claude|codex|anthropic|openai|gpt|gemini)\b/i.test(readFileSync(promptPath, 'utf8')), 'the review prompt names a vendor');

  // A repo with a correct base and a buggy head.
  const proj = projectFromFiles({ 'add.mjs': 'export const add = (a, b) => a + b;\n', 'add.test.mjs': TEST });
  const base = git(proj.work, 'rev-parse', 'HEAD').trim();
  git(proj.work, 'checkout', '-q', '-b', 'buggy');
  writeFiles(proj.work, { 'add.mjs': 'export const add = (a, b) => a - b;\n' });
  git(proj.work, 'commit', '-qam', 'refactor add');
  const buggy = git(proj.work, 'rev-parse', 'HEAD').trim();

  // 2. Read-only worktree.
  const w = await verifierExec({ worktree: proj.work, argv: ['sh', '-c', 'echo planted > planted.txt'] });
  check(w?.code !== 0, 'a write into the worktree succeeded under the verifier');
  check(!existsSync(join(proj.work, 'planted.txt')), 'the verifier left a file in the worktree');
  const r = await verifierExec({ worktree: proj.work, argv: ['cat', 'add.mjs'] });
  check(r?.code === 0 && /a - b/.test(r.stdout), 'the verifier cannot read the worktree');

  // 3. Planted bug.
  const probeCommand = 'node add.test.mjs';
  const v = await runVerifier({ adapter: 'fake', worktree: proj.work, base, head: buggy, probe_command: probeCommand });
  check(v?.verdict === 'object', `the fake verifier gave ${v?.verdict} on a planted bug, want object`);
  const f = v.findings?.[0];
  check(typeof f?.repro_command === 'string' && f.repro_command.length > 0, 'the objection carries no reproduction command');
  const repro = spawnSync('sh', ['-c', f.repro_command], { cwd: proj.work, encoding: 'utf8' });
  check(repro.status !== 0, `the reproduction command passed on the buggy head: ${f.repro_command}`);
  git(proj.work, 'checkout', '-q', 'main');
  const ok = await runVerifier({ adapter: 'fake', worktree: proj.work, base, head: base, probe_command: probeCommand });
  check(ok?.verdict === 'concur' && (ok.findings ?? []).length === 0, `the fake verifier gave ${JSON.stringify(ok)} on a correct change`);
});
