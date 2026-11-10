// fw setup (FW-C-039): where this machine is in getting FlowWeb set up, one step at a time. Each
// step is checked from real state (fwd answering, a passing account test, a labelled project, a
// brief, a flow that is on, a recent push to the live site) and a step not done names its fix, so
// running it again picks up wherever you stopped. Exit 0 when every required step is done, else 1.
// In a terminal it also asks for what only the Owner can say: a project's name and labels, and the
// five brief questions, in plain words. Answers are saved word for word; a blank answer saves nothing.
import { createInterface } from 'node:readline';
import type { SetupReport, SetupStep } from '../client.ts';
import { EXIT } from '../output.ts';
import { BRIEF_QUESTIONS } from './project.ts';
import type { Command, CommandContext } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

export type Ask = (question: string) => Promise<string>;

/** Tests replace the terminal; everyone else gets a real prompt when stdin and stdout are a TTY. */
let makeAsk = (): Ask | null =>
  process.stdin.isTTY && process.stdout.isTTY
    ? (q) =>
        new Promise((ok) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
          rl.question(q, (a) => {
            rl.close();
            ok(a.trim());
          });
        })
    : null;
export function setSetupAsk(f: () => Ask | null): void {
  makeAsk = f;
}

const mark = (s: SetupStep) => (s.done ? '✓' : s.required ? '○' : '·');

export function renderSetup(r: SetupReport): string {
  const lines = [r.ready ? 'FlowWeb is set up.' : 'Setting up FlowWeb:', ''];
  r.steps.forEach((s, i) => {
    lines.push(`  ${mark(s)} ${i + 1}. ${s.title}${s.id === r.next ? '   <- next' : ''}`);
    lines.push(`       ${s.detail}`);
    if (!s.done && s.fix) lines.push(`       Do: ${s.fix}`);
  });
  lines.push('');
  if (r.ready) {
    const live = r.steps.find((s) => s.id === 'live_site');
    lines.push(
      live && !live.done
        ? 'Everything required is done. The live site is optional; its step says how.'
        : 'Everything is done. Run fw supervisor status to watch your flows.',
    );
  } else lines.push('Run pnpm fw setup again after each step; it picks up where you are.');
  return lines.join('\n');
}

const CATEGORIES = ['marketing', 'product', 'ops', 'sales', 'support', 'finance', 'other'];

/** Asks for a new project's slug, name, brand and category. Returns false when the Owner skips. */
async function askProject(ctx: CommandContext, ask: Ask): Promise<boolean> {
  const add = ctx.client.projectAdd;
  if (typeof add !== 'function') return false;
  ctx.io.out('\nA project is one body of work the agents help with, like a campaign or a product.');
  const name = await ask('Name it (blank to skip for now): ');
  if (!name) return false;
  const suggested = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  const slug = (await ask(`Short id for commands [${suggested}]: `)) || suggested;
  const brand = await ask('Which brand or business is it for? ');
  let category = '';
  while (!CATEGORIES.includes(category))
    category = (await ask(`What kind of work is it? (${CATEGORIES.join(', ')}): `)).toLowerCase();
  const r = await add.call(ctx.client, { slug, name, brand, category });
  ctx.io.out(`Made ${r.project.slug}.`);
  return true;
}

/** The five brief questions for one project. Returns false when the Owner skips. */
async function askBrief(ctx: CommandContext, ask: Ask, slug: string): Promise<boolean> {
  const save = ctx.client.projectBrief;
  if (typeof save !== 'function') return false;
  ctx.io.out(
    `\nFive plain questions about ${slug}. The agents read your answers before they work on it, so use your own words. A blank answer skips the brief for now.`,
  );
  const answers: Record<string, string> = {};
  for (const q of BRIEF_QUESTIONS) {
    const a = await ask(`${q.question}\n> `);
    if (!a) return false;
    answers[q.key] = a;
  }
  await save.call(ctx.client, slug, answers);
  ctx.io.out(`Saved the brief for ${slug}.`);
  return true;
}

const setup: Command = {
  path: ['setup'],
  usage: 'fw setup',
  summary: 'Walk through setting FlowWeb up: machine, sign-ins, project, brief, first flow, live site',
  args: [],
  options: [],
  async run(ctx) {
    const get = ctx.client.setup;
    if (typeof get !== 'function')
      throw new UnsupportedError(
        'the core client in use does not serve setup; the daemon package provides it',
      );
    let r = await get.call(ctx.client);
    const ask = ctx.json ? null : makeAsk();
    // Ask only for what the Owner alone can say, one step per run of the loop, and stop on a skip.
    for (let guard = 0; ask && guard < 3; guard++) {
      ctx.io.out(renderSetup(r));
      let asked = false;
      if (
        r.next === 'project' &&
        !r.steps.some((s) => s.id === 'project' && /project label/.test(s.fix ?? ''))
      )
        asked = await askProject(ctx, ask);
      else if (r.next === 'brief') {
        const slug = /project brief (\S+)/.exec(r.steps.find((s) => s.id === 'brief')?.fix ?? '')?.[1];
        if (slug && slug !== '<project>') asked = await askBrief(ctx, ask, slug);
      }
      if (!asked) return r.ready ? EXIT.OK : EXIT.FAILED;
      r = await get.call(ctx.client);
    }
    ctx.io.out(ctx.json ? JSON.stringify(r, null, 2) : renderSetup(r));
    return r.ready ? EXIT.OK : EXIT.FAILED;
  },
};

export const setupCommands: Command[] = [setup];
