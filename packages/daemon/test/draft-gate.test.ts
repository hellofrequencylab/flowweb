// FW-C-102: the draft gate blocks every hard-rule break and only warns on the word aims; the facts sheet
// keeps its last good copy when a refresh fails.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkDraft, type GateCtx, persistDraft, wordCount } from '../src/flows/draft-gate.ts';
import { readFacts, refreshFacts } from '../src/flows/facts.ts';
import { tempHome } from './api-fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const LINK = 'https://frequencylocal.com/start/host?utm_source=flowweb&utm_content=sound.abc';
const FACTS = {
  beta_ends: '2026-12-31',
  prices: { founding_year: 99 },
  launcher_minutes: 12,
  fetched_at: null,
};
const ctx: GateCtx = { facts: FACTS, source: 'Full moon sound bath, Nov 20', doNotContact: ['@blocked.org'] };
const clean = `Hi Sam, your sound bath on the 20th looks lovely. I'm Daniel, founder of Frequency. Want a free page? ${LINK}`;
const codes = (body: string, extra: Partial<Parameters<typeof checkDraft>[0]> = {}, c = ctx) =>
  checkDraft({ body, ...extra }, c).blocks.map((b) => b.code);

test('a clean draft passes', () => {
  expect(checkDraft({ body: clean, to: 'sam@example.com' }, ctx)).toEqual({
    ok: true,
    blocks: [],
    warns: [],
  });
});

test('each hard rule blocks with its own reason', () => {
  expect(codes(`${clean} Great — really.`)).toEqual(['dash']);
  expect(codes(`${clean} \u{1F642}`)).toEqual(['emoji']);
  expect(codes(`${clean} It costs $49.`)).toEqual(['unsourced_number']);
  expect(codes(`${clean} The founding year is $99 until 12/31.`)).toEqual([]);
  expect(codes(`${clean} See you at midnight.`)).toEqual(['midnight']);
  expect(codes(clean.replace(LINK, 'https://frequencylocal.com/start/host'))).toEqual(['no_tagged_link']);
  expect(codes(clean.replace(LINK, 'https://frequencylocal.com/q/abc123'))).toEqual([]);
  expect(codes(`${clean} ${'word '.repeat(120)}`)).toEqual(['too_long']);
  expect(codes(clean, { touch: 4 })).toEqual(['touch_limit']);
  expect(codes(clean, {}, { ...ctx, priorTouches: 3 })).toEqual(['touch_limit']);
  expect(codes(clean, { to: 'x@blocked.org' })).toEqual(['do_not_contact']);
  expect(codes(clean, { to: 'x@studio.co.uk' })).toEqual(['restricted_region']);
  expect(codes(clean, { country: 'CA' })).toEqual(['restricted_region']);
});

test('digits in links and the sign-off block do not count', () => {
  const body = `${clean.replace(LINK, 'https://frequencylocal.com/e/2027-05?utm_source=flowweb')}\n\nDaniel Tyack\nFounder\nfrequencylocal.com\n\nP.S. Reply "no" and I won't write again.`;
  expect(codes(body)).toEqual([]);
  expect(wordCount(body)).toBe(wordCount(clean));
});

test('word aims only warn', () => {
  const dm = `${clean} ${'nice '.repeat(60)}`;
  const r = checkDraft({ body: dm, send_via: 'social_dm' }, ctx);
  expect(r.ok).toBe(true);
  expect(r.warns.map((w) => w.code)).toEqual(['dm_long']);
  expect(checkDraft({ body: clean, touch: 2 }, ctx).warns.map((w) => w.code)).toEqual([]);
  expect(checkDraft({ body: `${clean} ${'ok '.repeat(30)}`, touch: 2 }, ctx).warns[0]?.code).toBe(
    'follow_up_long',
  );
});

test('persistDraft stores a blocked draft as gate_blocked, or rewrites it once', async () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const dir = join(h.path, 'drafts');
  const bad = await persistDraft({ dir, doc: { id: 'a' }, draft: { body: `${clean} Midnight!` }, ctx });
  expect(bad).toMatchObject({ status: 'gate_blocked', gate: { blocks: [{ code: 'midnight' }] } });
  expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8')).status).toBe('gate_blocked');
  const fixed = await persistDraft({
    dir,
    doc: { id: 'b' },
    draft: { body: `${clean} Midnight!` },
    ctx,
    rewrite: async (d) => ({ ...d, body: d.body.replace(' Midnight!', '') }),
  });
  expect(fixed).toMatchObject({ status: 'waiting_for_owner', body: clean, rewritten_by_gate: true });
});

test('a failed facts refresh keeps the last good file and records why', async () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  mkdirSync(join(h.path, 'creds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(h.path, 'creds', 'crd_frequencyoutcomes'), 'test-secret', { mode: 0o600 });
  let answer: { status: number; body: string } = { status: 200, body: JSON.stringify(FACTS) };
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['x-flowweb-signature'] ? 'signed' : 'unsigned'}`);
    res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  cleanups.push(() => srv.close());
  const site = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const prev = process.env.FW_VENDOR;
  process.env.FW_VENDOR = 'fake';
  cleanups.push(() => {
    if (prev === undefined) delete process.env.FW_VENDOR;
    else process.env.FW_VENDOR = prev;
  });

  expect(await refreshFacts({ fwHome: h.path, site })).toEqual({ ok: true });
  expect(seen).toEqual(['GET /api/webhooks/flowweb-facts signed']);
  expect(readFacts(h.path)).toMatchObject({ beta_ends: '2026-12-31', prices: { founding_year: 99 } });

  answer = { status: 500, body: '{}' };
  expect(await refreshFacts({ fwHome: h.path, site })).toMatchObject({ ok: false });
  expect(readFacts(h.path)).toMatchObject({ beta_ends: '2026-12-31' });
  const pull = JSON.parse(readFileSync(join(h.path, 'facts-pull.json'), 'utf8'));
  expect(pull).toMatchObject({ ok: false, error: 'Frequency answered 500' });
});
