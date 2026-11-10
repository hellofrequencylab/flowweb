// Owner admin for the neighborhood activation flow: CSV parsing, uploads, marked sends, do-not-contact,
// opening a region, config validation, the leads export and the admin log files. Every refusal is covered.
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { readJsonBody } from '../src/api/http.ts';
import * as na from '../src/flows/neighborhood-activation.ts';
import * as adm from '../src/flows/neighborhood-admin.ts';
import { tempHome } from './api-fixtures.ts';

const cfgPath = resolve(import.meta.dirname, '../../../flows/neighborhood-activation/config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as na.FlowConfig;
const now = new Date('2026-11-10T12:00:00Z');
const [SEED, HEAD] = ['north-county-sd', 'name,kind,territory_id,sub_area,channel,source,url,fit,timing'];
const MHEAD = 'territory_id,hosts_active_28d,events_next_14d,sub_areas_covered_14d,wam';
const URL1 = 'https://example.com/ana';
const ANA = { name: 'Ana', kind: 'host', territory_id: SEED, sub_area: 'encinitas', channel: 'movement' };
const LEAD = { ...ANA, source: 'event_listings', url: URL1, fit: '0.9', timing: '0.8' };
const ID1 = adm.leadIdOf(URL1);
const fresh = () => na.initialState(now, SEED);
const csv = (head: string, ...rows: string[]) => ({ format: 'csv', data: [head, ...rows].join('\n') });
const json = (...data: object[]) => ({ format: 'json', data });
const withAna = () => adm.importLeads(cfg, fresh(), json(LEAD), now).state!;
const skips = (c: adm.Change) => (c.data.skipped as adm.Skipped[]).map((s) => `${s.row}: ${s.reason}`);
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof adm.AdminError) return e.status;
    throw e;
  }
  return 'accepted';
};

test('upload bodies: CSV quoting, CRLF, a BOM, blank lines, a trailing comma; JSON; a larger body cap', async () => {
  const rows = adm.parseCsv('\uFEFFa,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\n1,,');
  expect(rows.map((r) => r.join('|'))).toEqual(['a|b|c', 'x, y|say "hi"|two\nlines', '1||']);
  expect(adm.rowsOf(csv('A,b', '1'), ['a'])).toEqual([{ a: '1', b: '' }]);
  expect(adm.rowsOf(json({ a: 1 }, 'x' as never), ['a'])).toEqual([{ a: 1 }, {}]);
  const body = Buffer.from(JSON.stringify({ d: 'x'.repeat(40_000) }));
  const big = () => Object.assign(Readable.from([body]), { headers: { 'content-type': 'application/json' } });
  await expect(readJsonBody(big() as unknown as IncomingMessage)).rejects.toThrow(/too large/);
  expect((await readJsonBody(big() as unknown as IncomingMessage, 1 << 20)).d).toHaveLength(40_000);
});

test('every refusal answers its status and changes nothing', () => {
  const s = withAna();
  const blocked = adm.addDoNotContact(s, { lead_id: ID1, reason: 'asked' }).state!;
  const far = { ...fresh(), opened: ['san-diego'] };
  const cases: [string, () => unknown, number][] = [
    ['an unclosed quote', () => adm.parseCsv('a,"b\n1,2'), 400],
    ['an unknown format', () => adm.rowsOf({ format: 'xml' }, []), 400],
    ['csv data that is not text', () => adm.rowsOf({ format: 'csv', data: [] }, []), 400],
    ['json data that is not a list', () => adm.rowsOf({ format: 'json', data: 'a' }, []), 400],
    ['a header missing a column', () => adm.importLeads(cfg, s, csv('name,kind', 'a,host'), now), 400],
    ['a metrics header missing a column', () => adm.importMetrics(cfg, s, csv('territory_id', SEED)), 400],
    ['a send to an unknown lead', () => adm.addTouch(s, 'nope', { via: 'frequency' }, now), 404],
    ['a send to a blocked lead', () => adm.addTouch(blocked, ID1, { via: 'frequency' }, now), 409],
    ['a send by sms', () => adm.addTouch(s, ID1, { via: 'sms' }, now), 400],
    ['a send at no date', () => adm.addTouch(s, ID1, { via: 'frequency', at: 'later' }, now), 400],
    ['a send in the future', () => adm.addTouch(s, ID1, { via: 'frequency', at: '2027-01-01' }, now), 400],
    ['do-not-contact without a reason', () => adm.addDoNotContact(s, { lead_id: ID1 }), 400],
    ['do-not-contact with no target', () => adm.addDoNotContact(s, { reason: 'x' }), 400],
    ['two targets', () => adm.addDoNotContact(s, { lead_id: ID1, url: URL1, reason: 'x' }), 400],
    ['do-not-contact with a bad url', () => adm.addDoNotContact(s, { url: 'not a url', reason: 'x' }), 400],
    ['do-not-contact, unknown lead', () => adm.addDoNotContact(s, { lead_id: 'nope', reason: 'x' }), 404],
    ['opening an unknown region', () => adm.openTerritory(cfg, s, 'atlantis'), 404],
    ['opening an open region', () => adm.openTerritory(cfg, s, SEED), 409],
    ['opening a region that borders nothing open', () => adm.openTerritory(cfg, far, 'orange-county'), 409],
    ['saving an invalid config', () => adm.saveConfig(cfg, s, { ...cfg, territories: [] }), 400],
  ];
  const before = JSON.stringify(s);
  expect(cases.map(([what, fn]) => [what, refusal(fn)])).toEqual(cases.map(([what, , st]) => [what, st]));
  expect(JSON.stringify(s)).toBe(before);
});

test('lead upload adds by url hash with times of now; a known url updates, keeping touches and found_at', () => {
  const out = adm.importLeads(cfg, fresh(), csv(HEAD, Object.values(LEAD).join(',')), now);
  expect(out.data).toEqual({ added: 1, updated: 0, skipped: [] });
  expect(ID1).toMatch(/^ld_[0-9a-f]{12}$/);
  const want = { id: ID1, fit: 0.9, sub_area: 'encinitas', touches: [], timing_at: now.toISOString() };
  expect(out.state!.leads[0]).toMatchObject({ ...want, found_at: now.toISOString() });
  expect(out.summary).toBe('Uploaded leads: 1 added, 0 updated, 0 skipped.');
  const s = adm.addTouch(withAna(), ID1, { via: 'founder_email' }, now).state!;
  const later = new Date(now.getTime() + 86_400_000);
  const re = adm.importLeads(cfg, s, json({ ...LEAD, fit: '0.95', channel: '' }), later);
  expect(re.data).toMatchObject({ added: 0, updated: 1 });
  const lead = re.state!.leads[0]!;
  expect(lead).toMatchObject({ fit: 0.95, found_at: now.toISOString(), timing_at: later.toISOString() });
  expect([lead.touches.length, lead.channel]).toEqual([1, undefined]);
});

test('lead upload skips each bad row with a reason and writes nothing when nothing is accepted', () => {
  const bad = { name: '', kind: 'wizard', territory_id: 'atlantis', sub_area: 'irvine', source: 'rumour' };
  const more = { url: 'ftp://example.com/x', fit: '1.5', timing: '', timing_at: 'soon' };
  const rows = Object.entries({ ...bad, ...more }).map(([k, v]) => ({ ...LEAD, [k]: v }));
  const out = adm.importLeads(cfg, fresh(), json(...rows, LEAD, { ...LEAD, fit: '0.7' }), now);
  expect(out.data).toMatchObject({ added: 1, updated: 1 });
  const words = ['name', 'kind', 'region', 'sub-area', 'source', 'url', 'fit', 'timing', 'dates'];
  expect(skips(out).map((r, i) => r.includes(words[i]!))).toEqual(words.map(() => true));
  expect(adm.importLeads(cfg, fresh(), json(...rows), now).state).toBeUndefined();
});

test('metrics upload sets measures and weeks, keeps Channel coverage, and skips bad rows with reasons', () => {
  const s = fresh();
  s.metrics[SEED] = { hosts_active_28d: 0, events_next_14d: 0, sub_areas_covered_14d: 0, wam: 0 };
  s.metrics[SEED].channels_by_sub_area = { vista: 3 };
  const out = adm.importMetrics(cfg, s, csv(`${MHEAD},weeks_at_threshold`, `${SEED},34,41,5,260,4`));
  expect(out.data).toEqual({ updated: 1, skipped: [] });
  const [m, weeks] = [out.state!.metrics[SEED], out.state!.weeks_at_threshold[SEED]];
  expect([m?.hosts_active_28d, m?.channels_by_sub_area, weeks]).toEqual([34, { vista: 3 }, 4]);
  const view = na.flowView(cfg, out.state!, { period: 'week', max_usd: 5, max_turns: 1 }, {}, now);
  expect(view.territories.find((t) => t.id === SEED)?.progress).toBeTypeOf('number');
  const rows = ['atlantis,1,1,1,1,', `${SEED},1,1,1,1,`, `${SEED},1,1,1,1,`, 'orange-county,-1,1,1,1,'];
  rows.push('inland-north,1,1,1,1,1.5');
  const bad = adm.importMetrics(cfg, fresh(), csv(`${MHEAD},weeks_below`, ...rows));
  expect(bad.data.updated).toBe(1);
  expect(skips(bad)).toEqual([
    '1: region "atlantis" is not in the config',
    '3: region "north-county-sd" appears twice in this upload',
    '4: hosts_active_28d must be a number of 0 or more',
    '5: weeks_below must be a whole number of 0 or more',
  ]);
});

test('a send is recorded with its route and time; do-not-contact blocks by lead id or url, once', () => {
  const s = withAna();
  const sent = adm.addTouch(s, ID1, { via: 'frequency', at: '2026-11-09T10:00:00Z' }, now);
  expect(sent.state!.leads[0]!.touches).toEqual([{ at: '2026-11-09T10:00:00.000Z', via: 'frequency' }]);
  expect(sent.summary).toBe('Marked a Frequency message sent to Ana.');
  const out = adm.addDoNotContact(s, { lead_id: ID1, reason: 'asked' });
  expect(out.data).toEqual({ blocked: URL1, already: false });
  expect(na.routeLeads(cfg, out.state!, now)[0]?.stage).toBe('blocked');
  expect(adm.addDoNotContact(out.state!, { url: URL1, reason: 'again' }).state).toBeUndefined();
  const other = adm.addDoNotContact(s, { url: 'https://example.com/x', reason: 'opted out' }).state!;
  expect(other.do_not_contact).toEqual(['https://example.com/x']);
});

test('opening a bordering region (either side may list it) makes it active; a saved config names changes', () => {
  const s = adm.openTerritory(cfg, fresh(), 'orange-county').state!;
  expect([s.opened, na.statusOf(cfg, s, 'orange-county')]).toEqual([[SEED, 'orange-county'], 'active']);
  const territories = cfg.territories.map((t) => (t.id === SEED ? { ...t, borders: [] } : t));
  expect(adm.openTerritory({ ...cfg, territories }, fresh(), 'san-diego').data.opened).toContain('san-diego');
  const c = structuredClone(cfg);
  c.activation.hosts_floor = 120;
  const out = adm.saveConfig(cfg, fresh(), c as unknown as Record<string, unknown>);
  expect([out.config, out.summary]).toEqual([c, 'Saved the config (4 regions; hosts_floor 100 to 120).']);
});

test('config validation accepts the shipped config and names every problem', () => {
  expect(adm.validateConfig(cfg)).toEqual([]);
  expect(adm.validateConfig([])).toEqual(['the config must be a JSON object']);
  // biome-ignore lint/suspicious/noExplicitAny: these cases break arbitrary config fields on purpose.
  const bad = (fn: (c: any) => unknown, want: RegExp) => {
    const c = structuredClone(cfg);
    fn(c);
    expect(adm.validateConfig(c).join(' | ')).toMatch(want);
  };
  bad((c) => (c.territories = []), /non-empty list/);
  bad((c) => (c.seed_territory_id = 'atlantis'), /seed_territory_id/);
  bad((c) => c.territories[0].borders.push('atlantis'), /borders "atlantis"/);
  bad((c) => c.territories[1].borders.push('orange-county'), /not another region/);
  bad((c) => (c.territories[0].borders = 'x'), /borders list/);
  bad((c) => (c.territories[2].sub_areas.length = 1), /at least 2 sub-areas/);
  bad((c) => (c.territories[2].sub_areas[0].population = -1), /population/);
  bad((c) => (c.territories[3].id = SEED), /appears twice/);
  bad((c) => (c.territories[3].name = ''), /an id and a name/);
  bad((c) => (c.territories[3].order = '4'), /number order/);
  bad((c) => (c.activation.hold_weeks = 0), /activation.hold_weeks/);
  bad((c) => delete c.funnels.resident, /funnels.resident/);
  bad((c) => (c.max_active_sub_areas = -1), /must stay/);
  const kept = cfg.territories.filter((t) => t.id !== 'san-diego');
  const territories = kept.map((t) => ({ ...t, borders: t.borders.filter((b) => b !== 'san-diego') }));
  expect(adm.validateConfig({ ...cfg, territories })).toEqual([]);
  expect(adm.validateConfig({ ...cfg, territories }, ['san-diego']).join()).toMatch(/san-diego is open/);
});

test('leads export: a header and one line per lead that uploads again cleanly; fields quoted and safe', () => {
  const two = json(LEAD, { ...LEAD, url: 'https://x.io/b', name: 'B, "C"' });
  const s = adm.importLeads(cfg, fresh(), two, now);
  const text = adm.leadsCsv(cfg, s.state!, now);
  const lines = text.trim().split('\r\n');
  expect(lines.map((l) => l.slice(0, 10))).toEqual(['name,kind,', 'Ana,host,n', '"B, ""C"""']);
  const again = adm.importLeads(cfg, s.state!, { format: 'csv', data: text }, now);
  expect(again.data).toEqual({ added: 0, updated: 2, skipped: [] });
  const fields = ['a,b', '=HYPERLINK("x")', '@x', -1, undefined].map(adm.csvField);
  expect(fields).toEqual(['"a,b"', `"'=HYPERLINK(""x"")"`, "'@x", '-1', '']);
});

test('files: state is written whole by a rename; the log is newest first, capped, torn lines left out', () => {
  const home = tempHome();
  const p = join(adm.adminDir(home.path), 'state.json');
  adm.writeJsonAtomic(p, { opened: [SEED] });
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ opened: [SEED] });
  expect(adm.readAdminLog(home.path)).toEqual([]);
  for (let i = 0; i < 60; i++) adm.appendAdminLog(home.path, { at: `${i}`, action: 'open', summary: `${i}` });
  const log = join(adm.adminDir(home.path), 'admin-log.jsonl');
  writeFileSync(log, `${readFileSync(log, 'utf8')}{"torn`);
  expect(adm.readAdminLog(home.path)).toHaveLength(50);
  expect(adm.readAdminLog(home.path, 2).map((e) => e.summary)).toEqual(['59', '58']);
  home.cleanup();
});
