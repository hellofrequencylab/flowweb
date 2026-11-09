// Probe c0/cli-skeleton (FW-C-006; backlog verify_probe cli/skeleton).
// Surface: the fw CLI. `fw --help --json` lists the implemented commands as { commands: [ "ledger sync", ... ] }.
// Acceptance:
//   - every command accepts --json and prints exactly one JSON document (also on errors)
//   - exit codes: 2 usage, 4 locked writer (another process holds the store writer), 3 refused by
//     policy (fw wo issue on an XL row; the size table in core-policy.yaml refuses XL)
//   - fw --help lists no command that is not implemented (each listed command's --help exits 0 and
//     does not say "not implemented")
//   - the global --home flag overrides FW_HOME
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  dbPath,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  probe,
  root,
  sleep,
  tmpDir,
  TSX,
} from './_lib.mjs';

await probe('c0/cli-skeleton', async () => {
  const home = freshHome('cli');
  const help = fwJson(['--help'], { home });
  check(help.status === 0, `fw --help --json exited ${help.status}`);
  const commands = help.json?.commands;
  check(Array.isArray(commands) && commands.length > 0, 'fw --help --json has no "commands" array');
  for (const c of ['ledger sync', 'ledger list', 'ledger show', 'audit verify']) {
    check(commands.includes(c), `fw --help does not list "${c}"`);
  }

  const empty = tmpDir('cli-cwd');
  for (const c of commands) {
    const args = c.split(' ');
    const h = fw([...args, '--help'], { home, cwd: empty });
    check(h.status === 0, `fw ${c} --help exited ${h.status} (listed but not implemented?)`);
    check(!/not implemented|todo/i.test(h.stdout + h.stderr), `fw ${c} --help says it is not implemented`);
    const r = fw([...args, '--json'], { home, cwd: empty });
    try {
      JSON.parse(r.stdout);
    } catch {
      check(false, `fw ${c} --json (exit ${r.status}) did not print exactly one JSON document`);
    }
  }

  const usage = fw(['no-such-command', '--json'], { home });
  check(usage.status === 2, `an unknown command exited ${usage.status}, want 2`);

  const other = freshHome('cli-flag');
  const flagged = fw(['--home', other, 'audit', 'verify', '--json'], { home });
  check(flagged.status === 0, `fw --home <dir> audit verify exited ${flagged.status}`);
  check(existsSync(dbPath(other)), '--home did not override FW_HOME (no database under the --home dir)');

  // Exit 3: refused by policy.
  const proj = fixtureProject({ rowId: 'FW-C-902', size: 'XL' });
  const xl = freshHome('cli-xl');
  check(fw(['ledger', 'sync', '--json'], { home: xl, cwd: proj.work }).status === 0, 'fixture sync failed');
  const refused = fw(['wo', 'issue', 'FW-C-902', '--json'], { home: xl, cwd: proj.work });
  check(refused.status === 3, `fw wo issue on an XL row exited ${refused.status}, want 3 (refused by policy)`);

  // Exit 4: locked writer.
  const lockHome = freshHome('cli-lock');
  const holder = join(lockHome, 'holder.ts');
  writeFileSync(
    holder,
    `import { openStore } from ${JSON.stringify(join(root, 'packages/eventlog/src/index.ts'))};
const s = await openStore({ path: ${JSON.stringify(dbPath(lockHome))} });
void s.writer;
console.log('READY');
setTimeout(() => { s.close(); process.exit(0); }, 20000);
`,
  );
  const child = spawn(TSX, [holder], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  try {
    const until = Date.now() + 30000;
    while (!out.includes('READY')) {
      check(Date.now() < until && child.exitCode === null, `could not take the writer lock for the test: ${out.split('\n')[0]}`);
      await sleep(50);
    }
    const locked = fw(['ledger', 'sync', '--json'], { home: lockHome, cwd: proj.work, timeoutMs: 15000 });
    check(locked.status === 4, `fw ledger sync with the writer held elsewhere exited ${locked.status}, want 4`);
  } finally {
    child.kill('SIGKILL');
  }
});
