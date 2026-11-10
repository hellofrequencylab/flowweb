// Probe for FW-C-040 (the agents read the project brief before they work): `pnpm probe onboarding/brief-in-prompt`.
// Tier 0.
// probe-timeout-s: 180
// Surfaces: the fw CLI (`fw ledger sync`, `fw ledger retest`, `fw project list`, `fw project brief`,
// `fw wo issue`, `fw relay prompt`) on a fixture project, and contracts-core/json-schema/work-order.json.
// The surface this probe expects:
//   fw wo issue <row> --json -> { work_order: { constraints: { notes: [...], style: [...] } } }
//   When the row's project has a complete brief (FW-C-039), the issued work order carries it word for
//   word: the voice answer in constraints.style, and the other four answers (what, who, never, done) in
//   constraints.notes, so the content hash covers the brief the agent was given. With no brief the
//   work order is what it was before. A brief saved after an order is issued changes only the next
//   order, never one already issued.
//   fw relay prompt <order> prints a prompt that holds every answer of the brief.
//
// Proves, in order:
//   1. A row issued before the project has a brief carries none of its answers.
//   2. After `fw project brief`, the next order carries all five answers word for word (voice in style)
//      and still validates against work-order.json.
//   3. The order issued before the brief is unchanged (same content hash in the database).
//   4. The paste-ready relay prompt for the new order holds all five answers.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECK_FEATURE,
  check,
  fixtureRow,
  fw,
  fwJson,
  missing,
  openDbReadonly,
  pipelineHome,
  probe,
  projectFromFiles,
  root,
  rowFile,
  tmpDir,
} from '../c0/_lib.mjs';

const BRIEF = {
  what: 'A spring sign-up push for the Eastside neighborhood circle',
  who: 'Neighbors who came to one event and never came back',
  voice: 'Warm and plain, like a note from a friend; no exclamation marks',
  never: 'Never promise a discount or name another neighbor',
  done: 'Forty new sign-ups by April 30 with no complaints',
};

await probe('onboarding/brief-in-prompt', async () => {
  const proj = projectFromFiles({
    'check-feature.mjs': CHECK_FEATURE,
    ...rowFile(fixtureRow('FW-C-951')),
    ...rowFile(fixtureRow('FW-C-952')),
  });
  const home = pipelineHome('brief');
  const o = { home, cwd: proj.work };
  check(fw(['ledger', 'sync', '--json'], o).status === 0, 'fw ledger sync failed on the fixture');
  for (const id of ['FW-C-951', 'FW-C-952']) {
    const r = fwJson(['ledger', 'retest', id], o);
    check(r.json?.outcome === 'ready', `fw ledger retest ${id} did not make it ready`);
  }
  const has = (text, a) => text.includes(a);
  const all = (text) => Object.values(BRIEF).filter((a) => !has(text, a));

  // 1. Before any brief.
  const before = fwJson(['wo', 'issue', 'FW-C-951'], o);
  check(before.status === 0, `fw wo issue FW-C-951 exited ${before.status}: ${before.stdout.slice(0, 200)}`);
  const wa = before.json.work_order;
  const leaked = Object.values(BRIEF).filter((a) => has(JSON.stringify(wa), a));
  check(leaked.length === 0, 'an order issued before any brief carries brief text');

  // The fixture row's project, by its slug.
  const list = fwJson(['project', 'list'], o);
  check(list.status === 0, `fw project list exited ${list.status}`);
  const projects = Array.isArray(list.json) ? list.json : (list.json?.projects ?? []);
  const slug = projects.find((p) => p.id === wa.project_id)?.slug;
  check(slug, `fw project list does not show the row's project ${wa.project_id}`);

  const b = fw(['project', 'brief', slug, ...Object.entries(BRIEF).flatMap(([k, v]) => [`--${k}`, v])], o);
  if (b.status !== 0 && /unknown command|not found/i.test(b.stdout + b.stderr)) missing('fw project brief does not exist');
  check(b.status === 0, `fw project brief ${slug} exited ${b.status}: ${(b.stdout + b.stderr).slice(0, 200)}`);

  // 2. The next order carries the brief, voice as style.
  const after = fwJson(['wo', 'issue', 'FW-C-952'], o);
  check(after.status === 0, `fw wo issue FW-C-952 exited ${after.status}: ${after.stdout.slice(0, 200)}`);
  const wb = after.json.work_order;
  const notes = (wb.constraints?.notes ?? []).join('\n');
  const style = (wb.constraints?.style ?? []).join('\n');
  if (!has(notes + style, BRIEF.what)) missing('fw wo issue does not put the project brief into the work order');
  check(has(style, BRIEF.voice), `constraints.style does not carry the brief's voice: ${JSON.stringify(wb.constraints?.style)}`);
  for (const k of ['what', 'who', 'never', 'done'])
    check(has(notes, BRIEF[k]), `constraints.notes does not carry the brief's ${k} answer word for word`);
  const tmp = join(tmpDir('brief-wo'), 'wo.json');
  writeFileSync(tmp, JSON.stringify(wb));
  const v = spawnSync('python3', ['-I', join(root, 'probes/c0/fixtures/validate-json.py'), 'work-order.json', tmp], {
    encoding: 'utf8',
  });
  if (v.status === 3) missing(v.stderr.trim());
  check(v.status === 0, `the briefed work order does not validate: ${v.stderr.trim().split('\n')[0]}`);

  // 3. The earlier order is untouched.
  const db = await openDbReadonly(home);
  const stored = db.prepare('SELECT content_hash, body FROM work_orders WHERE id = ?').get(wa.id);
  db.close();
  check(stored?.content_hash === wa.content_hash, 'the order issued before the brief changed its content hash');
  check(all(stored.body).length === 5, 'the order issued before the brief now carries brief text');

  // 4. The relay prompt holds the brief.
  const p = fwJson(['relay', 'prompt', wb.id], o);
  check(p.status === 0, `fw relay prompt ${wb.id} exited ${p.status}: ${(p.stdout + p.stderr).slice(0, 200)}`);
  const prompt = String(p.json?.prompt ?? '');
  const lost = all(prompt);
  check(lost.length === 0, `the relay prompt is missing ${lost.length} brief answer(s)`);
});
