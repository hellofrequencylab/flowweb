// Probe for FW-C-133 (the voice and personality dial: the Owner picks Straight, House or Theatrical, and the
// crew's personality shows only in headlines, empty states and check-ins): `pnpm probe flows/voice-dial`.
// probe-timeout-s: 120
// Tier 0.
// Surfaces: packages/daemon/src/voice/lines.ts (pure LINES, pick and plain), a real fwd on a fresh FW_HOME
// (CLI token and a paired browser session), GET and POST /v1/voice.
//
// The surface this probe expects:
//   VOICES is ['straight', 'house', 'theatrical']; 'house' is the default.
//   LINES[slot][voice] is an array of at least 5 lines for each slot (headline, empty_state, check_in) and
//     each voice. No line has an em dash, an exclamation mark or an emoji, and the straight lines share no
//     line with the theatrical ones for the same slot.
//   pick(slot, voice, week, used) is pure: the same arguments give the same line; it never returns a line in
//     used (the lines already shown that week) while an unused one is left, so five picks in one week never
//     repeat. week is an ISO week like 2026-W46.
//   plain(kind, value) formats numbers, money and warnings, and its answer is the same whatever the voice is:
//     it takes no voice at all.
//   GET /v1/voice (CLI token or paired session; none 401) answers { voice }; POST /v1/voice { voice } sets it
//     for this Owner (unknown voice 400, no session 401). The choice survives a restart of fwd. Customers
//     never get the crew's voice: drafts keep the brand voice whatever the dial says.
//
// Proves, in order:
//   1. Every voice has fresh, clean lines for every personality slot.
//   2. Picks are stable and do not repeat within a week; numbers and money are plain in every voice.
//   3. A fresh fwd is on House; the Owner switches to Theatrical and it sticks.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/voice-dial';
const SLOTS = ['headline', 'empty_state', 'check_in'];
const EMOJI = /\p{Extended_Pictographic}/u;

await probe(NAME, async () => {
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, 'packages/daemon/src/voice/lines.ts')).href);
  } catch {
    missing('packages/daemon/src/voice/lines.ts does not exist (row FW-C-133)');
  }
  if (!mod.LINES || typeof mod.pick !== 'function' || typeof mod.plain !== 'function')
    missing('lines.ts does not export LINES, pick and plain (row FW-C-133)');

  // ---- 1. clean lines ------------------------------------------------------------------------------------
  check(JSON.stringify(mod.VOICES) === JSON.stringify(['straight', 'house', 'theatrical']), `VOICES is ${JSON.stringify(mod.VOICES)}`);
  for (const slot of SLOTS) {
    for (const voice of mod.VOICES) {
      const lines = mod.LINES[slot]?.[voice];
      check(Array.isArray(lines) && lines.length >= 5, `${slot} / ${voice} has ${lines?.length ?? 0} lines, want at least 5`);
      for (const l of lines) {
        check(typeof l === 'string' && l.trim().length > 0, `${slot} / ${voice} has an empty line`);
        check(!l.includes('—') && !l.includes('!') && !EMOJI.test(l), `${slot} / ${voice} line breaks the voice rules: ${l}`);
      }
    }
    const straight = new Set(mod.LINES[slot].straight);
    check(!mod.LINES[slot].theatrical.some((l) => straight.has(l)), `${slot}: Straight and Theatrical share a line`);
  }

  // ---- 2. picks and plain figures -------------------------------------------------------------------------
  const week = '2026-W46';
  check(mod.pick('headline', 'house', week, []) === mod.pick('headline', 'house', week, []), 'the same pick gave two lines');
  for (const slot of SLOTS) {
    const used = [];
    for (let i = 0; i < 5; i++) {
      const l = mod.pick(slot, 'theatrical', week, used);
      check(typeof l === 'string' && !used.includes(l), `${slot} pick ${i + 1} repeated a line this week: ${l}`);
      used.push(l);
    }
  }
  check(mod.plain.length <= 2, 'plain takes a voice: numbers, money and warnings must read the same in every voice');
  check(mod.plain('usd', 1.5) === '$1.50', `plain('usd', 1.5) is ${mod.plain('usd', 1.5)}, want $1.50`);
  check(mod.plain('count', 1234) === '1,234', `plain('count', 1234) is ${mod.plain('count', 1234)}, want 1,234`);

  // ---- 3. the Owner's dial ---------------------------------------------------------------------------------
  const home = realpathSync(freshHome('voice-dial'));
  let f = await startFwd(home);
  try {
    const g = await api(f.port, 'GET', '/v1/voice', { auth: f.token });
    if (g.status === 404 && /no route/i.test(g.text)) missing('GET /v1/voice does not exist (row FW-C-133)');
    check(g.status === 200 && g.json?.data?.voice === 'house', `a fresh home's voice: ${g.status} ${g.text.slice(0, 200)}`);
    check((await api(f.port, 'GET', '/v1/voice')).status === 401, 'GET /v1/voice without a session was not 401');
    check((await api(f.port, 'POST', '/v1/voice', { body: { voice: 'straight' } })).status === 401, 'POST /v1/voice without a session was not 401');
    check((await api(f.port, 'POST', '/v1/voice', { auth: f.token, body: { voice: 'loud' } })).status === 400, 'an unknown voice was not 400');
    const { cookie } = await pair(f.port, f.pairingCode);
    check((await api(f.port, 'POST', '/v1/voice', { auth: { cookie }, body: { voice: 'theatrical' } })).status === 200, 'setting Theatrical was refused');
  } finally {
    await f.stop();
  }
  f = await startFwd(home);
  try {
    const v = (await api(f.port, 'GET', '/v1/voice', { auth: f.token })).json?.data?.voice;
    check(v === 'theatrical', `after a restart the voice is ${v}, want theatrical`);
  } finally {
    await f.stop();
  }
});
