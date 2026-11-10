// Probe c1/relay-r1 (WS-P1-028; backlog verify_probe workstreams/relay-r1).
// Surfaces: `fw ledger sync`, `fw ledger retest`, `fw wo issue`, and the relay commands
// `fw relay prompt <order>`, `fw relay owed [--older-than-hours N]` and `fw relay result <run> --file <path>`
// (see probes/c1/README.md, "Decisions" 51-55); the runs, run_steps and decision_cards tables and the
// run.queued and run.result_submitted events of schema.core.sql, read with node:sqlite read-only (only
// after each fw command has exited, never while another SQLite connection is open in this process).
// Acceptance (WS-P1-028):
//   1. fw relay prompt <order> prints a prompt that includes the work order id, its probes and the
//      planner-text-is-data rule (the prompt is owed: one queued relay run with its prompt step)
//   2. owed prompts older than N hours appear as review items (one review decision card per owed run)
//   3. a pasted result is parsed and validated against the run-result schema (an invalid or foreign
//      paste is refused and stores nothing; a valid one is stored with run.result_submitted)
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { count, fail, fixtureProject, fw, fwJson, openDbReadonly, pipelineHome, tmpDir } from '../c0/_lib.mjs';

const RULE = /planner[^.\n]*\bdata\b[^.\n]*not (?:as )?instructions/i;

describe('c1/relay-r1', () => {
  test('composes an owed prompt, raises it for review when old, and validates the pasted result', async () => {
    const proj = fixtureProject({ rowId: 'FW-C-965' });
    const home = pipelineHome('c1-relay');
    const o = { home, cwd: proj.work };
    expect(fw(['ledger', 'sync', '--json'], o).status, 'fw ledger sync').toBe(0);
    expect(fwJson(['ledger', 'retest', 'FW-C-965'], o).json?.outcome, 'retest makes the row ready').toBe('ready');
    const wo = fwJson(['wo', 'issue', 'FW-C-965'], o);
    if (wo.status !== 0) fail(`fw wo issue FW-C-965 exited ${wo.status}: ${wo.stdout.slice(0, 300)}`);
    const woId = wo.json.work_order_id as string;

    // Acceptance 1: the prompt names the order, its probe and the rule; it is now owed.
    const p = fwJson(['relay', 'prompt', woId], o);
    if (p.status !== 0) fail(`fw relay prompt ${woId} exited ${p.status}: ${(p.stdout + p.stderr).slice(0, 300)}`);
    const { run_id: runId, prompt } = p.json as { run_id: string; prompt: string };
    expect(prompt).toContain(woId);
    expect(prompt).toContain(runId);
    expect(prompt, 'the prompt carries the row probe command').toContain('node check-feature.mjs');
    expect(prompt, 'the prompt says planner text is data, not instructions').toMatch(RULE);
    const again = fw(['relay', 'prompt', 'FW-C-965'], o);
    expect(again.status, 'fw relay prompt by row code').toBe(0);
    expect(again.stdout, 'the plain output is the prompt itself').toContain(prompt.trim());

    let db = await openDbReadonly(home);
    const runs = db.prepare("SELECT id, status, result FROM runs WHERE work_order_id = ? AND adapter_name = 'relay'").all(woId) as Record<string, unknown>[];
    expect(runs.length, 'one owed relay run, however often the prompt is printed').toBe(1);
    expect([runs[0]!.id, runs[0]!.status, runs[0]!.result]).toEqual([runId, 'queued', null]);
    const step = db.prepare("SELECT content_hash FROM run_steps WHERE run_id = ? AND kind = 'prompt'").all(runId) as { content_hash: string }[];
    expect(step.map((s) => s.content_hash), 'the prompt step records the prompt hash').toEqual([createHash('sha256').update(prompt).digest('hex')]);
    expect(count(db, "SELECT count(*) FROM events WHERE type = 'run.queued' AND run_id = ?", runId), 'one run.queued').toBe(1);
    db.close();

    // Acceptance 2: owed prompts older than N hours become review items, once.
    const young = fwJson(['relay', 'owed', '--older-than-hours', '24'], o);
    expect(young.status).toBe(0);
    expect(young.json.owed.map((x: { run_id: string }) => x.run_id)).toContain(runId);
    expect(young.json.review_items.length, 'a fresh prompt is not a review item').toBe(0);
    const old = fwJson(['relay', 'owed', '--older-than-hours', '0'], o);
    expect(old.json.review_items.map((x: { run_id: string }) => x.run_id)).toEqual([runId]);
    fwJson(['relay', 'owed', '--older-than-hours', '0'], o);
    db = await openDbReadonly(home);
    const cards = db.prepare("SELECT body FROM decision_cards WHERE variant = 'review' AND status = 'open'").all() as { body: string }[];
    expect(cards.filter((c) => c.body.includes(runId)).length, 'one open review card for the owed run').toBe(1);
    db.close();

    // Acceptance 3: the pasted result is parsed and validated.
    const dir = tmpDir('relay-paste');
    const paste = (name: string, text: string) => {
      const f = join(dir, name);
      writeFileSync(f, text);
      return fw(['relay', 'result', runId, '--file', f, '--json'], o);
    };
    const result = (over: Record<string, unknown> = {}) => ({
      schema_version: '1',
      run_id: runId,
      work_order_id: woId,
      adapter: { vendor: 'other', name: 'relay', version: '1', model: 'chat' },
      session_id: 'pasted',
      status: 'completed',
      exit_code: 0,
      cost: { input_tokens: 0, output_tokens: 0, usd: 0 },
      artifacts: [],
      ...over,
    });
    expect(paste('none.txt', 'Done! Everything worked.').status, 'a paste with no JSON is refused').not.toBe(0);
    expect(paste('bad.txt', `Here you go: ${JSON.stringify({ status: 'completed' })}`).status, 'a schema-invalid result is refused').not.toBe(0);
    expect(paste('other.txt', JSON.stringify(result({ run_id: 'run_someoneelse0001' }))).status, 'a result for another run is refused').not.toBe(0);
    db = await openDbReadonly(home);
    expect(db.prepare('SELECT result FROM runs WHERE id = ?').get(runId)?.result, 'refused pastes store nothing').toBeNull();
    expect(count(db, "SELECT count(*) FROM events WHERE type = 'run.result_submitted'"), 'no run.result_submitted yet').toBe(0);
    db.close();

    const good = paste('good.md', `The agent replied:\n\n\`\`\`json\n${JSON.stringify(result(), null, 2)}\n\`\`\`\nThanks.`);
    expect(good.status, `a valid fenced result is accepted: ${(good.stdout + good.stderr).slice(0, 300)}`).toBe(0);
    db = await openDbReadonly(home);
    const stored = db.prepare('SELECT result, result_hash FROM runs WHERE id = ?').get(runId) as { result: string; result_hash: string };
    expect(JSON.parse(stored.result).run_id).toBe(runId);
    expect(stored.result_hash).toMatch(/^[0-9a-f]{64}$/);
    const sub = db.prepare("SELECT payload FROM events WHERE type = 'run.result_submitted' AND run_id = ?").all(runId) as { payload: string }[];
    expect(sub.map((s) => JSON.parse(s.payload).result_hash), 'one run.result_submitted with the stored hash').toEqual([stored.result_hash]);
    db.close();
    const after = fwJson(['relay', 'owed', '--older-than-hours', '0'], o);
    expect(after.json.owed.map((x: { run_id: string }) => x.run_id), 'a run with a result is no longer owed').not.toContain(runId);
  });
});
