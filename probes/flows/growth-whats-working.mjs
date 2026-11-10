// Probe for FW-C-078 (the Growth page shows what's working in its Reach chapter):
// `pnpm probe flows/growth-whats-working`. Tier 0.
// Surfaces: packages/web/src/flows/ActivationPage.tsx (the Growth page) and the WhatsWorking component that
// packages/web/src/flows exports (FW-C-072; its own checks are probes/flows/whats-working.mjs).
//
// The surface this probe expects:
//   ActivationPage imports WhatsWorking and renders <WhatsWorking flow={KEY} /> inside the Reach chapter:
//   after the <ChapterHead ... title="Reach" ...> and before the next <ChapterHead. The FW-C-070
//   placeholder comment ("mount spot for the weekly review's card") is gone.
//
// Proves, in order:
//   1. WhatsWorking is exported from packages/web/src/flows.
//   2. The placeholder is gone, and the Growth page renders the card in the Reach chapter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/growth-whats-working';
const FLOWS = join(root, 'packages/web/src/flows');

await probe(NAME, async () => {
  const index = readFileSync(join(FLOWS, 'index.ts'), 'utf8');
  check(/\bWhatsWorking\b/.test(index), 'packages/web/src/flows does not export WhatsWorking (row FW-C-072)');

  const raw = readFileSync(join(FLOWS, 'ActivationPage.tsx'), 'utf8');
  check(!/mount spot for the weekly review's card/.test(raw), 'the placeholder comment for the card is still there');
  // Comments do not render: look for the card in the code only.
  const page = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const use = page.search(/<WhatsWorking\s+flow=\{KEY\}\s*\/>/);
  if (use < 0) missing('the Growth page does not render <WhatsWorking flow={KEY} /> (row FW-C-078)');
  check(/import\s*\{[^}]*\bWhatsWorking\b[^}]*\}\s*from\s*'\.\/(WhatsWorking|index)?'/.test(page), 'the Growth page does not import WhatsWorking');
  const reach = page.search(/<ChapterHead[^>]*title="Reach"/);
  check(reach >= 0, 'the Growth page has no Reach chapter');
  const after = page.slice(reach + 1).search(/<ChapterHead\b/);
  const next = after < 0 ? page.length : reach + 1 + after;
  check(use > reach && use < next, 'WhatsWorking is not in the Reach chapter');
});
