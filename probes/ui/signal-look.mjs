// Probe for FW-C-150 (flowweb.app in the Signal look, with a public homepage that moves): `pnpm probe ui/signal-look`.
// probe-timeout-s: 60
// Tier 0.
// Surfaces: packages/web/src/ui-kit/tokens.css and fonts/, packages/web/src/home/HomePage.tsx and home.css.
//
// The surface this probe expects:
//   tokens.css loads Bricolage Grotesque, Geist, JetBrains Mono and Instrument Serif from ui-kit/fonts, every
//     font file it names exists, and the old faces (Urbanist, Playwrite, Instrument Sans, Geist Mono) are gone;
//   --font-display names Bricolage Grotesque, --font-sans Geist, --font-mono JetBrains Mono, --font-script
//     Instrument Serif;
//   the signed-out homepage has a section on what motion means (running, waiting on you, stopped), a
//     how-it-works band, a people band and a closing call to action that points at the account card;
//   home.css animates the page (at least three @keyframes), and base.css still stops every animation under
//     prefers-reduced-motion and calm mode.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, probe, root } from '../c0/_lib.mjs';

const NAME = 'ui/signal-look';
const KIT = join(root, 'packages/web/src/ui-kit');
const HOME = join(root, 'packages/web/src/home');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

await probe(NAME, async () => {
  const tokens = strip(readFileSync(join(KIT, 'tokens.css'), 'utf8'));

  // 1. The faces.
  const bad1 = [];
  for (const f of ['Bricolage Grotesque', 'Geist', 'JetBrains Mono', 'Instrument Serif'])
    if (!new RegExp(`font-family:\\s*["']${f}["']`).test(tokens)) bad1.push(`no @font-face for ${f}`);
  for (const m of tokens.matchAll(/url\(["']?\.\/fonts\/([^"')]+)["']?\)/g))
    if (!existsSync(join(KIT, 'fonts', m[1]))) bad1.push(`fonts/${m[1]} is missing`);
  for (const old of ['Urbanist', 'Playwrite', 'Instrument Sans', 'Geist Mono'])
    if (tokens.includes(old)) bad1.push(`tokens.css still names ${old}`);
  const role = (k, f) => {
    const v = tokens.match(new RegExp(`--font-${k}\\s*:\\s*([^;]+);`));
    if (!v || !v[1].includes(f)) bad1.push(`--font-${k} does not lead with ${f}`);
  };
  role('display', 'Bricolage Grotesque');
  role('sans', 'Geist');
  role('mono', 'JetBrains Mono');
  role('script', 'Instrument Serif');
  check(bad1.length === 0, `the app is not on the Signal faces yet (row FW-C-150):\n${bad1.join('\n')}`);

  // 2. The homepage story.
  const page = readFileSync(join(HOME, 'HomePage.tsx'), 'utf8');
  const bad2 = [];
  for (const id of ['home-motion', 'home-how', 'home-people', 'home-end'])
    if (!page.includes(`id="${id}"`)) bad2.push(`no section #${id}`);
  for (const t of ['Running', 'Waiting on you', 'Stopped']) if (!page.includes(t)) bad2.push(`no "${t}" state`);
  if ((page.match(/href="#account"/g) ?? []).length < 2) bad2.push('fewer than two calls to action point at #account');
  if (page.includes('—')) bad2.push('an em dash in the homepage');
  check(bad2.length === 0, `the homepage is not the Signal story yet (row FW-C-150):\n${bad2.join('\n')}`);

  // 3. Motion, and the switch that stops it.
  const css = strip(readFileSync(join(HOME, 'home.css'), 'utf8'));
  const base = strip(readFileSync(join(KIT, 'base.css'), 'utf8'));
  const frames = (css.match(/@keyframes\s+[\w-]+/g) ?? []).length;
  check(frames >= 3, `home.css has ${frames} @keyframes, want at least 3 (row FW-C-150)`);
  check(
    /prefers-reduced-motion:\s*reduce[\s\S]*?animation:\s*none\s*!important/.test(base) &&
      /data-calm="on"\][\s\S]*?animation:\s*none\s*!important/.test(base),
    'base.css no longer stops every animation under reduced motion and calm mode',
  );
});
