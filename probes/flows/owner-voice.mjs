// Probe for FW-C-161 (flows write a first note in the Owner's own voice): `pnpm probe flows/owner-voice`.
// Tier 0. Committed with the Owner's approval (decision card, 2026-11-18).
// Surfaces: packages/daemon/src/flows/voice.ts (OWNER_NOTE, NOTE_MAX_WORDS, NOTE_MAX_EMOJI), brief in
// packages/daemon/src/overseer/cycle.ts, composeBody and parseLeads in packages/daemon/src/flows/hunts.ts,
// checkDraft in packages/daemon/src/flows/draft-gate.ts, flows/neighborhood-activation/config.json and every
// profile under flows/neighborhood-activation/profiles/. The TypeScript is loaded with the repo's tsx loader.
//
// Proves, in order:
//   1. The hunt brief of a flow with no playbook quotes the note the Owner approved and no longer asks for the
//      old two-paragraph note.
//   2. Every shipped profile's playbook note carries his three fixed sentences, fits the editor's 1200
//      characters, has no em or en dash, and reaches the brief of a flow that uses it.
//   3. His own note, composed with the link, the sign-off and the P.S., passes the draft gate as a first hunt
//      note, and so does his longer note to a venue. Under the gate's defaults the first is still blocked for
//      its emoji and the second for its length; a second emoji blocks a hunt note, and so does one over its cap.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/owner-voice';
const url = (p) => JSON.stringify(pathToFileURL(join(root, p)).href);
const VOICE_TS = join(root, 'packages/daemon/src/flows/voice.ts');
const CONFIG = join(root, 'flows/neighborhood-activation/config.json');
const PROFILES = join(root, 'flows/neighborhood-activation/profiles');
const INTRO = "I'm Daniel, a local community builder and the founder of Frequency!";
const WHAT = 'Frequency is a free way for neighbors to find or start local, in-person Circles and events around what they love.';
const CLOSE = "We're beta launching here in North County SD, and I would love for you to come check it out.";
const OLD = 'End that opening with an exclamation mark';
// One of the three notes the Owner approved, to a venue: longer than the 120 words other drafts may have.
const VENUE = [
  'Hi Ryder, Dear Tomorrow caught my eye, and I love what you are up to. A book club, a leatherworking workshop and a live show under one roof!',
  "I'm Daniel, a local community builder and the founder of Frequency.",
  `${WHAT} Right now I'm focused on the spaces that bring a neighborhood together, and on making it easy for places like yours to be found by the people who live nearby.`,
  `Would you be interested in putting your gatherings where neighbors can find them all in one place? ${CLOSE}`,
].join('\n\n');

function runTs(code) {
  const loader = pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  const r = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });
  check(r.status === 0, `loading the TypeScript failed: ${(r.stderr || r.stdout || '').slice(0, 600)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

await probe(NAME, async () => {
  if (!existsSync(VOICE_TS)) missing('packages/daemon/src/flows/voice.ts does not exist (row FW-C-161)');
  const profiles = readdirSync(PROFILES).filter((f) => f.endsWith('.json')).sort();
  check(profiles.length >= 3, `only ${profiles.length} profiles ship`);

  const r = runTs(`
    import { readFileSync } from 'node:fs';
    const v = await import(${url('packages/daemon/src/flows/voice.ts')});
    const c = await import(${url('packages/daemon/src/overseer/cycle.ts')});
    const h = await import(${url('packages/daemon/src/flows/hunts.ts')});
    const g = await import(${url('packages/daemon/src/flows/draft-gate.ts')});
    const cfg = JSON.parse(readFileSync(${JSON.stringify(CONFIG)}, 'utf8'));
    const hunt = h.newHunt(cfg, { name: 'Kirtan', looking_for: 'kirtan circles', region: 'north-county-sd' }, new Date('2026-11-18T08:00:00Z'));
    const lead = (body) => h.parseLeads({ leads: [{ hunt_id: hunt.id, event: { title: 'Kirtan', url: 'https://example.com/e' },
      organizer: { name: 'Mirabai', email: 'mirabai@example.com', source_url: 'https://example.com/contact' }, body }] })[0];
    const composed = h.composeBody(cfg, hunt, lead(v.OWNER_NOTE));
    const venue = h.composeBody(cfg, hunt, lead(${JSON.stringify(VENUE)}));
    const note = { requireLink: false, maxWords: v.NOTE_MAX_WORDS, maxEmoji: v.NOTE_MAX_EMOJI };
    const codes = (body, ctx) => g.checkDraft({ body, subject: 'Your kirtan', send_via: 'email', to: 'mirabai@example.com', touch: 1 }, ctx).blocks.map((b) => b.code).sort();
    const briefs = {};
    for (const f of ${JSON.stringify(profiles)}) {
      const p = JSON.parse(readFileSync(${JSON.stringify(PROFILES)} + '/' + f, 'utf8')).config.hunts.playbook;
      briefs[f] = { note: p.note, inBrief: c.brief('neighborhood-activation', {}, [hunt], [], false, undefined, [], p).includes(p.note) };
    }
    console.log(JSON.stringify({
      ownerNote: v.OWNER_NOTE, maxWords: v.NOTE_MAX_WORDS, maxEmoji: v.NOTE_MAX_EMOJI,
      brief: c.brief('neighborhood-activation', {}, [hunt], [], false),
      briefs, composed, words: g.wordCount(composed),
      asNote: codes(composed, note), asDefault: codes(composed, { requireLink: false }),
      venueWords: g.wordCount(venue), venueAsNote: codes(venue, note), venueAsDefault: codes(venue, { requireLink: false }),
      twoEmoji: codes(composed.replace('Daniel Tyack', 'Daniel Tyack \\u{1F642}'), note),
      tooLong: codes('really '.repeat(v.NOTE_MAX_WORDS) + composed.replace('\\u{1F64F}\\u{1F3FC}', ''), note),
    }));
  `);

  // 1. The brief of a flow with no playbook.
  for (const s of [INTRO, WHAT, CLOSE]) check(r.ownerNote.includes(s), `the Owner's note has lost: ${s}`);
  check(r.ownerNote.startsWith('Hi Mirabai, your Encinitas kirtan caught my eye, and I love what you are up to.'), 'the note is not the one the Owner approved');
  const flat = (s) => s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\s+/g, ' ');
  for (const s of [INTRO, WHAT, CLOSE]) check(flat(r.brief).includes(s), `the hunt brief does not carry: ${s}`);
  check(!r.brief.includes(OLD) && !r.brief.includes("I'm Daniel, founder of Frequency"), 'the hunt brief still asks for the old note');

  // 2. Every shipped profile.
  for (const f of profiles) {
    const { note, inBrief } = r.briefs[f];
    for (const s of [INTRO, WHAT, CLOSE]) check(note.includes(s), `${f}: the note does not carry: ${s}`);
    check(note.includes("Right now I'm focused on"), `${f}: the note does not say who the Owner is focused on`);
    check(!note.includes(OLD) && !note.includes("I'm Daniel, founder of Frequency"), `${f}: the note still asks for the old voice`);
    check(note.length <= 1200 && !/[–—]/.test(note), `${f}: the note is ${note.length} characters or has a dash`);
    check(inBrief, `${f}: the note does not reach the brief`);
  }

  // 3. The gate.
  check(r.composed.startsWith(r.ownerNote) && r.composed.includes('Daniel Tyack\nFounder'), `the composed note lost his words or his sign-off: ${r.composed.slice(0, 200)}`);
  check(r.words <= r.maxWords && r.maxEmoji === 1, `his note is ${r.words} words; the hunt-note cap is ${r.maxWords} and ${r.maxEmoji} emoji`);
  check(r.asNote.length === 0, `his own note is blocked as a first hunt note: ${JSON.stringify(r.asNote)}`);
  check(JSON.stringify(r.asDefault) === '["emoji"]', `under the default rules his note was blocked for ${JSON.stringify(r.asDefault)}, want emoji`);
  check(r.venueWords > 120 && r.venueAsNote.length === 0, `his ${r.venueWords}-word venue note is blocked as a first hunt note: ${JSON.stringify(r.venueAsNote)}`);
  check(JSON.stringify(r.venueAsDefault) === '["too_long"]', `under the default rules his venue note was blocked for ${JSON.stringify(r.venueAsDefault)}, want too_long`);
  check(JSON.stringify(r.twoEmoji) === '["emoji"]', `a note with a second emoji was blocked for ${JSON.stringify(r.twoEmoji)}, want emoji`);
  check(JSON.stringify(r.tooLong) === '["too_long"]', `a note over the cap was blocked for ${JSON.stringify(r.tooLong)}, want too_long`);
});
