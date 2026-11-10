// fw project list [--brand <b>] [--category <c>] [--group-by brand|category]: every project with
// its brand and category, optionally narrowed and grouped.
// fw project label <project> [--brand <b>] [--category <c>]: set a project's brand and category (by
// id or slug). An empty value clears one ("--brand ''"). Writes one project.updated event when
// something changed; with neither option it only prints the current labels.
// fw project add <slug> [--name] [--kind] [--brand] [--category]: a project with no repository
// (FW-C-038); a repository project still comes from `fw ledger sync`.
// fw project brief <project> [--what --who --voice --never --done]: the Owner's brief, five plain
// answers saved word for word (all five or nothing). With no answers it prints the saved brief.
import type { ProjectView } from '../client.ts';
import { EXIT, table } from '../output.ts';
import type { Command } from './types.ts';

class UnsupportedError extends Error {
  readonly code = 'CLIENT_UNAVAILABLE';
}

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

function unsupported(): never {
  throw new UnsupportedError(
    'the core client in use does not serve projects; the ledger package provides them',
  );
}

const GROUPS = ['brand', 'category'] as const;
type Group = (typeof GROUPS)[number];
const NONE = { brand: '(no brand)', category: '(no category)' } as const;

function rowsOf(projects: ProjectView[]): string[][] {
  return projects.map((p) => [p.slug, p.name, p.brand ?? '-', p.category ?? '-', p.status]);
}

const HEADER = ['PROJECT', 'NAME', 'BRAND', 'CATEGORY', 'STATUS'];

/** Groups in first-seen order, with the unlabelled group last. */
export function groupProjects(projects: ProjectView[], by: Group): [string, ProjectView[]][] {
  const groups = new Map<string, ProjectView[]>();
  for (const p of projects) {
    const key = p[by] ?? '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const named = [...groups].filter(([k]) => k !== '');
  const none = groups.get('');
  return [...named, ...(none ? [[NONE[by], none] as [string, ProjectView[]]] : [])];
}

const list: Command = {
  path: ['project', 'list'],
  usage: 'fw project list [--brand <b>] [--category <c>] [--group-by brand|category]',
  summary: 'List projects with their brand and category',
  args: [],
  options: ['brand', 'category', 'group-by'],
  async run(ctx) {
    if (typeof ctx.client.projectList !== 'function') unsupported();
    const by = ctx.opts['group-by'];
    if (by !== undefined && !GROUPS.includes(by as Group))
      throw fail('BAD_ARGUMENT', `--group-by must be one of ${GROUPS.join(', ')}`);
    const filter: { brand?: string; category?: string } = {};
    if (ctx.opts.brand) filter.brand = ctx.opts.brand;
    if (ctx.opts.category) filter.category = ctx.opts.category;
    const projects = await ctx.client.projectList(filter);
    if (ctx.json) {
      const doc = by
        ? { groups: groupProjects(projects, by as Group).map(([key, ps]) => ({ key, projects: ps })) }
        : { projects };
      ctx.io.out(JSON.stringify(doc, null, 2));
      return EXIT.OK;
    }
    if (!projects.length) {
      ctx.io.out('no projects');
      return EXIT.OK;
    }
    if (!by) {
      ctx.io.out(table([HEADER, ...rowsOf(projects)]));
      return EXIT.OK;
    }
    const out: string[] = [];
    for (const [key, ps] of groupProjects(projects, by as Group)) {
      if (out.length) out.push('');
      out.push(`${key} (${ps.length})`, table([HEADER, ...rowsOf(ps)]));
    }
    ctx.io.out(out.join('\n'));
    return EXIT.OK;
  },
};

const label: Command = {
  path: ['project', 'label'],
  usage: 'fw project label <project> [--brand <b>] [--category <c>]',
  summary: "Set or show a project's brand and category (an empty value clears)",
  args: ['project'],
  options: ['brand', 'category'],
  async run(ctx) {
    if (typeof ctx.client.projectLabel !== 'function') unsupported();
    const { brand, category } = ctx.opts;
    const change: { brand?: string | null; category?: string | null } = {};
    if (brand !== undefined) change.brand = brand;
    if (category !== undefined) change.category = category;
    const r = await ctx.client.projectLabel(ctx.args[0]!, change);
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else if (!r.changed_fields.length)
      ctx.io.out(
        `${r.project.slug}: brand ${r.project.brand ?? 'none'}, category ${r.project.category ?? 'none'} (no change)`,
      );
    else
      ctx.io.out(
        `${r.project.slug}: brand ${r.project.brand ?? 'none'}, category ${r.project.category ?? 'none'} (event #${r.event_seq})`,
      );
    return EXIT.OK;
  },
};

const add: Command = {
  path: ['project', 'add'],
  usage: 'fw project add <slug> [--name <n>] [--kind <k>] [--brand <b>] [--category <c>]',
  summary: 'Make a project that is not a code repository (a campaign, an inbox, ops work)',
  args: ['slug'],
  options: ['name', 'kind', 'brand', 'category'],
  async run(ctx) {
    if (typeof ctx.client.projectAdd !== 'function') unsupported();
    const { name, kind, brand, category } = ctx.opts;
    const r = await ctx.client.projectAdd({
      slug: ctx.args[0]!,
      ...(name !== undefined ? { name } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(brand !== undefined ? { brand } : {}),
      ...(category !== undefined ? { category } : {}),
    });
    if (ctx.json) ctx.io.out(JSON.stringify(r, null, 2));
    else {
      const p = r.project;
      ctx.io.out(
        `${p.slug}: made "${p.name}" (${p.kind}), brand ${p.brand ?? 'none'}, category ${p.category ?? 'none'} (event #${r.event_seq})`,
      );
      if (!p.brand || !p.category)
        ctx.io.out(`Next: pnpm fw project label ${p.slug} --brand <brand> --category <category>`);
      else ctx.io.out(`Next: pnpm fw project brief ${p.slug}`);
    }
    return EXIT.OK;
  },
};

/** The brief questions, in order (the same list as the ledger's BRIEF_QUESTIONS). */
export const BRIEF_QUESTIONS = [
  { key: 'what', question: 'What is this project, in one or two sentences?' },
  { key: 'who', question: 'Who is it for?' },
  { key: 'voice', question: 'How should it sound? Name the voice in a few words.' },
  { key: 'never', question: 'What must the agents never do on it?' },
  { key: 'done', question: 'What does done look like? Something you could check.' },
] as const;

const brief: Command = {
  path: ['project', 'brief'],
  usage: 'fw project brief <project> [--what <a>] [--who <a>] [--voice <a>] [--never <a>] [--done <a>]',
  summary: "Save the Owner's brief for a project (five plain answers, all or nothing), or show it",
  args: ['project'],
  options: BRIEF_QUESTIONS.map((q) => q.key),
  async run(ctx) {
    if (typeof ctx.client.projectBrief !== 'function') unsupported();
    const given = BRIEF_QUESTIONS.filter((q) => ctx.opts[q.key] !== undefined);
    if (given.length > 0 && given.length < BRIEF_QUESTIONS.length) {
      const missing = BRIEF_QUESTIONS.filter((q) => ctx.opts[q.key] === undefined).map((q) => `--${q.key}`);
      throw fail('USAGE', `a brief needs all five answers; missing ${missing.join(', ')}`);
    }
    const answers = given.length ? Object.fromEntries(given.map((q) => [q.key, ctx.opts[q.key]])) : undefined;
    const r = await ctx.client.projectBrief(ctx.args[0]!, answers);
    if (ctx.json) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return EXIT.OK;
    }
    const slug = r.project.slug;
    if (!r.brief) {
      ctx.io.out(`${slug} has no brief yet. The agents read it, so answer in your own words:`);
      for (const q of BRIEF_QUESTIONS) ctx.io.out(`  --${q.key.padEnd(5)}  ${q.question}`);
      ctx.io.out(
        `Then: pnpm fw project brief ${slug} --what "..." --who "..." --voice "..." --never "..." --done "..."`,
      );
      return EXIT.OK;
    }
    const b = r.brief;
    ctx.io.out(
      [
        `${slug} brief${answers ? (r.event_seq ? ` saved (event #${r.event_seq})` : ' (no change)') : ''}:`,
        ...BRIEF_QUESTIONS.map((q) => `  ${q.question}\n    ${b[q.key]}`),
      ].join('\n'),
    );
    return EXIT.OK;
  },
};

export const projectCommands: Command[] = [list, label, add, brief];
