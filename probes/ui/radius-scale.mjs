// Probe for FW-C-079 (one smaller corner radius scale across the web UI): `pnpm probe ui/radius-scale`.
// probe-timeout-s: 60
// Tier 0.
// Surfaces: every stylesheet under packages/web/src, with the scale in packages/web/src/ui-kit/tokens.css.
//
// The surface this probe expects:
//   tokens.css sets --radius-xs: 4px, --radius-sm: 6px, --radius-md: 8px, --radius-lg: 12px, and --radius-flow
//     (if set) to 12px or less, in every theme block that sets them;
//   no .css file under packages/web/src has a literal border-radius length above 12px, except a full pill (99px+);
//   .btn, .btn-quiet, .btn-small and .inbox-filter are not pills (no radius-full / 99px+) and use at most 8px;
//   .inbox uses a smaller radius than .panel, and .inbox-list has padding that is not zero.
//
// Proves, in order:
//   1. The token scale.
//   2. No large literal radii.
//   3. Controls are not pills.
//   4. The drafts inbox nests inside its card.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check, probe, root } from '../c0/_lib.mjs';

const NAME = 'ui/radius-scale';
const SRC = join(root, 'packages/web/src');

const cssFiles = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : cssFiles(p);
    return n.endsWith('.css') ? [p] : [];
  });
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    sels: m[1].split(',').map((x) => x.trim()),
    decl: m[2],
  }));

await probe(NAME, async () => {
  const tokens = strip(readFileSync(join(SRC, 'ui-kit/tokens.css'), 'utf8'));
  const allCss = cssFiles(SRC).map((f) => ({ f, css: strip(readFileSync(f, 'utf8')) }));

  // 1. The token scale.
  const want = { xs: 4, sm: 6, md: 8, lg: 12 };
  const bad1 = [];
  for (const [k, v] of Object.entries(want)) {
    const vals = [...tokens.matchAll(new RegExp(`--radius-${k}\\s*:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    if (vals.length === 0) bad1.push(`--radius-${k} is not set`);
    for (const x of vals) if (x !== `${v}px`) bad1.push(`--radius-${k} is ${x}, want ${v}px`);
  }
  for (const m of tokens.matchAll(/--radius-flow\s*:\s*(\d+)px/g))
    if (Number(m[1]) > 12) bad1.push(`--radius-flow is ${m[1]}px, want 12px or less`);
  check(bad1.length === 0, `the radius scale is still the large one (row FW-C-079):\n${bad1.join('\n')}`);

  // 2. No large literal radii.
  const bad2 = [];
  for (const { f, css } of allCss)
    for (const m of css.matchAll(/border(?:-[a-z]+)*-radius\s*:\s*([^;]+);/g))
      for (const n of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) {
        const px = Number(n[1]);
        if (px > 12 && px < 99) bad2.push(`${relative(root, f)}: border-radius ${m[1].trim()}`);
      }
  check(bad2.length === 0, `literal radii above 12px remain (row FW-C-079):\n${bad2.slice(0, 12).join('\n')}`);

  // 3. Controls are not pills.
  const all = allCss.flatMap(({ css }) => rules(css));
  const radiusOf = (sel) =>
    all
      .filter((r) => r.sels.includes(sel))
      .map((r) => r.decl.match(/(?:^|;|\s)border-radius\s*:\s*([^;]+)/)?.[1]?.trim())
      .filter(Boolean)
      .pop();
  const px = (v) => {
    if (!v) return null;
    if (/radius-full|9{2,}px/.test(v)) return 999;
    const t = v.match(/var\(--radius-(xs|sm|md|lg)\)/);
    if (t) return want[t[1]];
    const n = v.match(/^(\d+)px$/);
    return n ? Number(n[1]) : null;
  };
  const bad3 = [];
  for (const sel of ['.btn', '.btn-quiet', '.btn-small', '.inbox-filter']) {
    const v = radiusOf(sel);
    const p = px(v);
    if (p == null) bad3.push(`${sel} has no readable border-radius (${v ?? 'none'})`);
    else if (p > 8) bad3.push(`${sel} is rounded ${v}, want 8px or less`);
  }
  check(bad3.length === 0, `buttons and filter chips are still pills (row FW-C-079):\n${bad3.join('\n')}`);

  // 4. The drafts inbox nests inside its card.
  const inbox = px(radiusOf('.inbox'));
  const panel = px(radiusOf('.panel'));
  check(
    inbox != null && panel != null && inbox < panel,
    `the drafts inbox (${inbox}px) is not tighter than its card (${panel}px) (row FW-C-079)`,
  );
  const listPad = all
    .filter((r) => r.sels.includes('.inbox-list'))
    .map((r) => r.decl.match(/(?:^|;|\s)padding\s*:\s*([^;]+)/)?.[1]?.trim())
    .filter(Boolean)[0];
  check(
    listPad != null && !/^0(px)?$/.test(listPad),
    `the drafts list has no padding, so the selected row runs into the corner (row FW-C-079): padding ${listPad}`,
  );
});
