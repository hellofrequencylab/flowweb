// Probe for FW-C-106 (Frequency host events become personal notes from the Owner): `pnpm probe flows/host-moments`.
// Tier 0.
// Surfaces: flows/host-moments/stream.json (validated with validate('stream-definition') from @fw/contracts),
// scanEvents in packages/daemon/src/flows/host-moments.ts on fresh realpath FW_HOMEs, ENGINES in
// packages/daemon/src/overseer/index.ts, and the drafts listDrafts in packages/daemon/src/overseer/drafts.ts
// serves. The TypeScript is loaded with the repo's tsx loader in a child.
//
// The surface this probe expects:
//   scanEvents({ repoRoot, fwHome, now, draft: true }) reads $FW_HOME/flows/host-moments/events/*.json (one
//   Frequency event per file, contract v1 shapes), moves each handled file to events/done/, writes drafts to
//   $FW_HOME/flows/host-moments/drafts/<id>.json (status waiting_for_owner, a kind field naming the moment) and
//   resolves to a report whose skipped entries ({ file, type, reason }) say why an event made no draft.
//   Opted-out hosts go on $FW_HOME/flows/neighborhood-activation/state.json do_not_contact as frequency-host:<id>.
//
// Proves, in order:
//   1. The flow ships: stream.json is a valid stream definition, template email, trigger event, tier L1, shipped
//      enabled exactly like neighborhood-activation, and fwd has an engine for it.
//   2. Six event files (stall, publish, filled, 8 RSVPs, meter at 80%, opt-out) plus the host's event.published
//      give one draft each of stall_nudge, thank_you, referral_ask, value_moment and limit_note, with no em or
//      en dash, the first name or "Hi there", ref kept, and every file moved to events/done.
//   3. The thank-you carries the share kit: Instagram caption, story text, a WhatsApp or email blurb and a QR
//      poster link, all pointing at the event's RSVP page.
//   4. The opted-out host is on the do-not-contact list, and a later event for them makes no draft.
//   5. A second stall at the same step makes no second draft; a stall at another step does.
//   6. With no facts sheet, event.rsvps_8 makes no value_moment draft and the report says facts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/host-moments';
const KEY = 'host-moments';
const MOD = join(root, 'packages/daemon/src/flows/host-moments.ts');
const INDEX = join(root, 'packages/daemon/src/overseer/index.ts');
const CONTRACTS = join(root, 'packages/contracts/src/index.ts');
const NOW = '2026-11-11T18:00:00.000Z';
const RSVP = 'https://frequencylocal.com/e/sunset-sound-bath';

function runTs(code) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });
  check(r.status === 0, `loading the TypeScript failed: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const scan = (home) =>
  runTs(`
    const m = await import(${JSON.stringify(pathToFileURL(MOD).href)});
    const r = await m.scanEvents({ repoRoot: ${JSON.stringify(root)}, fwHome: ${JSON.stringify(home)}, now: new Date(${JSON.stringify(NOW)}), draft: true });
    console.log(JSON.stringify(r));
  `);

function drop(home, name, event) {
  const dir = join(home, 'flows', KEY, 'events');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(event));
}

function drafts(home) {
  const dir = join(home, 'flows', KEY, 'drafts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

const ev = (type, host, extra = {}) => ({ type, at: '2026-11-11T16:00:00.000Z', space_id: `spc_${host}`, host_id: host, ...extra });

await probe(NAME, async () => {
  if (!existsSync(join(root, 'flows', KEY, 'stream.json'))) missing('flows/host-moments/stream.json does not exist (row FW-C-106)');
  if (!existsSync(MOD)) missing('packages/daemon/src/flows/host-moments.ts does not exist (row FW-C-106)');

  // 1. The flow ships.
  const stream = JSON.parse(readFileSync(join(root, 'flows', KEY, 'stream.json'), 'utf8'));
  const na = JSON.parse(readFileSync(join(root, 'flows/neighborhood-activation/stream.json'), 'utf8'));
  const shipped = runTs(`
    const c = await import(${JSON.stringify(pathToFileURL(CONTRACTS).href)});
    const s = await import(${JSON.stringify(pathToFileURL(INDEX).href)});
    const def = ${JSON.stringify(stream)};
    const v = c.validate('stream-definition', def);
    const f = s.ENGINES[${JSON.stringify(KEY)}]?.(${JSON.stringify(root)}, '/nonexistent-fw-home', new Date());
    console.log(JSON.stringify({ ok: v.ok, errors: v.ok ? [] : v.errors, engine: !!f, outward: f?.outward ?? null }));
  `);
  check(shipped.ok, `stream.json is not a valid stream definition: ${JSON.stringify(shipped.errors).slice(0, 300)}`);
  check(stream.key === KEY && stream.template === 'email', `stream.json key ${stream.key}, template ${stream.template}`);
  check(stream.trigger?.type === 'event', `stream.json trigger is ${stream.trigger?.type}, not event`);
  check(stream.default_tier === 'L1', `stream.json default_tier is ${stream.default_tier}`);
  check(stream.enabled === na.enabled, `stream.json enabled ${stream.enabled}, neighborhood-activation ships ${na.enabled}`);
  check(shipped.engine, 'fwd has no engine for host-moments, so the Supervisor holds it by no_engine');

  // 2. Six event files and the host's published event.
  const home = realpathSync(freshHome('host-moments'));
  writeFileSync(join(home, 'facts.json'), JSON.stringify({ founding_price: '$120 a year', founding_ends: '2027-01-30', plan_price: '$12 a month' }));
  drop(home, '00-published', ev('event.published', 'h1', { event_id: 'evt1', title: 'Sunset Sound Bath', starts_at: '2026-11-21T02:00:00.000Z', town: 'Encinitas', niche: 'sound-bath', rsvp_url: RSVP }));
  drop(home, '01-stalled', ev('launcher.stalled', 'h2', { step: 'Add your first event', idle: '1h' }));
  drop(home, '02-space', ev('space.published', 'h1', { detail: 'Sunset Sound Bath Circle', first_name: 'Maya', ref: 'sound-bath.fire1-d0' }));
  drop(home, '03-filled', ev('event.filled', 'h1', { event_title: 'Sunset Sound Bath', first_name: 'Maya' }));
  drop(home, '04-rsvps', ev('event.rsvps_8', 'h1', { rsvps: 9, non_host_rsvps: 6, event_title: 'Sunset Sound Bath', first_name: 'Maya' }));
  drop(home, '05-meter', ev('meter.80', 'h1', { meter: 'members', used: 40, limit: 50, first_name: 'Maya' }));
  drop(home, '06-optout', ev('host.opted_out', 'h3'));
  scan(home);

  const all = drafts(home);
  const kinds = all.map((d) => d.kind).sort();
  const want = ['limit_note', 'referral_ask', 'stall_nudge', 'thank_you', 'value_moment'];
  check(JSON.stringify(kinds) === JSON.stringify(want), `drafts by kind: ${JSON.stringify(kinds)}, want ${JSON.stringify(want)}`);
  for (const d of all) {
    check(d.status === 'waiting_for_owner', `${d.kind} has status ${d.status}`);
    check(!/[–—]/.test(`${d.subject}\n${d.body}`), `${d.kind} holds an em or en dash`);
    check(!/\p{Extended_Pictographic}/u.test(`${d.subject}\n${d.body}`), `${d.kind} holds an emoji`);
    check(typeof d.lead_id === 'string' && d.lead_id.length > 0, `${d.kind} names no lead`);
  }
  const by = (k) => all.find((d) => d.kind === k);
  check(/^Hi there\b/.test(by('stall_nudge').body), `the stall note without a first name does not open "Hi there": ${by('stall_nudge').body.slice(0, 40)}`);
  check(by('stall_nudge').body.includes('Add your first event'), 'the stall note does not name the step');
  check(/10 minute/.test(by('stall_nudge').body), 'the stall note does not offer a 10 minute call');
  check(/^Hi Maya\b/.test(by('thank_you').body), 'the thank-you does not greet the host by first name');
  check(by('thank_you').body.includes('Sunset Sound Bath Circle'), 'the thank-you does not name the payload detail');
  check(by('thank_you').ref === 'sound-bath.fire1-d0', `the thank-you ref is ${by('thank_you').ref}`);
  check(typeof by('thank_you').due_at === 'string' && Date.parse(by('thank_you').due_at) - Date.parse('2026-11-11T16:00:00.000Z') <= 48 * 3600e3, `the thank-you due_at is ${by('thank_you').due_at}`);
  check(by('value_moment').body.includes('9') && by('value_moment').body.includes('$120 a year'), 'the Founding Year note does not use the payload count and the facts sheet price');
  check(/forward/i.test(by('referral_ask').body), 'the referral ask has no forwardable intro');
  const done = readdirSync(join(home, 'flows', KEY, 'events', 'done')).filter((f) => f.endsWith('.json'));
  const left = readdirSync(join(home, 'flows', KEY, 'events')).filter((f) => f.endsWith('.json'));
  check(done.length === 7 && left.length === 0, `events/done holds ${done.length} files and ${left.length} are left`);

  // 3. The share kit.
  const tb = by('thank_you').body;
  for (const part of [/Instagram/i, /story/i, /WhatsApp/i, /QR/i])
    check(part.test(tb), `the share kit has no ${part.source} part`);
  check(tb.split(RSVP).length - 1 >= 3, 'the share kit does not point at the RSVP page from each part');

  // 4. The opt-out.
  const state = JSON.parse(readFileSync(join(home, 'flows/neighborhood-activation/state.json'), 'utf8'));
  check(Array.isArray(state.do_not_contact) && state.do_not_contact.includes('frequency-host:h3'), `do_not_contact is ${JSON.stringify(state.do_not_contact)}`);
  drop(home, '07-after-optout', ev('space.published', 'h3', { detail: 'Drum Circle' }));
  scan(home);
  check(!drafts(home).some((d) => d.host_id === 'h3'), 'a host who opted out got a draft');

  // 5. Stalls.
  drop(home, '08-stalled-again', ev('launcher.stalled', 'h2', { step: 'Add your first event', idle: '1d' }));
  scan(home);
  check(drafts(home).filter((d) => d.kind === 'stall_nudge').length === 1, 'a second stall at the same step made a second draft');
  drop(home, '09-stalled-other', ev('launcher.stalled', 'h2', { step: 'Pick a cover photo', idle: '1h' }));
  scan(home);
  check(drafts(home).filter((d) => d.kind === 'stall_nudge').length === 2, 'a stall at a new step made no draft');

  // 6. No facts, no value moment.
  const bare = realpathSync(freshHome('host-moments-nofacts'));
  drop(bare, '00-rsvps', ev('event.rsvps_8', 'h9', { rsvps: 8, non_host_rsvps: 5, event_title: 'Open Mic' }));
  const r = scan(bare);
  check(!drafts(bare).some((d) => d.kind === 'value_moment'), 'a Founding Year note was drafted with no facts sheet');
  const why = (r.skipped ?? []).find((s) => s.type === 'event.rsvps_8');
  check(why && /facts/i.test(why.reason), `the report gives no facts reason: ${JSON.stringify(r.skipped)}`);
});
