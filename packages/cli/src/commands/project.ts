// fw project list [--brand <b>] [--category <c>] [--group-by brand|category]: every project with
// its brand and category, optionally narrowed and grouped.
// fw project label <project> [--brand <b>] [--category <c>]: set a project's brand and category (by
// id or slug). An empty value clears one ("--brand ''"). Writes one project.updated event when
// something changed; with neither option it only prints the current labels.
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

export const projectCommands: Command[] = [list, label];
