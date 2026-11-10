// WS-P1-024: fwd expires decision items whose deadline has passed, on its own timer.
import { createDecisionItem, listDecisionItems } from '@fw/ledger';
import { afterAll, expect, test } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { tempHome } from './api-fixtures.ts';

const home = tempHome();
let d: Daemon | undefined;

afterAll(async () => {
  await d?.stop('test done');
  home.cleanup();
});

test('a decision item past its deadline is expired by the daemon, and its default recorded', async () => {
  const lines: string[] = [];
  d = await startDaemon({
    fwHome: home.path,
    port: 0,
    log: (l) => lines.push(l),
    decisionExpiryIntervalMs: 50,
  });
  const item = createDecisionItem(d.writer, {
    variant: 'choose',
    ask: 'Pick the queue order for this week.',
    options: [
      { id: 'oldest', label: 'Oldest first', consequence: 'Stale rows close first.' },
      { id: 'smallest', label: 'Smallest first', consequence: 'More rows close sooner.' },
    ],
    recommended: 'smallest',
    recommendation_reason: 'Small rows unblock the most dependants.',
    default_on_timeout: 'smallest',
    deadline: new Date(Date.now() + 300),
  });
  expect(item.status).toBe('open');
  const deadline = Date.now() + 5000;
  let status: string = item.status;
  while (status !== 'expired' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    status = listDecisionItems(d.writer).find((i) => i.card_id === item.card_id)?.status ?? 'missing';
  }
  expect(status).toBe('expired');
  expect(lines.some((l) => /decisions: expired 1 item/.test(l))).toBe(true);
});
