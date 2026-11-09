// Fixture for c1/lease-manager (not a probe). One lease operation in its own process, so the probe
// can race two real processes. Run with tsx as an import hook (spawnTs):
//   node --import <tsx loader> lease-op.mjs '<json>'
// json: { root, home, op: 'acquire' | 'heartbeat' | 'release' | 'checkFence', args, at? }
// It waits until `at` (epoch ms, the race barrier), opens the store the way fwd does
// ($FW_HOME/db/fw.sqlite, writer lock $FW_HOME/fwd.lock; a held writer lock is retried for up to
// 10 s, so both racers really reach the lease manager), calls the @fw/ledger export, closes the store
// and prints one JSON line: { ok: true, result } | { ok: false, error: { name, code, message } } |
// { missing: [export names] }.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const req = JSON.parse(process.argv[2]);
const ledger = await import(pathToFileURL(join(req.root, 'packages/ledger/src/index.ts')).href);
const { openStore } = await import(pathToFileURL(join(req.root, 'packages/eventlog/src/index.ts')).href);

const FNS = { acquire: 'acquireLease', heartbeat: 'heartbeatLease', release: 'releaseLease', checkFence: 'checkFence' };
const absent = Object.values(FNS).filter((n) => typeof ledger[n] !== 'function');
if (absent.length) {
  console.log(JSON.stringify({ missing: absent }));
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (req.at) await sleep(Math.max(0, req.at - Date.now()));
const late_ms = req.at ? Date.now() - req.at : 0;

const errOf = (e) => ({ name: e?.name, code: e?.code, message: String(e?.message ?? e) });
let store;
const until = Date.now() + 10000;
for (;;) {
  try {
    store = openStore({ path: join(req.home, 'db', 'fw.sqlite'), lockPath: join(req.home, 'fwd.lock') });
    void store.writer;
    break;
  } catch (e) {
    try {
      store?.close();
    } catch {}
    store = undefined;
    if (e?.name !== 'WriterLockError' || Date.now() > until) {
      console.log(JSON.stringify({ ok: false, error: errOf(e), late_ms, stage: 'open' }));
      process.exit(0);
    }
    await sleep(10 + Math.floor(Math.random() * 40));
  }
}
let out;
try {
  const result = await ledger[FNS[req.op]](store.writer, req.args);
  out = { ok: true, result: result ?? null, late_ms };
} catch (e) {
  out = { ok: false, error: errOf(e), late_ms };
} finally {
  store.close();
}
console.log(JSON.stringify(out));
