// Probe for FW-C-089 (drafts read in the Owner's own voice and copy into Gmail with the Frequency logo):
// `pnpm probe flows/draft-voice`.
// Tier 0.
// Surfaces: packages/web/src/flows/draft-html.ts (draftHtml, LOGO_URL), packages/web/src/flows/DraftEditor.tsx,
// composeBody in packages/daemon/src/flows/hunts.ts with flows/neighborhood-activation/config.json, and the hunt
// brief in packages/daemon/src/overseer/cycle.ts. The TypeScript is loaded with the repo's tsx loader in a child.
//
// The surface this probe expects:
//   draftHtml(text) is the HTML twin of a plain-text draft: paragraphs, https links as <a>, text escaped, and an
//   <img> of LOGO_URL (an https .png on frequencylocal.com) right before the sign-off block, which sits before
//   the "P.S." paragraph (or is the last paragraph). Text with no sign-off gets no logo.
//   DraftEditor's Copy writes text/plain and text/html (draftHtml) to the clipboard.
//   A hunt draft from composeBody ends with the Owner's sign-off "Daniel Tyack / Founder / frequencylocal.com",
//   a blank line, then "P.S. I'm local to San Diego (North County) and found your address on <source page>."
//   with a reply-"no" opt-out, and no em or en dash.
//   The hunt brief carries the Owner's own Pages in Bloom opening, ending "with the community!".
//
// Proves, in order:
//   1. draftHtml puts the logo above the Owner's name in his Bloom draft, keeps the link and escapes text.
//   2. Copy puts that HTML on the clipboard.
//   3. A composed hunt draft ends with the Owner's sign-off and P.S.
//   4. The brief carries his example.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/draft-voice';
const HTML_TS = join(root, 'packages/web/src/flows/draft-html.ts');
const EDITOR = join(root, 'packages/web/src/flows/DraftEditor.tsx');
const HUNTS_TS = join(root, 'packages/daemon/src/flows/hunts.ts');
const CYCLE_TS = join(root, 'packages/daemon/src/overseer/cycle.ts');
const CONFIG = join(root, 'flows/neighborhood-activation/config.json');
const SRC = 'https://oceansideartcollective.com/events';

const BLOOM = [
  'Hi Elya and team, your Pages in Bloom workshop caught my eye & I love what you are up to <3!',
  '',
  'If you\'d like to host on Frequency, start here: https://frequencylocal.com/q/pdc5pg6',
  '',
  'Daniel Tyack',
  'Founder',
  'frequencylocal.com',
  '',
  "P.S. I'm local to San Diego (North County). I won't reach out again if you aren't interested.",
].join('\n');

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
  if (!existsSync(HTML_TS)) missing('packages/web/src/flows/draft-html.ts does not exist (row FW-C-089)');

  // 1. The HTML twin.
  const out = runTs(`
    const m = await import(${JSON.stringify(pathToFileURL(HTML_TS).href)});
    console.log(JSON.stringify({
      logo: m.LOGO_URL,
      html: m.draftHtml(${JSON.stringify(BLOOM)}),
      bare: m.draftHtml('Hi there.\\n\\nSee https://frequencylocal.com/q/abc for more.'),
    }));
  `);
  check(typeof out.logo === 'string' && /^https:\/\/(www\.)?frequencylocal\.com\/.+\.png$/.test(out.logo), `LOGO_URL: ${out.logo}`);
  const html = String(out.html);
  const img = html.indexOf(`<img src="${out.logo}"`);
  const name = html.indexOf('Daniel Tyack<br>Founder<br>frequencylocal.com');
  const ps = html.indexOf('P.S. I');
  check(img >= 0, `the copied HTML has no logo image: ${html.slice(0, 400)}`);
  check(name > img && html.slice(img, name).replace(/<img[^>]*>/, '').replace(/<p[^>]*>/, '') === '', 'the logo is not right above the Owner\'s name');
  check(ps > name, 'the P.S. does not follow the sign-off');
  check(/<img[^>]*\bwidth="(\d+)"/.test(html) && Number(html.match(/<img[^>]*\bwidth="(\d+)"/)[1]) <= 48, 'the logo is not small (48px wide or less)');
  check(/alt="Frequency"/.test(html), 'the logo has no alt text');
  check(html.includes('<a href="https://frequencylocal.com/q/pdc5pg6">https://frequencylocal.com/q/pdc5pg6</a>'), 'the short link is not a live link in the copied HTML');
  check(html.includes('&amp; I love') && html.includes('&lt;3') && !html.includes('<3'), 'the copied HTML does not escape the text');
  check(!String(out.bare).includes('<img'), 'a draft with no sign-off got a logo');

  // 2. Copy writes it.
  const editor = readFileSync(EDITOR, 'utf8');
  check(/['"]text\/html['"]/.test(editor) && /draftHtml\(/.test(editor), 'DraftEditor does not copy an HTML twin with draftHtml');

  // 3. The composed hunt draft.
  const body = runTs(`
    import { readFileSync } from 'node:fs';
    const h = await import(${JSON.stringify(pathToFileURL(HUNTS_TS).href)});
    const cfg = JSON.parse(readFileSync(${JSON.stringify(CONFIG)}, 'utf8'));
    const hunt = h.newHunt(cfg, { name: 'Art', looking_for: 'art workshops', region: 'north-county-sd' }, new Date('2026-11-10T08:00:00Z'));
    const lead = h.parseLeads({ leads: [{ hunt_id: hunt.id, event: { title: 'Bloom', url: 'https://example.com/e' },
      organizer: { email: 'elya@example.com', source_url: ${JSON.stringify(SRC)} },
      body: 'Hi Elya and team, your workshop caught my eye \\u2014 I love it!' }] })[0];
    console.log(JSON.stringify(h.composeBody(cfg, hunt, lead)));
  `);
  const tail = `\n\nDaniel Tyack\nFounder\nfrequencylocal.com\n\nP.S. I'm local to San Diego (North County) and found your address on ${SRC}.`;
  check(String(body).includes(tail), `a hunt draft does not end with the Owner's sign-off and P.S.: ${JSON.stringify(String(body).slice(-260))}`);
  check(/reply "no"/i.test(String(body).slice(String(body).indexOf('P.S.'))), 'the P.S. has no reply-"no" opt-out');
  check(!/[–—]/.test(String(body)), 'a hunt draft holds an em or en dash');

  // 4. The brief.
  const cycle = readFileSync(CYCLE_TS, 'utf8');
  check(cycle.includes('Sounds like a lovely way to spend an evening with the community!'), "the hunt brief does not carry the Owner's own Bloom opening");
});
