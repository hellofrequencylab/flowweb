#!/usr/bin/env node
// fwd: the FlowWeb Core daemon. `pnpm fwd [--home DIR] [--port N] [--pair]`.
// Binds 127.0.0.1 only. Exit 1 when another fwd holds the writer lock for the same FW_HOME.
import { parseArgs } from 'node:util';
import { WriterLockError } from '@fw/eventlog';
import { DEFAULT_PORT, startDaemon } from './daemon.ts';
import { resolveFwHome } from './runtime/paths.ts';

const USAGE = `usage: fwd [--home DIR] [--port N] [--pair]

  --home DIR   FW_HOME (default: $FW_HOME, else ~/.flowweb)
  --port N     loopback port (default: $FW_PORT, else ${DEFAULT_PORT}; 0 picks a free port)
  --host H     only 127.0.0.1 is accepted
  --pair       print a fresh one-time pairing code for a new browser

env: FW_HOME, FW_PORT, FW_DEV_NO_AUTH=1 (skip pairing and tokens; development only)`;

function fail(message: string): never {
  process.stderr.write(`fwd: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parse>;
  function parse() {
    return parseArgs({
      options: {
        home: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        pair: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  }
  try {
    args = parse();
  } catch (e) {
    fail(`${(e as Error).message}\n${USAGE}`);
  }
  if (args.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.values.host !== undefined && args.values.host !== '127.0.0.1') {
    fail('--host is fixed to 127.0.0.1 (loopback only)');
  }
  const rawPort = args.values.port ?? process.env.FW_PORT ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) fail(`invalid port: ${rawPort}`);
  const fwHome = args.values.home ?? resolveFwHome();
  const devNoAuth = process.env.FW_DEV_NO_AUTH === '1';

  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      fwHome,
      port: Number(rawPort),
      devNoAuth,
      forcePairingCode: args.values.pair,
    });
  } catch (e) {
    if (e instanceof WriterLockError) {
      fail(
        `another fwd is already running for FW_HOME=${fwHome} (writer lock ${e.lockPath}` +
          `${e.holderPid === undefined ? '' : ` held by pid ${e.holderPid}`}). Stop it first.`,
      );
    }
    fail(`could not start: ${(e as Error).message}`);
  }

  const out = (l: string) => process.stdout.write(`${l}\n`);
  out(`fwd ${daemon.startedAt} listening on ${daemon.url}/v1 (FW_HOME=${daemon.fwHome}, pid ${process.pid})`);
  if (devNoAuth) out('FW_DEV_NO_AUTH=1: pairing and tokens are OFF. Development only.');
  if (daemon.pairingCode) {
    out(
      `Pairing code: ${daemon.pairingCode}  (one use; POST /v1/pair {"code": "..."} or enter it in the web UI)`,
    );
  }
  out(`CLI token file: ${daemon.cliTokenPath}`);

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    daemon
      .stop(`signal ${signal}`)
      .then(() => {
        out(`fwd stopped (${signal})`);
        process.exit(0);
      })
      .catch((e: unknown) => {
        process.stderr.write(`fwd: unclean stop: ${(e as Error).message}\n`);
        process.exit(1);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main().catch((e: unknown) => fail((e as Error).stack ?? String(e)));
