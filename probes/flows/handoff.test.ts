// Probe for FW-C-037 (the Autopilot hand-off outbox): `pnpm probe flows/handoff`. Tier 0.
// Surfaces: handOff, setFlowEnabled and setDial exported by packages/daemon/src/index.ts, over a real
// store (openStore on $FW_HOME/db/fw.sqlite with the writer lock, the way fwd opens it); the outbox
// folder $FW_HOME/outbox/<flow>/; the config override $FW_HOME/flows/<flow>/config.json; and the
// events table read back with node:sqlite read-only.
// The surface this probe expects:
//   handOff({ writer, repoRoot, fwHome, flow, item: { id, channel, body } })
//     -> { outcome: 'queued', path } | { outcome: 'held', reason }
//   Queued means one JSON file at $FW_HOME/outbox/<flow>/<id>.json for a sending app outside Core
//   to pick up, and one notification.queued event (an existing type: no schema change) whose payload
//   has kind "flow_handoff", the flow, the item id, the channel, the body's sha256 and a dedupe_key.
//   Core never sends: queuing writes a local file and nothing else. A held item writes no file, and its reason starts with why ("<why>: <words>").
//
// Proves, in order:
//   1. At Draft, and at Copilot, an item is held by needs_owner: it waits for the Owner, and no
//      file appears in the outbox.
//   2. At Autopilot, confirmed, an item for one of the flow's own channels is queued: the file holds
//      the flow, the channel, the body, the confirm hash the Owner approved and the sha256 of the
//      body, and one notification.queued event of kind flow_handoff names the flow, the item and that sha256.
//   3. Handing off the same item again queues nothing new: one file, one event.
//   4. An item for a channel the flow does not list is held by unknown_channel.
//   5. After the flow's channels change, an item is held by dial_unapproved until the Owner confirms.
//   6. A flow the Owner has not enabled holds its items by flow_disabled.
//   7. With the kill switch engaged, an item is held by kill_switch.
//   8. Nothing in this probe wrote a run, an approval or any event other than notification.queued and the
//      Owner's own system.config_changed events.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { check, fixtureProject, freshHome, fw, openDbReadonly, requireExport, root, storePath } from '../c0/_lib.mjs';

type Result = { outcome: 'queued'; path: string } | { outcome: 'held'; reason: string };
type HandOff = (o: object) => Result;

const ROW = 'FW-C-037';
const KEY = 'local-saturation';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('flows/handoff', () => {
  let store: { writer: unknown; close(): void } | undefined;
  afterAll(() => store?.close());

  test('only a confirmed Autopilot flow hands finished items to the outbox, and Core never sends', async () => {
    const handOff = (await requireExport('daemon', 'handOff', ROW)) as HandOff;
    const setFlowEnabled = (await requireExport('daemon', 'setFlowEnabled', ROW)) as (...a: unknown[]) => unknown;
    const setDial = (await requireExport('daemon', 'setDial', ROW)) as (...a: unknown[]) => unknown;
    const { openStore } = await import(join(root, 'packages/eventlog/src/index.ts'));

    const home = freshHome('flows-handoff');
    const proj = fixtureProject({ rowId: 'FW-C-961' });
    check(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status === 0, 'fw ledger sync failed');
    let db = await openDbReadonly(home);
    const seq0 = Number((db.prepare('SELECT coalesce(max(seq), 0) AS s FROM events').get() as { s: number }).s);
    db.close();

    store = openStore({ path: storePath(home), lockPath: join(home, 'fwd.lock') });
    const w = store!.writer;
    const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
    const channel = cfg.channels[0].key as string;
    const outbox = join(home, 'outbox', KEY);
    const files = () => (existsSync(outbox) ? readdirSync(outbox).filter((f) => f.endsWith('.json')) : []);
    const give = (id: string, ch = channel, body = `Probe post ${id}`) =>
      handOff({ writer: w, repoRoot: root, fwHome: home, flow: KEY, item: { id, channel: ch, body } });
    const heldBy = (r: Result, why: string, step: string) =>
      expect([r.outcome, r.outcome === 'held' ? r.reason.split(':')[0] : ''], step).toEqual(['held', why]);
    const confirm = () => {
      let hash: string | undefined;
      try {
        setDial(w, root, home, KEY, 'autopilot');
      } catch (e) {
        hash = (e as { details?: { confirm_hash?: string } }).details?.confirm_hash;
      }
      check(typeof hash === 'string', 'setDial to autopilot without a hash did not name the confirm hash');
      setDial(w, root, home, KEY, 'autopilot', hash);
      return hash!;
    };

    // ---- 1. Draft and Copilot wait for the Owner ------------------------------------------------
    setFlowEnabled(w, root, KEY, true);
    heldBy(give('item-draft'), 'needs_owner', 'an item at Draft');
    setDial(w, root, home, KEY, 'copilot');
    heldBy(give('item-copilot'), 'needs_owner', 'an item at Copilot');
    expect(files(), 'outbox files after Draft and Copilot').toEqual([]);

    // ---- 2. confirmed Autopilot queues one file and one event -----------------------------------
    const hash = confirm();
    const body = 'Probe post: free local Circles this week.';
    const r = give('item-1', channel, body);
    expect(r.outcome, 'an item at confirmed Autopilot').toBe('queued');
    expect(files(), 'outbox files after one hand-off').toEqual(['item-1.json']);
    const f = JSON.parse(readFileSync(join(outbox, 'item-1.json'), 'utf8'));
    expect(
      [f.flow, f.channel, f.body, f.confirm_hash, f.sha256],
      'the outbox file: flow, channel, body, confirm hash, sha256 of the body',
    ).toEqual([KEY, channel, body, hash, sha(body)]);
    const queued = async () => {
      const d = await openDbReadonly(home);
      const rows = d.prepare("SELECT payload FROM events WHERE type = 'notification.queued' ORDER BY seq").all() as {
        payload: string;
      }[];
      d.close();
      return rows.map((x) => JSON.parse(x.payload)).filter((p) => p.kind === 'flow_handoff');
    };
    let ev = await queued();
    expect(ev.length, 'flow_handoff events after one hand-off').toBe(1);
    expect(
      [ev[0].flow, ev[0].item_id, ev[0].channel, ev[0].sha256, typeof ev[0].dedupe_key],
      'the notification.queued event of kind flow_handoff',
    ).toEqual([KEY, 'item-1', channel, sha(body), 'string']);

    // ---- 3. the same item again queues nothing new -------------------------------------------------
    give('item-1', channel, body);
    expect(files().length, 'outbox files after handing off item-1 twice').toBe(1);
    expect((await queued()).length, 'flow_handoff events after handing off item-1 twice').toBe(1);

    // ---- 4. a channel the flow does not list ----------------------------------------------------------
    heldBy(give('item-2', 'probe_unlisted_channel'), 'unknown_channel', 'an item for a channel the flow does not list');

    // ---- 5. channels changed since the Owner confirmed ------------------------------------------------
    const over = join(home, 'flows', KEY);
    mkdirSync(over, { recursive: true });
    writeFileSync(
      join(over, 'config.json'),
      JSON.stringify({ ...cfg, channels: [...cfg.channels, { key: 'probe_channel', label: 'Probe', action_class: 'publish_external', placeholder: true }] }),
    );
    heldBy(give('item-3'), 'dial_unapproved', 'an item after the channels changed');
    confirm();
    expect(give('item-3').outcome, 'the same item after the Owner confirmed the new hash').toBe('queued');

    // ---- 6. a flow the Owner has not enabled ----------------------------------------------------------
    setFlowEnabled(w, root, KEY, false);
    heldBy(give('item-4'), 'flow_disabled', 'an item of a flow that is off');
    setFlowEnabled(w, root, KEY, true);

    // ---- 7. the kill switch -----------------------------------------------------------------------------
    (w as { transaction(fn: (tx: { run(sql: string, p: unknown[]): unknown }) => void): void }).transaction((tx) =>
      tx.run("UPDATE settings SET value = ?, updated_by = 'own_probe' WHERE key = 'kill_switch'", [
        JSON.stringify({ engaged: true, reason: 'probe' }),
      ]),
    );
    heldBy(give('item-5'), 'kill_switch', 'an item with the kill switch engaged');
    expect(files().sort(), 'outbox files at the end').toEqual(['item-1.json', 'item-3.json']);

    // ---- 8. nothing else was written: no run, no approval, no send ----------------------------------------
    store!.close();
    store = undefined;
    db = await openDbReadonly(home);
    const types = (db.prepare('SELECT DISTINCT type FROM events WHERE seq > ? ORDER BY type').all(seq0) as { type: string }[]).map(
      (x) => x.type,
    );
    const runs = Number((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n);
    const approvals = Number((db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number }).n);
    db.close();
    expect(types, 'event types written during the probe').toEqual(['notification.queued', 'system.config_changed']);
    expect([runs, approvals], 'runs and approvals written during the probe').toEqual([0, 0]);
    ev = await queued();
    expect(ev.map((e) => e.item_id), 'items queued, in order').toEqual(['item-1', 'item-3']);
  });
});
