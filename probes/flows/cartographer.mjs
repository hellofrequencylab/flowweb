// Probe for FW-C-142 (the Cartographer: a read-only flow that tracks how Frequency's pages rank in search
// and how AI answers describe Frequency, and proposes page edits the Owner approves): `pnpm probe flows/cartographer`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: the shipped definition in flows/cartographer/, packages/daemon/src/flows/cartographer.ts (pure
// parseSearchConsole and proposals), a real fwd on a fresh FW_HOME (CLI token), GET /v1/flows/cartographer,
// and files the probe drops in $FW_HOME/flows/cartographer/imports/ (a Search Console Pages export) and
// $FW_HOME/flows/cartographer/answers/ (AI answer checks, one JSON file each).
//
// The surface this probe expects:
//   flows/cartographer/ has stream.json (ships disabled, default_tier L1, a dollar cap, action_classes only
//     read_research), config.json and project.json (the Frequency project, category marketing).
//   parseSearchConsole(text) reads a Search Console "Pages" CSV export (header Top pages, Clicks,
//     Impressions, CTR, Position; CTR like "2.5%") into [{ url, clicks, impressions, position }], skipping
//     blank and malformed lines.
//   proposals({ pages, answers }) is pure plain code: a page with at least 100 impressions and a position
//     from 8 to 20 gets { kind: 'page', url, change, why }; an answer check whose answer text does not
//     mention Frequency gets { kind: 'answer', question, change, why }. Nothing else gets a proposal.
//   GET /v1/flows/cartographer (CLI token or paired session) answers { pages, answers, proposals, state }:
//     state waiting_for_data with no imports; pages sorted by impressions, most first; each answer carries
//     mentions_frequency. Proposals wait for the Owner: the flow never edits a page, publishes or writes to
//     the outbox.
//
// Proves, in order:
//   1. The shipped flow is off, read-only and capped.
//   2. The pure reader and the proposal rules.
//   3. A fresh fwd waits for data; with an export and two answer checks it proposes exactly the right edits
//      and sends nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/cartographer';
const KEY = 'cartographer';
const CSV = [
  'Top pages,Clicks,Impressions,CTR,Position',
  'https://frequencylocal.com/,40,900,4.4%,3.1',
  'https://frequencylocal.com/start/host,6,400,1.5%,12.4',
  'https://frequencylocal.com/for/yoga-teacher,1,60,1.7%,14.0',
  'https://frequencylocal.com/pricing,0,150,0%,31.0',
  'not a row',
  '',
].join('\n');
const ANSWERS = [
  { question: 'Where can I find a sound bath circle in Encinitas?', engine: 'chatgpt', answer_text: 'Try Frequency, which lists local circles.', checked_at: '2026-11-10T09:00:00Z' },
  { question: 'How do I start a meditation group near me?', engine: 'perplexity', answer_text: 'Meetup and community boards are common places to start.', checked_at: '2026-11-10T09:00:00Z' },
];

await probe(NAME, async () => {
  // ---- 1. the shipped flow -------------------------------------------------------------------------------
  const dir = join(root, 'flows', KEY);
  if (!existsSync(join(dir, 'stream.json'))) missing('flows/cartographer/stream.json does not exist (row FW-C-142)');
  const stream = JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  check(existsSync(join(dir, 'config.json')), 'flows/cartographer has no config.json');
  check(stream.key === KEY && stream.enabled === false && stream.default_tier === 'L1', `the stream: key ${stream.key}, enabled ${stream.enabled}, tier ${stream.default_tier}`);
  check(JSON.stringify(stream.action_classes) === JSON.stringify(['read_research']), `the stream's action classes are ${JSON.stringify(stream.action_classes)}`);
  check(stream.budget?.caps?.max_usd > 0, 'the stream has no dollar cap');
  check(project.category === 'marketing' && project.slug === 'frequency', `the project is ${JSON.stringify(project)}`);

  // ---- 2. the pure reader and rules ----------------------------------------------------------------------
  let mod;
  try {
    mod = await import(pathToFileURL(join(root, 'packages/daemon/src/flows/cartographer.ts')).href);
  } catch {
    missing('packages/daemon/src/flows/cartographer.ts does not exist (row FW-C-142)');
  }
  check(typeof mod.parseSearchConsole === 'function' && typeof mod.proposals === 'function', 'cartographer.ts does not export parseSearchConsole and proposals');
  const pages = mod.parseSearchConsole(CSV);
  check(pages.length === 4, `the export has 4 pages, the reader found ${pages.length}`);
  const host = pages.find((p) => p.url.endsWith('/start/host'));
  check(host?.clicks === 6 && host.impressions === 400 && host.position === 12.4, `the /start/host row reads ${JSON.stringify(host)}`);
  const props = mod.proposals({ pages, answers: ANSWERS });
  const pageProps = props.filter((p) => p.kind === 'page');
  const answerProps = props.filter((p) => p.kind === 'answer');
  check(pageProps.length === 1 && pageProps[0].url.endsWith('/start/host'), `page proposals: ${JSON.stringify(pageProps)}`);
  check(answerProps.length === 1 && answerProps[0].question === ANSWERS[1].question, `answer proposals: ${JSON.stringify(answerProps)}`);
  check(props.every((p) => typeof p.change === 'string' && p.change.length > 0 && typeof p.why === 'string' && p.why.length > 0), 'a proposal has no change or why');

  // ---- 3. a real fwd ------------------------------------------------------------------------------------
  const home = realpathSync(freshHome('cartographer'));
  let f = await startFwd(home);
  try {
    const r = await api(f.port, 'GET', `/v1/flows/${KEY}`, { auth: f.token });
    check(r.status === 200, `GET /v1/flows/${KEY} answered ${r.status}: ${r.text.slice(0, 200)}`);
    const v = r.json?.data;
    check(v?.state === 'waiting_for_data' && v.pages?.length === 0 && v.proposals?.length === 0, `a fresh home: ${JSON.stringify(v)?.slice(0, 300)}`);
  } finally {
    await f.stop();
  }
  mkdirSync(join(home, 'flows', KEY, 'imports'), { recursive: true });
  mkdirSync(join(home, 'flows', KEY, 'answers'), { recursive: true });
  writeFileSync(join(home, 'flows', KEY, 'imports', 'pages.csv'), CSV);
  ANSWERS.forEach((a, i) => writeFileSync(join(home, 'flows', KEY, 'answers', `check-${i}.json`), JSON.stringify(a)));
  f = await startFwd(home);
  try {
    const v = (await api(f.port, 'GET', `/v1/flows/${KEY}`, { auth: f.token })).json?.data;
    check(v?.pages?.length === 4 && v.pages[0].impressions === 900 && v.pages.at(-1).impressions === 60, `pages are not sorted by impressions: ${JSON.stringify(v?.pages)}`);
    const m = Object.fromEntries((v.answers ?? []).map((a) => [a.question, a.mentions_frequency]));
    check(m[ANSWERS[0].question] === true && m[ANSWERS[1].question] === false, `mentions_frequency: ${JSON.stringify(m)}`);
    check(v.proposals?.length === 2, `with the export and two checks there are ${v.proposals?.length} proposals, want 2`);
    const outbox = join(home, 'outbox');
    check(!existsSync(outbox) || readdirSync(outbox, { recursive: true }).length === 0, 'the Cartographer wrote to the outbox');
  } finally {
    await f.stop();
  }
});
