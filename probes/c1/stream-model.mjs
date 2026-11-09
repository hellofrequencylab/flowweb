// Probe c1/stream-model (WS-P1-003; backlog verify_probe kernel/stream-model).
// Surfaces: the fw CLI (`fw stream add -f <file>`, `fw stream list`, both with --json), the
// `streams` table and the `stream.created` event in $FW_HOME/db/fw.sqlite (schema.core.sql), read
// with node:sqlite read-only, and @fw/contracts `validate` (run in a child process) to prove the
// fixtures themselves are what the probe says they are.
// A stream definition is contracts-core/json-schema/stream-definition.json; the fixtures start from
// contracts-core/examples/24-stream-definition.json and use only fields that schema defines.
// Acceptance (WS-P1-003):
//   1. a stream without a budget is rejected (no budget object, or a budget with no caps)
//   2. an autonomy tier above L2 requires a recorded Owner approval id (no id: rejected; an id that
//      is not a recorded approval: rejected)
//   3. streams are listed by `fw stream list`
// How each line is read (see probes/c1/README.md, "Decisions for the Owner"):
//   - The create surface is `fw stream add -f <file>`, the form another C1 row's acceptance already
//     names. A rejection exits 1 or 3 (never 2, a usage error), names the reason, and writes no
//     streams row and no stream.created event.
//   - "Autonomy tier" is the definition's default_tier (the streams.default_tier column). tier_caps
//     is left out of the fixtures so it cannot decide the outcome.
//   - The approval id is passed as `fw stream add -f <file> --approval <apr_id>`. stream-definition.json
//     has no field for it (additionalProperties: false). Only the refusal side is probed: recording
//     a real Owner approval has no surface yet, so "L3 with a recorded approval is accepted" is not.
//   - Accepted streams: one streams row each (definition stored, definition_hash 64 hex, the
//     project, key and default_tier from the file) and one stream.created event each.
//   - `fw stream list --json` lists exactly the stream ids in the database, including the backlog
//     stream `fw ledger sync` bootstraps.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  baseEnv,
  check,
  count,
  fail,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  missing,
  openDbReadonly,
  probe,
  root,
  tmpDir,
} from '../c0/_lib.mjs';

const example = () => JSON.parse(readFileSync(join(root, 'contracts-core/examples/24-stream-definition.json'), 'utf8'));

function definition(projectId, { id, key, tier = 'L2', trigger, budget = 'keep' }) {
  const d = example();
  d.id = id;
  d.key = key;
  d.name = `Probe stream ${key}`;
  d.project_id = projectId;
  d.version = 1;
  d.default_tier = tier;
  delete d.tier_caps;
  d.inputs = d.inputs.map((i) => ({ ...i, ref: i.kind === 'ledger_rows' ? `ledger://${projectId}?status=ready` : i.ref }));
  if (trigger) d.trigger = trigger;
  if (budget === 'none') delete d.budget;
  else if (budget === 'empty') d.budget = { caps: {}, period: 'day' };
  return d;
}

/** Validates each definition against stream-definition.json with @fw/contracts, in a tsx child. */
function contractErrors(defs) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const contracts = pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href;
  const code = `import { validate } from ${JSON.stringify(contracts)};
const defs = JSON.parse(process.argv[1]);
console.log(JSON.stringify(defs.map((d) => validate('stream-definition', d).errors.map((e) => e.path + ' ' + e.message))));`;
  const r = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code, JSON.stringify(defs)], {
    cwd: root,
    encoding: 'utf8',
    env: baseEnv(),
  });
  if (r.status !== 0) fail(`could not validate the fixtures with @fw/contracts: ${r.stderr.trim().split('\n')[0]}`);
  return JSON.parse(r.stdout);
}

function streamIds(db) {
  return db
    .prepare('SELECT id FROM streams ORDER BY id')
    .all()
    .map((r) => r.id);
}

/** Every string in a JSON document that looks like a stream id. */
function idsIn(doc, out = new Set()) {
  if (typeof doc === 'string' && /^stm_[0-9A-Za-z]{4,40}$/.test(doc)) out.add(doc);
  else if (doc && typeof doc === 'object') for (const v of Object.values(doc)) idsIn(v, out);
  return out;
}

await probe('c1/stream-model', async () => {
  const proj = fixtureProject({ rowId: 'FW-C-962' });
  const home = freshHome('c1-stream');
  const o = { home, cwd: proj.work };
  const help = fwJson(['--help'], o);
  const usages = (help.json?.commands ?? []).map((c) => (typeof c === 'string' ? c : c.usage));
  for (const c of ['stream add', 'stream list']) {
    if (!usages.some((u) => u.startsWith(`fw ${c}`))) missing(`fw --help lists no "fw ${c}" command`);
  }
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture project');
  let db = await openDbReadonly(home);
  const projectId = db.prepare('SELECT id FROM projects').get()?.id;
  db.close();
  check(projectId, 'fw ledger sync created no project');

  const defs = {
    cron: definition(projectId, { id: 'stm_probecron01', key: 'probe-cron' }),
    manual: definition(projectId, { id: 'stm_probemanual1', key: 'probe-manual', tier: 'L1', trigger: { type: 'manual' } }),
    noBudget: definition(projectId, { id: 'stm_probenobud01', key: 'probe-nobudget', budget: 'none' }),
    emptyBudget: definition(projectId, { id: 'stm_probeempty01', key: 'probe-emptybudget', budget: 'empty' }),
    l3: definition(projectId, { id: 'stm_probel3tier1', key: 'probe-l3', tier: 'L3' }),
  };
  const errs = contractErrors(Object.values(defs));
  const byName = Object.fromEntries(Object.keys(defs).map((k, i) => [k, errs[i]]));
  for (const k of ['cron', 'manual', 'l3']) {
    check(byName[k].length === 0, `fixture ${k} is not a valid stream definition: ${byName[k].join('; ')}`);
  }
  check(byName.noBudget.some((e) => /budget/.test(e)), 'fixture noBudget does not fail the contract on budget');
  check(byName.emptyBudget.some((e) => /budget/.test(e)), 'fixture emptyBudget does not fail the contract on budget');

  const dir = tmpDir('c1-stream-defs');
  const file = (name) => {
    const p = join(dir, `${name}.json`);
    writeFileSync(p, `${JSON.stringify(defs[name], null, 2)}\n`);
    return p;
  };
  const add = (name, extra = []) => fw(['stream', 'add', '-f', file(name), ...extra, '--json'], o);

  db = await openDbReadonly(home);
  const bootstrapped = streamIds(db);
  db.close();

  // ---- line 1: no budget, rejected ------------------------------------------------------------
  const first = add('noBudget');
  const refused = async (r, name, reason, why) => {
    check(r.status === 1 || r.status === 3, `fw stream add (${name}) exited ${r.status}, want 1 or 3 (${why}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    check(reason.test(r.stdout + r.stderr), `the refusal of ${name} does not name the reason (${reason}): ${(r.stdout + r.stderr).slice(0, 200)}`);
    const d = await openDbReadonly(home);
    const ids = streamIds(d);
    const created = count(d, "SELECT count(*) FROM events WHERE type = 'stream.created' AND stream_id = ?", defs[name].id);
    d.close();
    check(!ids.includes(defs[name].id), `the refused stream ${name} was stored`);
    check(created === 0, `the refused stream ${name} has a stream.created event`);
  };
  await refused(first, 'noBudget', /budget/i, 'a stream without a budget is rejected');
  await refused(add('emptyBudget'), 'emptyBudget', /budget|caps/i, 'a budget with no caps is no budget');

  // ---- line 2: tier above L2 needs a recorded Owner approval id --------------------------------
  await refused(add('l3'), 'l3', /approv/i, 'tier L3 without an approval id');
  await refused(add('l3', ['--approval', 'apr_probenotrecorded']), 'l3', /approv/i, 'tier L3 with an approval id that is not recorded');

  // ---- accepted streams are stored, one event each --------------------------------------------
  for (const name of ['cron', 'manual']) {
    const r = add(name);
    check(r.status === 0, `fw stream add (${name}, ${defs[name].default_tier}, with a budget) exited ${r.status}: ${(r.stdout + r.stderr).slice(0, 200)}`);
    const d = await openDbReadonly(home);
    const row = d.prepare('SELECT * FROM streams WHERE id = ?').get(defs[name].id);
    const created = count(d, "SELECT count(*) FROM events WHERE type = 'stream.created' AND stream_id = ?", defs[name].id);
    d.close();
    check(row, `stream ${defs[name].id} is not in the streams table after fw stream add`);
    check(
      row.project_id === projectId && row.key === defs[name].key && row.default_tier === defs[name].default_tier,
      `stream ${defs[name].id} stored as project ${row.project_id}, key ${row.key}, tier ${row.default_tier}`,
    );
    check(/^[0-9a-f]{64}$/.test(row.definition_hash), `stream ${defs[name].id} has no sha256 definition_hash`);
    check(
      JSON.stringify(JSON.parse(row.definition).budget) === JSON.stringify(defs[name].budget),
      `stream ${defs[name].id} does not store its budget in the definition`,
    );
    check(created === 1, `stream ${defs[name].id} has ${created} stream.created events, want 1`);
  }

  // ---- line 3: fw stream list -------------------------------------------------------------------
  db = await openDbReadonly(home);
  const all = streamIds(db);
  db.close();
  check(all.length === bootstrapped.length + 2, `the streams table holds ${all.length} streams, want ${bootstrapped.length + 2}`);
  const list = fw(['stream', 'list', '--json'], o);
  check(list.status === 0, `fw stream list --json exited ${list.status}: ${(list.stdout + list.stderr).slice(0, 200)}`);
  let doc;
  try {
    doc = JSON.parse(list.stdout);
  } catch {
    fail('fw stream list --json did not print exactly one JSON document');
  }
  const listed = [...idsIn(doc)].sort();
  check(
    JSON.stringify(listed) === JSON.stringify(all),
    `fw stream list lists ${listed.join(', ') || 'nothing'}; the database holds ${all.join(', ')}`,
  );
});
