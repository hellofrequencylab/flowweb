// Probe c1/decision-model (WS-P1-024; backlog verify_probe kernel/decision-model).
// Surfaces: the decision item functions exported by packages/ledger/src/index.ts, called with the
// Writer of the Store port (openStore from packages/eventlog/src/index.ts, opened the way fwd opens
// it: $FW_HOME/db/fw.sqlite, writer lock $FW_HOME/fwd.lock); the decision_cards table and the
// decision_card.* events of schema.core.sql, read with node:sqlite read-only; and @fw/contracts
// `validate` to check every stored card body against contracts-core/json-schema/decision-card.json.
// A decision item is a decision card (the row's core_adaptation: "Backed by decision_cards").
// The exports this probe expects (no spec names them; see probes/c1/README.md, "Decisions"):
//   DECISION_VARIANTS: the closed list of item types, the decision-card.json `variant` enum
//   createDecisionItem(w, { project?, stream?, variant, title?, ask, urgency?, deadline?,
//     default_on_timeout, options?, recommended?, recommendation_reason?, source?,
//     evidence_bundle_id?, ...the variant's own decision-card.json fields })
//     -> { card_id, ... }; one decision_cards row (status open) and one decision_card.created event
//   listDecisionItems(r, { project?, stream?, status? }) -> [{ card_id, variant, status, ... }]
//   expireDecisionItems(w) -> [{ card_id, default_applied }]: every open or snoozed card past its
//     deadline becomes expired with its default applied, one decision_card.expired each
// Acceptance (WS-P1-024):
//   1. an item without a default action is rejected (no row, no event)
//   2. an expired item applies its default (deny) and logs it: an approve card past its deadline is
//      expired with default_applied "deny", its pending approval is no longer approvable, and one
//      decision_card.expired event records it; a second sweep changes nothing
//   3. types are a closed union: exactly the five decision-card.json variants; any other is refused
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { count, dbPath, fixtureProject, freshHome, fw, openDbReadonly, requireExport, root, sha256, sleep } from '../c0/_lib.mjs';

type Fn = (...a: unknown[]) => unknown;
type Item = { card_id: string; variant?: string; status?: string; default_applied?: string };

const ROW = 'WS-P1-024';
const VARIANTS = ['answer', 'approve', 'choose', 'review', 'unblock'];

let home = '';
let projectId = '';
let streamId = '';
let agentId = '';
let api: { create: Fn; list: Fn; expire: Fn; variants: unknown };

async function withWriter<T>(fn: (w: { run: Fn }) => T): Promise<T> {
  const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);
  const store = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  try {
    return await fn(store.writer);
  } finally {
    store.close();
  }
}

async function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const db = await openDbReadonly(home);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function counts() {
  const db = await openDbReadonly(home);
  try {
    return {
      cards: count(db, 'SELECT count(*) FROM decision_cards'),
      created: count(db, "SELECT count(*) FROM events WHERE type = 'decision_card.created'"),
    };
  } finally {
    db.close();
  }
}

async function contractErrors(body: unknown): Promise<string[]> {
  const { validate } = await import(pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href);
  return validate('decision-card', body).errors.map((e: { path: string; message: string }) => `${e.path} ${e.message}`);
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** One input per variant other than approve (which needs a recorded approval; see line 2). */
function items(): Record<string, Record<string, unknown>> {
  return {
    choose: {
      variant: 'choose',
      ask: 'Pick the queue order for this week.',
      options: [
        { id: 'oldest_first', label: 'Oldest first', consequence: 'Stale rows close first.' },
        { id: 'smallest_first', label: 'Smallest first', consequence: 'More rows close sooner.' },
      ],
      recommended: 'smallest_first',
      recommendation_reason: 'Small rows unblock the most dependants.',
      default_on_timeout: 'smallest_first',
    },
    answer: {
      variant: 'answer',
      ask: 'Give the weekly spend cap in dollars.',
      question: 'What is the weekly spend cap?',
      answer_type: 'number',
      default_on_timeout: 'keep the current cap',
    },
    review: {
      variant: 'review',
      ask: 'Accept the probe draft as written.',
      artifact: { kind: 'file', ref: 'probes/c1/README.md' },
      rubric: ['matches the acceptance lines'],
      verdicts: ['accept', 'reject'],
      default_on_timeout: 'leave it unreviewed',
    },
    unblock: {
      variant: 'unblock',
      ask: 'Grant read access to the docs repo.',
      blocker: { kind: 'missing_access', description: 'No read access to the docs repo.', since: inMs(-60000) },
      suggested_actions: [{ id: 'grant', label: 'Grant read access' }],
      default_on_timeout: 'stay blocked',
    },
  };
}

function refusal(fn: () => unknown): { refused: boolean; message: string } {
  try {
    fn();
    return { refused: false, message: '' };
  } catch (e) {
    return { refused: true, message: `${(e as { code?: string }).code ?? ''} ${(e as Error).message}` };
  }
}

describe('c1/decision-model', () => {
  beforeAll(async () => {
    const proj = fixtureProject({ rowId: 'FW-C-969' });
    home = freshHome('c1-decision');
    const sync = fw(['ledger', 'sync', '--json'], { home, cwd: proj.work });
    expect(sync.status, 'fw ledger sync failed on the fixture project').toBe(0);
    const [p] = await query<{ id: string }>('SELECT id FROM projects ORDER BY created_at LIMIT 1');
    const [s] = await query<{ id: string }>('SELECT id FROM streams WHERE project_id = ? LIMIT 1', p?.id);
    const [a] = await query<{ id: string }>("SELECT id FROM agents WHERE status = 'active' ORDER BY id LIMIT 1");
    expect(p && s && a, 'fw ledger sync did not create a project, a stream and an agent').toBeTruthy();
    projectId = p!.id;
    streamId = s!.id;
    agentId = a!.id;
    api = {
      create: (await requireExport('ledger', 'createDecisionItem', ROW)) as Fn,
      list: (await requireExport('ledger', 'listDecisionItems', ROW)) as Fn,
      expire: (await requireExport('ledger', 'expireDecisionItems', ROW)) as Fn,
      variants: await requireExport('ledger', 'DECISION_VARIANTS', ROW),
    };
  });

  test('line 3: item types are a closed union of the five decision-card variants', async () => {
    expect(Array.isArray(api.variants), 'DECISION_VARIANTS is not an array').toBe(true);
    expect([...(api.variants as string[])].sort(), 'DECISION_VARIANTS differs from the decision-card.json variant enum').toEqual(VARIANTS);
    const before = await counts();
    for (const variant of ['poll', 'approve_deny', 'APPROVE', '']) {
      const r = await withWriter((w) => refusal(() => api.create(w, { ...items().choose, variant, project: projectId })));
      expect(r.refused, `variant "${variant}" was accepted`).toBe(true);
    }
    expect(await counts(), 'a refused variant wrote a card or an event').toEqual(before);
  });

  test('line 1: an item without a default action is rejected; with one it is stored and logged', async () => {
    const before = await counts();
    for (const [variant, input] of Object.entries(items())) {
      for (const dflt of [undefined, '', '  ']) {
        const bad: Record<string, unknown> = { ...input, project: projectId };
        if (dflt === undefined) delete bad.default_on_timeout;
        else bad.default_on_timeout = dflt;
        const r = await withWriter((w) => refusal(() => api.create(w, bad)));
        expect(r.refused, `a ${variant} item with default_on_timeout ${JSON.stringify(dflt)} was accepted`).toBe(true);
        expect(r.message, `the ${variant} refusal does not name the default action: ${r.message}`).toMatch(/default/i);
      }
    }
    expect(await counts(), 'a refused item wrote a card or an event').toEqual(before);

    const made: Record<string, string> = {};
    for (const [variant, input] of Object.entries(items())) {
      const extra = variant === 'choose' ? { stream: streamId } : {};
      const out = (await withWriter((w) => api.create(w, { ...input, ...extra, project: projectId, deadline: inMs(3600000) }))) as Item;
      expect(out?.card_id, `no card_id for the ${variant} item`).toMatch(/^dcd_/);
      made[variant] = out.card_id;
    }
    const rows = await query<{ id: string; variant: string; status: string; project_id: string; default_on_timeout: string; deadline_at: string; body: string }>(
      'SELECT id, variant, status, project_id, default_on_timeout, deadline_at, body FROM decision_cards',
    );
    for (const [variant, id] of Object.entries(made)) {
      const row = rows.find((r) => r.id === id);
      expect(row, `no decision_cards row for the ${variant} item`).toBeTruthy();
      expect(row!.variant).toBe(variant);
      expect(row!.status).toBe('open');
      expect(row!.project_id).toBe(projectId);
      expect(row!.default_on_timeout).toBe(items()[variant]!.default_on_timeout);
      expect(row!.deadline_at, `the ${variant} card has no deadline_at`).toBeTruthy();
      expect(await contractErrors(JSON.parse(row!.body)), `the stored ${variant} body is not a valid decision card`).toEqual([]);
      const ev = await query<{ payload: string; project_id: string; stream_id: string | null }>(
        "SELECT payload, project_id, stream_id FROM events WHERE type = 'decision_card.created' AND json_extract(payload, '$.card_id') = ?",
        id,
      );
      expect(ev.length, `${ev.length} decision_card.created events for the ${variant} item, want 1`).toBe(1);
      const payload = JSON.parse(ev[0]!.payload);
      expect(payload.variant).toBe(variant);
      expect(payload.default_on_timeout).toBe(row!.default_on_timeout);
      expect(ev[0]!.project_id).toBe(projectId);
      expect(ev[0]!.stream_id).toBe(variant === 'choose' ? streamId : null);
    }
    expect(JSON.parse(rows.find((r) => r.id === made.choose)!.body).recommended_option).toBe('smallest_first');

    const ids = (xs: unknown) => (xs as Item[]).map((x) => x.card_id).sort();
    const listed = await withWriter((w) => ({
      project: ids(api.list(w, { project: projectId })),
      stream: ids(api.list(w, { stream: streamId })),
      open: ids(api.list(w, { status: 'open' })),
    }));
    expect(listed.project, 'listDecisionItems({ project }) does not list the project items').toEqual(Object.values(made).sort());
    expect(listed.stream, 'listDecisionItems({ stream }) does not list only the stream item').toEqual([made.choose]);
    expect(listed.open).toEqual(Object.values(made).sort());
  });

  test('line 2: an expired item applies its default (deny) and logs it', async () => {
    // An approve card needs a pending approval with evidence (decision_cards.approval_id is a
    // foreign key, and no surface records approvals yet), so the probe writes those two rows.
    const evb = `evb_probe${Date.now()}`;
    const apr = `apr_probe${Date.now()}`;
    const hash = sha256(`probe payload ${apr}`);
    await withWriter((w) => {
      w.run(
        "INSERT INTO evidence_bundles(id, subject_kind, subject_ref, body, bundle_hash, captured_by) VALUES (?, 'probe', 'decision-model', '{}', ?, 'kernel')",
        [evb, sha256(evb)],
      );
      w.run(
        `INSERT INTO approvals(id, action_class, environment, tier, subject_kind, subject_ref, payload_hash, evidence_bundle_id,
           requester_agent_id, request, expires_at) VALUES (?, 'code_write_sandbox', 'sandbox', 'L1', 'probe', 'decision-model', ?, ?, ?, '{}', ?)`,
        [apr, hash, evb, agentId, inMs(3600000)],
      );
    });
    const approve = {
      variant: 'approve',
      project: projectId,
      ask: 'Approve writing the fixture note.',
      approval_id: apr,
      evidence_bundle_id: evb,
      headline: 'A note is written in the sandbox.',
      payload_preview: { format: 'text', excerpt: 'fixture note', full_ref: 'fw-fake/note.md', payload_hash: hash },
      risk: { blast_radius: 'one sandbox file', reversible: true, scan_status: 'green' },
    };
    for (const dflt of [undefined, 'approve', 'allow']) {
      const bad: Record<string, unknown> = { ...approve, deadline: inMs(1500) };
      if (dflt !== undefined) bad.default_on_timeout = dflt;
      const r = await withWriter((w) => refusal(() => api.create(w, bad)));
      expect(r.refused, `an approve item with default_on_timeout ${JSON.stringify(dflt)} was accepted (its default is always deny)`).toBe(true);
    }
    const card = ((await withWriter((w) => api.create(w, { ...approve, default_on_timeout: 'deny', deadline: inMs(1500) }))) as Item).card_id;
    const choose = ((await withWriter((w) => api.create(w, { ...items().choose, project: projectId, deadline: inMs(1500) }))) as Item).card_id;
    const later = ((await withWriter((w) => api.create(w, { ...items().answer, project: projectId, deadline: inMs(3600000) }))) as Item).card_id;
    const early = (await withWriter((w) => api.expire(w))) as Item[];
    expect(early.map((x) => x.card_id), 'a card was expired before its deadline').not.toContain(card);

    await sleep(2500);
    const swept = (await withWriter((w) => api.expire(w))) as Item[];
    const byId = Object.fromEntries(swept.map((x) => [x.card_id, x]));
    expect(byId[card]?.default_applied, 'the approve card was not expired with default_applied deny').toBe('deny');
    expect(byId[choose]?.default_applied, 'the choose card was not expired with its own default').toBe('smallest_first');
    expect(byId[later], 'a card with a future deadline was expired').toBeUndefined();

    const status = async (id: string) => (await query<{ status: string }>('SELECT status FROM decision_cards WHERE id = ?', id))[0]?.status;
    expect(await status(card)).toBe('expired');
    expect(await status(choose)).toBe('expired');
    expect(await status(later)).toBe('open');
    const [ap] = await query<{ status: string }>('SELECT status FROM approvals WHERE id = ?', apr);
    expect(['expired', 'denied'], `the approval behind the expired approve card is ${ap?.status}, want expired or denied`).toContain(ap?.status);
    const ev = await query<{ payload: string; actor_kind: string }>(
      "SELECT payload, actor_kind FROM events WHERE type = 'decision_card.expired' AND json_extract(payload, '$.card_id') = ?",
      card,
    );
    expect(ev.length, `${ev.length} decision_card.expired events for the approve card, want 1`).toBe(1);
    expect(JSON.parse(ev[0]!.payload).default_applied).toBe('deny');
    expect(ev[0]!.actor_kind, 'the expiry was not logged as a system action').toBe('system');

    const total = async () =>
      (await query<{ n: number }>("SELECT count(*) AS n FROM events WHERE type IN ('decision_card.expired', 'approval.expired')"))[0]!.n;
    const n = await total();
    const again = (await withWriter((w) => api.expire(w))) as Item[];
    expect(again, 'a second sweep expired cards again').toEqual([]);
    expect(await total(), 'a second sweep wrote expiry events again').toBe(n);
    const expired = (await withWriter((w) => api.list(w, { status: 'expired' }))) as Item[];
    expect(expired.map((x) => x.card_id).sort()).toEqual([card, choose].sort());
  });
});
