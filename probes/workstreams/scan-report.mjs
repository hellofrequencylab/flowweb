// Probe for FW-C-027 (health and security scan stream, report-only): `pnpm probe workstreams/scan-report`.
// Tier 0.
// probe-timeout-s: 300
// Surfaces: runScanStream and listScanFindings exported by packages/daemon/src/index.ts, called with
// the Writer and Reader of the Store port on a fixture project; loadPolicy / decide from @fw/policy
// (FW-C-009); a real fwd (probes/lib/fwd.mjs) for POST /v1/ledger/rows/{id}/accept with a paired
// browser session; `fw ledger retest`; the database read-only.
// The surface this probe expects:
//   runScanStream({ writer, project_id, repo_dir }) [@fw/daemon] -> { role, findings, opened_prs }:
//     scans the repo offline (secrets, dependencies with a known advisory) and records each finding
//     once, keyed by a fingerprint, as a proposed item (not a ledger row yet). A second scan of the
//     same tree records nothing new. It never opens a pull request (opened_prs 0), and its role is
//     one the policy denies code_write_sandbox (decide(...).effect "deny").
//   listScanFindings(reader, { project_id }) [@fw/daemon] -> [{ id, kind: "secret" | "dependency",
//     fingerprint, path }]; secret findings never carry the secret's value.
//   POST /v1/ledger/rows/{finding id}/accept {} (a browser session) creates one ledger row with a
//     verify probe for the finding, answered with its code; that row's probe fails today, so
//     fw ledger retest <code> gives outcome ready.
//
// Proves, in order:
//   1. A seeded fake secret and a seeded vulnerable dependency each give exactly one finding, after
//      two scans, and no finding holds the secret.
//   2. Accepting a finding creates a ledger row whose probe fails today.
//   3. The stream cannot open a PR: the policy denies code_write for its role.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  check,
  count,
  dbPath,
  fakeSecret,
  fixtureProject,
  fw,
  fwJson,
  git,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  probe,
  requireExport,
  root,
  writeFiles,
} from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const ROW = 'FW-C-027';

await probe('workstreams/scan-report', async () => {
  const runScanStream = await requireExport('daemon', 'runScanStream', ROW);
  const listScanFindings = await requireExport('daemon', 'listScanFindings', ROW);
  const loadPolicy = await requireExport('policy', 'loadPolicy', 'FW-C-009');
  const decide = await requireExport('policy', 'decide', 'FW-C-009');
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

  const proj = fixtureProject({ rowId: 'FW-C-991' });
  const secret = fakeSecret('anthropic');
  writeFiles(proj.work, {
    'config/service.env': `SERVICE_URL=https://example.invalid\nAPI_KEY=${secret}\n`,
    'package.json': `${JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { lodash: '4.17.15' } }, null, 2)}\n`,
  });
  git(proj.work, 'add', '.');
  git(proj.work, 'commit', '-qm', 'seed a secret and a vulnerable dependency');
  git(proj.work, 'push', '-q', 'origin', 'main');
  const home = pipelineHome('scan');
  const env = pipelineEnv();
  const o = { home, cwd: proj.work, env, timeoutMs: 120000 };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed');
  let db = await openDbReadonly(home);
  const projectId = db.prepare("SELECT project_id FROM ledger_rows WHERE id = 'lr_FWC991'").get()?.project_id;
  const rowsBefore = count(db, 'SELECT count(*) FROM ledger_rows');
  db.close();

  // 1. Two scans, one finding each.
  let role;
  let findings;
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await runScanStream({ writer: store.writer, project_id: projectId, repo_dir: proj.work });
      check(r?.opened_prs === 0, `scan ${i + 1} opened ${r?.opened_prs} pull requests`);
      role = r.role;
    }
    findings = listScanFindings(store.writer, { project_id: projectId });
  } finally {
    store.close();
  }
  const secrets = findings.filter((f) => f.kind === 'secret');
  const deps = findings.filter((f) => f.kind === 'dependency');
  check(secrets.length === 1, `${secrets.length} secret findings after two scans, want 1`);
  check(deps.length === 1, `${deps.length} dependency findings after two scans, want 1`);
  check(!JSON.stringify(findings).includes(secret), 'a finding carries the secret value');
  db = await openDbReadonly(home);
  check(count(db, 'SELECT count(*) FROM ledger_rows') === rowsBefore, 'the scan wrote ledger rows before anyone accepted a finding');
  db.close();

  // 2. Accept one.
  const fwd = await startFwd(home, { env });
  let code;
  try {
    const session = await pair(fwd.port, fwd.pairingCode);
    const acc = await api(fwd.port, 'POST', `/v1/ledger/rows/${encodeURIComponent(deps[0].id)}/accept`, { auth: session, body: {} });
    check(acc.status === 200, `accepting the finding answered ${acc.status}: ${acc.text.slice(0, 200)}`);
    code = acc.json?.data?.code;
    check(code, 'the accept answer names no row code');
  } finally {
    await fwd.stop();
  }
  const rt = fwJson(['ledger', 'retest', code], o);
  check(rt.json?.outcome === 'ready', `the accepted row's probe does not fail today (retest outcome ${rt.json?.outcome})`);

  // 3. Policy.
  const policy = loadPolicy(join(root, 'contracts-core/core-policy.yaml'));
  const d = decide(policy, { action: 'code_write_sandbox', role, environment: 'sandbox' });
  check(d?.effect === 'deny', `the policy gives ${d?.effect} for code_write_sandbox by the scan stream's role ${role}`);
});
