// Shared helpers for the C0 probe pack. Tier 0, Owner-owned. Not a probe itself (the runner only
// executes probes/<path>.{mjs,sh,py,test.ts}, and no row names "c0/_lib").
//
// Conventions every C0 probe follows:
//   - Behaviour is tested through public surfaces only: the fw CLI (tsx packages/cli/src/bin.ts),
//     the Store port (openStore from packages/eventlog/src/index.ts), createAdapter from
//     packages/adapters/src/index.ts, named exports of a package index, and the SQLite database at
//     $FW_HOME/db/fw.sqlite opened READ-ONLY (except where a probe simulates an attacker).
//   - Each probe uses a fresh temporary FW_HOME.
//   - A failure prints one line starting with "FAIL <probe>:" or "MISSING <probe>:" first, so the
//     reason is readable without a stack trace. MISSING means the surface does not exist yet.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = resolve(process.env.FW_REPO_ROOT ?? join(import.meta.dirname, '../..'));
export const TSX = join(root, 'node_modules/.bin/tsx');
export const CLI_BIN = join(root, 'packages/cli/src/bin.ts');
export const DAEMON_BIN = join(root, 'packages/daemon/src/bin.ts');
export const ZERO_HASH = '0'.repeat(64);

export class ProbeFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'FAIL' | 'MISSING'
    this.name = kind; // vitest prints "MISSING: <message>" / "FAIL: <message>"
  }
}

export function fail(message) {
  throw new ProbeFailure('FAIL', message);
}
export function missing(message) {
  throw new ProbeFailure('MISSING', message);
}
export function check(cond, message) {
  if (!cond) fail(message);
}

/** Wraps a .mjs probe body: prints one clear first line and sets the exit code. */
export async function probe(name, body) {
  try {
    await body();
    console.log(`PASS ${name}`);
    process.exit(0);
  } catch (e) {
    if (e instanceof ProbeFailure) {
      console.error(`${e.kind} ${name}: ${e.message}`);
    } else {
      console.error(`FAIL ${name}: unexpected error: ${e?.stack ?? e}`);
    }
    process.exit(1);
  }
}

export function freshHome(tag = 'probe') {
  const home = mkdtempSync(join(tmpdir(), `fw-${tag}-`));
  return home;
}

export function tmpDir(tag = 'tmp') {
  return mkdtempSync(join(tmpdir(), `fw-${tag}-`));
}

export function requireFile(rel, what) {
  if (!existsSync(join(root, rel))) missing(`${rel} does not exist (${what})`);
}

/** Environment for child processes: the caller's env minus anything secret-shaped or FW_*. */
export function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k) && !k.startsWith('GIT_CONFIG_')) continue;
    if (k.startsWith('FW_') && k !== 'FW_REPO_ROOT') continue;
    env[k] = v;
  }
  return { ...env, NODE_NO_WARNINGS: '1', ...extra };
}

/**
 * Runs the fw CLI: tsx packages/cli/src/bin.ts <args>. Global --json is added by callers.
 * Returns { status, stdout, stderr, ms }.
 */
export function fw(args, { home, cwd = root, env = {}, timeoutMs = 60000, input } = {}) {
  if (!existsSync(CLI_BIN)) missing('packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006)');
  const started = Date.now();
  const r = spawnSync(TSX, [CLI_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    env: baseEnv({ FW_HOME: home, ...env }),
  });
  if (r.error?.code === 'ETIMEDOUT') fail(`fw ${args.join(' ')} did not finish within ${timeoutMs} ms`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - started };
}

/** fw with --json: requires exactly one JSON document on stdout; returns { status, json, stderr }. */
export function fwJson(args, opts) {
  const r = fw([...args, '--json'], opts);
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    fail(
      `fw ${args.join(' ')} --json did not print exactly one JSON document (exit ${r.status}); stdout starts: ${JSON.stringify(r.stdout.slice(0, 160))}; stderr starts: ${JSON.stringify(r.stderr.slice(0, 160))}`,
    );
  }
  return { ...r, json };
}

/**
 * Starts a TypeScript entry point (fwd, the fw CLI) as ONE node process with tsx as an import hook,
 * not through the tsx wrapper (which forks a second process). A SIGKILL then hits the program itself,
 * and this process stays its parent and reaps it, so no zombie keeps holding a pid-based lock.
 */
export function spawnTs(file, args, opts = {}) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  return spawnBg(process.execPath, ['--import', loader, file, ...args], opts);
}

/** Kills a child started by spawnBg/spawnTs and waits until it has exited (and been reaped). */
export async function killAndWait(child, signal = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(child.pid, signal);
  } catch {}
  await exited;
}

/** Starts a long-running child (for example fwd). Caller kills it. */
export function spawnBg(cmd, args, { cwd = root, env = {}, detached = true } = {}) {
  const child = spawn(cmd, args, { cwd, env: baseEnv(env), detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  child.output = () => out;
  return child;
}

export function dbPath(home) {
  return join(home, 'db', 'fw.sqlite');
}

/**
 * dbPath(home) with its db/ directory created, for probes that open the store directly. openStore
 * does not create directories (fwd and the CLI create $FW_HOME/db first).
 */
export function storePath(home) {
  mkdirSync(join(home, 'db'), { recursive: true });
  return dbPath(home);
}

/**
 * Installs the Tier 0 core-policy.yaml as $FW_HOME/config/core-policy.yaml, the first place the
 * work-order compiler looks (packages/ledger/src/policy.ts). The fixture repos do not carry one.
 */
export function installPolicy(home) {
  mkdirSync(join(home, 'config'), { recursive: true });
  cpSync(join(root, 'contracts-core/core-policy.yaml'), join(home, 'config/core-policy.yaml'));
  return home;
}

/** A fresh FW_HOME with the core policy installed, for probes that issue work orders or runs. */
export function pipelineHome(tag = 'pipe') {
  return installPolicy(freshHome(tag));
}

/** Opens $FW_HOME/db/fw.sqlite read-only with node:sqlite (independent of the implementation). */
export async function openDbReadonly(home) {
  const p = dbPath(home);
  if (!existsSync(p)) fail(`${p} does not exist after the command (the database lives at $FW_HOME/db/fw.sqlite)`);
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(p, { readOnly: true });
}

/** Opens the database read-write, bypassing the store. Only for probes that simulate tampering. */
export async function openDbAsAttacker(home) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath(home));
}

export function count(db, sql, ...params) {
  return Number(Object.values(db.prepare(sql).get(...params))[0]);
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** Hash of every file under dir (relative path + content), for "nothing changed" checks. */
export function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${relative(dir, p)}\0`).update(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
}

/** Recursively finds files under dir whose bytes contain needle. */
export function filesContaining(dir, needle) {
  const hits = [];
  const buf = Buffer.from(needle);
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(buf)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

/**
 * Canonical JSON as used by the reference chain in tests/schema_core_test.py: sorted keys, no
 * whitespace. Equal to RFC 8785 for the ASCII strings and integers these probes use.
 */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(',')}}`;
}

/**
 * Independent re-computation of the event chain: hash = sha256(prev_hash + "\n" + canonical(envelope
 * without hash)). Optional envelope fields that are NULL in the row (project_id, stream_id,
 * work_order_id, run_id, causation_id) are left out of the envelope, as the event-envelope contract
 * types them as strings and contracts-core/examples/20-event-envelope.json only reproduces that way
 * (docs/decisions/C0-owner-questions.md item 5; tests/schema_core_test.py hashes them as null, which
 * the Owner still has to reconcile). envelopeOfRow is checked against example 20 by c0/event-chain.
 */
export function envelopeOfRow(r) {
  const env = {
    seq: Number(r.seq),
    id: r.id,
    ts: r.ts,
    type: r.type,
    version: Number(r.version),
    actor: { kind: r.actor_kind, id: r.actor_id },
  };
  for (const k of ['project_id', 'stream_id', 'work_order_id', 'run_id']) if (r[k] != null) env[k] = r[k];
  env.correlation_id = r.correlation_id;
  if (r.causation_id != null) env.causation_id = r.causation_id;
  env.idempotency_key = r.idempotency_key;
  env.payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  env.payload_hash = r.payload_hash;
  env.prev_hash = r.prev_hash;
  return env;
}

export function recomputeChain(rows) {
  let prev = ZERO_HASH;
  for (const r of rows) {
    const env = envelopeOfRow(r);
    if (r.prev_hash !== prev) return { ok: false, seq: Number(r.seq), reason: 'prev_hash does not match' };
    if (r.payload_hash !== sha256(canonical(env.payload))) {
      return { ok: false, seq: Number(r.seq), reason: 'payload_hash does not match canonical payload' };
    }
    if (r.hash !== sha256(`${prev}\n${canonical(env)}`)) {
      return { ok: false, seq: Number(r.seq), reason: 'hash does not match the reference formula' };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length, head: prev };
}

/** A fake secret built at runtime so no secret-shaped literal sits in this repository. */
export function fakeSecret(kind = 'anthropic') {
  const body = 'FwProbeFake0'.repeat(8);
  if (kind === 'aws') return `AKIA${'FWPROBE0FAKE0000'.slice(0, 16)}`;
  if (kind === 'github') return `ghp_${body.slice(0, 36)}`;
  return `sk-${'ant'}-api03-${body}`;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: baseEnv({
      GIT_AUTHOR_NAME: 'probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
    }),
  });
  if (r.status !== 0) fail(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/**
 * A row definition for fixture projects (same shape as ledger/rows/*.json). The fake vendor's
 * success scenario writes fw-fake/<run_id>.md (docs/decisions/C0-owner-questions.md item 34), so the
 * default scope is fw-fake/** and the default probe passes once such a note exists. The scenario is
 * also a [fake:<name>] title tag (FW-C-007); pipeline probes pass it as `fw run start --scenario`.
 */
export function fixtureRow(
  id,
  {
    scenario = 'success',
    size = 'S',
    probe = 'node check-feature.mjs',
    depends_on = [],
    lane = 'kernel',
    files_hint = ['fw-fake/**'],
  } = {},
) {
  return {
    id,
    title: `Fixture row ${id} [fake:${scenario}]`,
    core_milestone: 'C0',
    phase: 0,
    epic: 'Probe fixture',
    priority: 'P1',
    size,
    lane,
    agent_suitability: 'agent',
    gate: 'none',
    depends_on,
    description: 'Fixture row used by the C0 probes.',
    acceptance: ['the fixture probe passes'],
    verify_probe: probe,
    files_hint,
  };
}

export const rowFile = (row) => ({ [`ledger/rows/${row.id}.json`]: `${JSON.stringify(row, null, 2)}\n` });

/** A repo with the given files, committed on main and pushed to a local bare remote (origin). */
export function projectFromFiles(files) {
  const base = tmpDir('proj');
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  mkdirSync(work);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'probe-owner');
  git(work, 'config', 'user.email', 'owner@example.invalid');
  git(work, 'config', 'commit.gpgsign', 'false');
  writeFiles(work, files);
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'fixture');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  return { base, remote, work };
}

/** The probe of the default fixture row: passes once a fake-vendor note exists under fw-fake/. */
export const CHECK_FEATURE = `import { existsSync, readdirSync } from 'node:fs';
process.exit(existsSync('fw-fake') && readdirSync('fw-fake').some((n) => n.endsWith('.md')) ? 0 : 1);
`;

/**
 * A fixture project: one row definition (FW-C-901 by default) whose probe fails until the fake
 * vendor has written its note, pushed to a local bare remote (origin). Row files live in the project
 * repo (item 36). CODEOWNERS and probes/ exist so forbidden_path has Tier 0 files to touch.
 */
export function fixtureProject({ scenario = 'success', rowId = 'FW-C-901', size = 'S', extraRows = [] } = {}) {
  const files = {
    'README.md': '# fixture project\n',
    'check-feature.mjs': CHECK_FEATURE,
    CODEOWNERS: '* @fixture-owner\n',
    'probes/README.md': 'fixture probes dir\n',
    ...rowFile(fixtureRow(rowId, { scenario, size })),
  };
  for (const r of extraRows) Object.assign(files, rowFile(fixtureRow(r.id, r)));
  return { ...projectFromFiles(files), rowId };
}

/** Row status straight from the database (ledger_rows.id is 'lr_' + the code without hyphens). */
export function rowStatusOf(db, code) {
  return db.prepare("SELECT status FROM ledger_rows WHERE id = 'lr_' || replace(?, '-', '')").get(code)?.status;
}

/** Branch names under a prefix (for example 'fw/') in a repository (a checkout or a bare remote). */
export function branches(repo, prefix = '') {
  return git(repo, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`)
    .split('\n')
    .filter(Boolean);
}

/** Environment for pipeline probes: fake vendor, local git host, no network, no keys. */
export function pipelineEnv(extra = {}) {
  return {
    FW_VENDOR: 'fake',
    FW_GIT_HOST: 'local',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
    ...extra,
  };
}

export function copyDir(src, dst) {
  cpSync(src, dst, { recursive: true, filter: (s) => !s.includes('node_modules') });
}

/** Directory entries, or [] when the directory does not exist. */
export function readdirSafe(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(fn, { timeoutMs = 10000, everyMs = 100, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) fail(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PIDs of processes whose command line contains marker (Linux /proc). */
export function pidsWithMarker(marker) {
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8');
      const env = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (cmd.includes(marker) || env.includes(marker)) out.push(Number(d));
    } catch {}
  }
  return out;
}

/** Imports a named export from a package index (TypeScript, so only from .test.ts probes). */
export async function requireExport(pkg, name, row) {
  const p = join(root, 'packages', pkg, 'src', 'index.ts');
  const mod = await import(p);
  if (typeof mod[name] === 'undefined') {
    missing(`packages/${pkg}/src/index.ts does not export ${name} (row ${row})`);
  }
  return mod[name];
}

/** Runs another probe through the runner; used by the thin wrappers that make backlog paths resolve. */
export function runProbe(path, extraArgs = []) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/probe.mjs'), path, ...extraArgs], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, FW_REPO_ROOT: root },
  });
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------------------------
// Adapter helpers, on the real adapter surface (packages/adapters/src/sdk/types.ts):
//   createAdapter(name, options?) -> VendorAdapter {
//     name, vendor, capabilities: { supports_resume, supports_schema, supports_budget_cap },
//     start(input, opts?) -> AdapterRun { events: AsyncIterable<AdapterEvent>, result, meta,
//                                          kill(reason), pgid() },
//     fingerprint(), preflight() }
//   The fake vendor picks its scenario from a "[fake:<scenario>]" tag in work_order.title
//   (FAKE_SCENARIOS in @fw/adapters; StartOptions.scenario overrides it).
// ---------------------------------------------------------------------------------------------

/** A scratch git repository with one commit, used as an adapter workspace (a run worktree). */
export function gitWorkspace(tag = 'ws') {
  const dir = tmpDir(tag);
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, { 'README.md': '# probe workspace\n', CODEOWNERS: '* @probe-owner\n' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'initial');
  return { path: dir, base_commit: git(dir, 'rev-parse', 'HEAD') };
}

/** vendor-adapter-input.json built from the contract example, pointed at a scratch git workspace. */
export function adapterInput({
  scenario = 'success',
  workspace,
  maxWallClockS = 30,
  maxUsd = 1.5,
  files = ['fw-fake/**'],
} = {}) {
  const input = JSON.parse(readFileSync(join(root, 'contracts-core/examples/19-vendor-adapter-input.json'), 'utf8'));
  const ws = workspace ? { path: workspace, base_commit: git(workspace, 'rev-parse', 'HEAD') } : gitWorkspace();
  input.run_id = `run_probe${Math.random().toString(36).slice(2, 10)}`;
  input.work_order.title = `Probe fixture [fake:${scenario}]`;
  input.work_order.scope.touches = files;
  input.work_order.base_commit = ws.base_commit;
  input.workspace = { path: ws.path, branch: 'fw/probe', base_commit: ws.base_commit, read_only: false };
  input.instruction_files = [];
  input.sandbox = { isolation: 'worktree_only', network_policy: 'deny_all' };
  input.budget.max_usd = maxUsd;
  input.work_order.budget.caps.max_usd = maxUsd;
  input.caps.max_wall_clock_s = maxWallClockS;
  input.budget.max_minutes = Math.max(1, Math.ceil(maxWallClockS / 60));
  return input;
}

/** Runs one adapter start() to completion; returns { events, result, meta, run, ms }. */
export async function drain(adapter, input, { timeoutMs = 60000, opts = {} } = {}) {
  const started = Date.now();
  const events = [];
  const run = adapter.start(input, { killGraceMs: 300, ...opts });
  const timer = setTimeout(() => {
    void run.kill('probe timeout');
  }, timeoutMs);
  try {
    for await (const ev of run.events) events.push(ev);
  } finally {
    clearTimeout(timer);
  }
  const [result, meta] = await Promise.all([run.result, run.meta]);
  return { events, result, meta, run, ms: Date.now() - started };
}

/**
 * True while any process of the group is alive. Zombies (state Z in /proc/<pid>/stat) do not count:
 * an orphaned vendor is reparented to an init that may never reap it, and a zombie runs nothing.
 */
export function groupAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    return e.code !== 'ESRCH';
  }
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(rest[2]) === pgid && rest[0] !== 'Z') return true;
  }
  return false;
}


export const RUN_RESULT_STATUSES = [
  'completed',
  'failed',
  'timeout',
  'budget_exceeded',
  'needs_input',
  'refused',
  'stopped',
];
