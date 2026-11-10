// fw doctor: the health checks of this home (policy, credentials, disk, clock, backups) and the
// sandbox self-test. Exits nonzero when any check failed, in --json mode too, so a script or a
// service manager can act on it.
import { EXIT, table } from '../output.ts';
import { need } from './system.ts';
import type { Command } from './types.ts';

const MARK = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;

const doctor: Command = {
  path: ['doctor'],
  usage: 'fw doctor',
  summary: 'Check this home (policy, credentials, disk, clock, last backup) and run the sandbox self-test',
  args: [],
  options: [],
  async run(ctx) {
    const r = await need(ctx.client, 'doctor')();
    const failed = r.checks.filter((c) => c.status === 'fail');
    const code = failed.length > 0 ? EXIT.FAILED : EXIT.OK;
    if (ctx.json) {
      ctx.io.out(JSON.stringify(r, null, 2));
      return code;
    }
    const s = r.sandbox;
    ctx.io.out(
      [
        `doctor: ${r.checks.length - failed.length} of ${r.checks.length} checks without a failure (home ${r.home})`,
        table(r.checks.map((c) => [`  ${MARK[c.status]}`, c.name, c.detail])),
        `sandbox: ${s.mode} on ${s.platform}, overall ${s.level}`,
        table(Object.entries(s.controls).map(([name, c]) => [`  ${name}`, c.level, c.detail])),
        ...s.notes.map((n) => `note: ${n}`),
      ].join('\n'),
    );
    return code;
  },
};

export const doctorCommands: Command[] = [doctor];
