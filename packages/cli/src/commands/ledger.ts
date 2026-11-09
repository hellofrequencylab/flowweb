// fw ledger sync | list | show | next | retest | close
import type { RowView } from '../client.ts';
import { EXIT, short, table } from '../output.ts';
import type { Command, CommandContext } from './types.ts';

const print = (ctx: CommandContext, value: unknown) => ctx.io.out(JSON.stringify(value, null, 2));

function rowTable(rows: RowView[]): string {
  return table([
    ['CODE', 'STATUS', 'PRI', 'SIZE', 'WAVE', 'LANE', 'PROBE', 'TITLE'],
    ...rows.map((r) => [
      r.code,
      r.status,
      r.priority,
      r.size,
      r.wave ?? '-',
      r.lane,
      r.last_probe_status,
      r.title,
    ]),
  ]);
}

const sync: Command = {
  path: ['ledger', 'sync'],
  usage: 'fw ledger sync [--rows <dir>] [--project <slug>] [--project-name <name>]',
  summary: 'Import row definition files as open rows; refuse any changed probe (all or nothing)',
  args: [],
  options: ['rows', 'project', 'project-name'],
  async run(ctx) {
    const report = await ctx.client.ledgerSync(ctx.opts.rows ? { rowsDir: ctx.opts.rows } : {});
    const ok = report.refused.length === 0;
    if (ctx.json) {
      print(ctx, report);
      return ok ? EXIT.OK : EXIT.FAILED;
    }
    const g = report.graph;
    const graph = g.acyclic
      ? `dependency graph acyclic: ${g.rows} rows, ${g.edges} edges`
      : `dependency graph has ${g.cycles.length} cycle(s)`;
    if (ok) {
      ctx.io.out(
        `ledger sync: ${report.created.length} created, ${report.unchanged.length} unchanged, 0 refused (${graph})`,
      );
      for (const d of report.drifted)
        ctx.io.out(
          `  note: ${d.code} differs from the ledger in ${d.fields.join(', ')} (not changed by sync)`,
        );
      return EXIT.OK;
    }
    ctx.io.out(`ledger sync: REFUSED, no row was written (${report.refused.length} refused; ${graph})`);
    for (const r of report.refused) {
      if (r.reason === 'probe_changed')
        ctx.io.out(
          `  ${r.code} (${r.id}): probe changed\n    stored ${r.stored_hash}\n    file   ${r.file_hash}` +
            (r.finding_id ? `\n    tamper finding ${r.finding_id} recorded (audit.finding_raised)` : ''),
        );
      else ctx.io.out(`  ${r.code}: ${r.reason}: ${r.message}`);
    }
    return EXIT.FAILED;
  },
};

const list: Command = {
  path: ['ledger', 'list'],
  usage: 'fw ledger list [--status <status>] [--lane <lane>]',
  summary: 'List ledger rows',
  args: [],
  options: ['status', 'lane'],
  async run(ctx) {
    const rows = await ctx.client.ledgerList({
      ...(ctx.opts.status ? { status: ctx.opts.status } : {}),
      ...(ctx.opts.lane ? { lane: ctx.opts.lane } : {}),
    });
    if (ctx.json) print(ctx, rows);
    else ctx.io.out(rows.length ? `${rowTable(rows)}\n${rows.length} row(s)` : 'no rows');
    return EXIT.OK;
  },
};

const show: Command = {
  path: ['ledger', 'show'],
  usage: 'fw ledger show <code>',
  summary: 'Show one row with its probe, evidence, work orders and recent events',
  args: ['code'],
  options: [],
  async run(ctx) {
    const d = await ctx.client.ledgerShow(ctx.args[0]!);
    if (ctx.json) {
      print(ctx, d);
      return EXIT.OK;
    }
    const r = d.row;
    const lines = [
      `${r.code}  ${r.title}`,
      `  id ${r.id}   status ${r.status}   ${r.priority} ${r.size}   lane ${r.lane}   wave ${r.wave ?? '-'}`,
      `  owner ${r.owner.kind} ${r.owner.id}`,
      `  depends on ${r.depends_on.length ? r.depends_on.join(', ') : 'nothing'}`,
      `  probe ${d.probe.kind}: ${(d.probe.command?.argv ?? []).join(' ')}   (hash ${short(r.probe_hash, 16)})`,
      `  last probe ${r.last_probe_status}${r.last_probe_at ? ` at ${r.last_probe_at}` : ''}   premise ${
        r.premise_valid === null ? 'not re-tested' : r.premise_valid ? 'valid' : 'already satisfied'
      }`,
    ];
    if (r.merged_sha) lines.push(`  merged ${r.merged_sha}`);
    for (const e of d.evidence)
      lines.push(
        `  evidence ${e.id} bound to ${short(e.subject_sha)}  hash ${short(e.bundle_hash, 16)}${
          e.probe ? `  probe exit ${e.probe.exit_code} in ${e.probe.duration_ms} ms` : ''
        }`,
      );
    for (const w of d.work_orders)
      lines.push(`  work order ${w.id} v${w.version} ${w.status} doer ${w.doer_agent_id ?? '-'}`);
    if (d.events.length) lines.push('  events:');
    for (const e of d.events) lines.push(`    #${e.seq} ${e.ts} ${e.type}`);
    ctx.io.out(lines.join('\n'));
    return EXIT.OK;
  },
};

const next: Command = {
  path: ['ledger', 'next'],
  usage: 'fw ledger next',
  summary: 'Print the next ready row whose dependencies are done',
  args: [],
  options: [],
  async run(ctx) {
    const n = await ctx.client.ledgerNext();
    if (ctx.json) print(ctx, n);
    else if (n.row) ctx.io.out(rowTable([n.row]));
    else
      ctx.io.out(
        `no ready row with its dependencies done (${n.retest_candidates} open row(s) could be re-tested: fw ledger retest <code>)`,
      );
    return EXIT.OK;
  },
};

const retest: Command = {
  path: ['ledger', 'retest'],
  usage: 'fw ledger retest <code>',
  summary: 'Re-test a row premise: a failing probe makes it ready, a passing one parks it',
  args: ['code'],
  options: [],
  async run(ctx) {
    const p = await ctx.client.ledgerRetest(ctx.args[0]!, { repoDir: ctx.repoDir });
    if (ctx.json) print(ctx, p);
    else {
      const what =
        p.outcome === 'ready'
          ? 'probe fails, premise holds: row is ready'
          : p.outcome === 'parked'
            ? 'probe already passes: premise already satisfied, row parked'
            : `inconclusive (${p.probe.timed_out ? 'timed out' : (p.probe.error ?? p.probe.status)}): row stays ${p.to}`;
      ctx.io.out(
        `ledger retest ${p.code}: ${what} (${p.from} -> ${p.to}, exit ${p.probe.exit_code}, ${p.probe.duration_ms} ms, result ${p.result_id})`,
      );
    }
    return p.still_valid === null ? EXIT.FAILED : EXIT.OK;
  },
};

const close: Command = {
  path: ['ledger', 'close'],
  usage: 'fw ledger close <code> --merged-sha <sha>',
  summary: 'Run the probe on the merged commit, store the evidence bundle and move verifying -> done',
  args: ['code'],
  options: ['merged-sha'],
  required: ['merged-sha'],
  async run(ctx) {
    const c = await ctx.client.ledgerClose(ctx.args[0]!, {
      mergedSha: ctx.opts['merged-sha']!,
      repoDir: ctx.repoDir,
    });
    if (ctx.json) print(ctx, c);
    else
      ctx.io.out(
        `ledger close ${c.code}: done; probe exit ${c.probe.exit_code} in ${c.probe.duration_ms} ms on ${c.merged_sha}; evidence ${c.bundle_id} (${short(c.bundle_hash, 16)})`,
      );
    return EXIT.OK;
  },
};

export const ledgerCommands: Command[] = [sync, list, show, next, retest, close];
