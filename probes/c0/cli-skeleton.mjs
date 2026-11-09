// Probe c0/cli-skeleton (FW-C-006; backlog verify_probe cli/skeleton).
// Surface: the fw CLI. `fw --help --json` prints { commands: [{ usage, summary }] }; a command's
// name is its usage up to the first <arg> or [option].
// Acceptance:
//   - every command accepts --json and prints exactly one JSON document (also on errors)
//   - exit codes: 2 usage, 4 locked writer (a running fwd holds $FW_HOME/fwd.lock, the one writer
//     lock the CLI and fwd share; decision 31), 3 refused by policy (fw wo issue on an XL row: the
//     size table in core-policy.yaml has no caps for XL)
//   - fw --help lists no command that is not implemented (each listed command, run, is recognised:
//     it never answers "unknown command" or "not implemented")
//   - the global --home flag overrides FW_HOME
// Exit 3 is still open in the code (decision 22: refusals exit 1), so this probe fails on that line.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  killAndWait,
  dbPath,
  fixtureProject,
  freshHome,
  fw,
  fwJson,
  installPolicy,
  probe,
  spawnTs,
  tmpDir,
  waitFor,
} from './_lib.mjs';

const nameOf = (usage) => {
  const words = [];
  for (const w of usage.replace(/^fw\s+/, '').split(/\s+/)) {
    if (w.startsWith('<') || w.startsWith('[')) break;
    words.push(w);
  }
  return words.join(' ');
};

await probe('c0/cli-skeleton', async () => {
  const home = freshHome('cli');
  const help = fwJson(['--help'], { home });
  check(help.status === 0, `fw --help --json exited ${help.status}`);
  const listed = help.json?.commands;
  check(Array.isArray(listed) && listed.length > 0, 'fw --help --json has no "commands" array');
  const commands = listed.map((c) => nameOf(typeof c === 'string' ? c : c.usage));
  for (const c of ['ledger sync', 'ledger list', 'ledger show', 'ledger next', 'ledger close', 'audit verify']) {
    check(commands.includes(c), `fw --help does not list "${c}"`);
  }

  const empty = tmpDir('cli-cwd');
  for (const c of commands) {
    const args = c.split(' ');
    const h = fw([...args, '--help'], { home, cwd: empty });
    check(h.status === 0, `fw ${c} --help exited ${h.status}`);
    const r = fw([...args, '--json'], { home, cwd: empty });
    let doc;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      check(false, `fw ${c} --json (exit ${r.status}) did not print exactly one JSON document`);
    }
    const text = JSON.stringify(doc);
    check(!/unknown command|not implemented/i.test(text), `fw ${c} is listed but answers: ${text.slice(0, 160)}`);
  }

  const usage = fw(['no-such-command', '--json'], { home });
  check(usage.status === 2, `an unknown command exited ${usage.status}, want 2`);
  try {
    JSON.parse(usage.stdout);
  } catch {
    check(false, 'a usage error with --json did not print one JSON document');
  }

  // --home beats FW_HOME.
  const proj = fixtureProject({ rowId: 'FW-C-902', size: 'XL' });
  const envHome = freshHome('cli-env');
  const other = freshHome('cli-flag');
  const flagged = fw(['--home', other, 'ledger', 'sync', '--json'], { home: envHome, cwd: proj.work });
  check(flagged.status === 0, `fw --home <dir> ledger sync exited ${flagged.status}: ${flagged.stdout.slice(0, 200)}`);
  check(existsSync(dbPath(other)), '--home did not override FW_HOME (no database under the --home dir)');
  check(!existsSync(dbPath(envHome)), '--home was given but the database went under FW_HOME');

  // Exit 4: a running fwd holds the writer lock of the same home.
  const lockHome = freshHome('cli-lock');
  const fwd = spawnTs(DAEMON_BIN, ['--home', lockHome, '--port', '0'], { env: { FW_HOME: lockHome } });
  try {
    await waitFor(() => /listening on/.test(fwd.output()) || fwd.exitCode !== null, {
      timeoutMs: 30000,
      what: 'fwd to listen',
    });
    check(fwd.exitCode === null, `fwd did not start: ${fwd.output().split('\n')[0]}`);
    const locked = fw(['ledger', 'sync', '--json'], { home: lockHome, cwd: proj.work, timeoutMs: 15000 });
    check(locked.status === 4, `fw ledger sync while fwd holds the writer exited ${locked.status}, want 4`);
    try {
      JSON.parse(locked.stdout);
    } catch {
      check(false, 'the locked-writer refusal with --json did not print one JSON document');
    }
  } finally {
    await killAndWait(fwd);
  }

  // Exit 3: refused by policy. The XL row is made ready first (its probe fails), so only the size
  // rule can refuse it.
  installPolicy(other);
  const ready = fwJson(['--home', other, 'ledger', 'retest', 'FW-C-902'], { home: other, cwd: proj.work });
  check(ready.status === 0 && /"ready"/.test(ready.stdout), `fw ledger retest FW-C-902 did not make it ready: ${ready.stdout.slice(0, 200)}`);
  const refused = fw(['wo', 'issue', 'FW-C-902', '--json'], { home: other, cwd: proj.work });
  check(refused.status !== 0, 'fw wo issue on an XL row was not refused');
  check(refused.status === 3, `fw wo issue on an XL row exited ${refused.status}, want 3 (refused by policy)`);
});
