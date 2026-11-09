// Child process used by the writer-lock tests: tries to append one event to the store at argv[2].
// Prints one JSON line with the outcome. Exit 0 = appended, 3 = WriterLockError, 1 = anything else.
import { openStore, WriterLockError } from '../../src/index.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: second-writer.ts <db path>');
const started = Date.now();
try {
  const store = openStore({ path });
  const ev = store.writer!.appendEvent({
    type: 'system.started',
    actor_kind: 'system',
    actor_id: 'child',
    payload: { pid: process.pid },
  });
  store.close();
  console.log(JSON.stringify({ result: 'appended', seq: ev.seq, ms: Date.now() - started }));
  process.exit(0);
} catch (e) {
  if (e instanceof WriterLockError) {
    console.log(
      JSON.stringify({ result: 'locked', code: e.code, holderPid: e.holderPid, ms: Date.now() - started }),
    );
    process.exit(3);
  }
  console.log(JSON.stringify({ result: 'error', message: String(e) }));
  process.exit(1);
}
