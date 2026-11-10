import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dimensionsOf, isoWeek, reviewSummary } from '../src/flows/review-summary.ts';

const sent = (over: Record<string, unknown>) => ({ sent_at: '2026-11-02T00:00:00Z', ...over });

describe('FW-C-072 review summary', () => {
  it('scores sent drafts by source host, hunt, funnel, one-area sub-area and angle', () => {
    const hunts = [{ id: 'h1', name: 'Sound baths', areas: ['leucadia'] }];
    const drafts = [
      sent({
        hunt_id: 'h1',
        tag: 't1',
        source_url: 'https://www.eventbrite.com/e/1',
        build: false,
        replied_at: 'x',
      }),
      sent({ lead_id: 'template:host', tag: 't2', angle: 'their-event' }),
      { hunt_id: 'h1', tag: 't3' }, // never sent: not counted
    ];
    const b = dimensionsOf(hunts, drafts, [{ content: 't2', members: 1, hosts: 0 }]);
    expect(b.totals).toMatchObject({ sent: 2, replied: 1, signups: 1, reply_rate: 0.5 });
    expect(b.by.source.map((c) => c.name)).toEqual(['eventbrite.com']);
    expect(b.by.hunt[0]).toMatchObject({ value: 'h1', name: 'Sound baths', sent: 1, replied: 1 });
    expect(b.by.funnel.map((c) => c.name).sort()).toEqual(['host', 'host funnel']);
    expect(b.by.sub_area[0]?.name).toBe('leucadia');
    expect(b.by.angle[0]).toMatchObject({ name: 'their-event', signups: 1 });
  });

  it('names the ISO week, and answers none, then a summary without a breakdown as thin', () => {
    expect(isoWeek('2026-11-10T17:00:00Z')).toBe('2026-W46');
    expect(isoWeek('2027-01-01T00:00:00Z')).toBe('2026-W53');
    const home = mkdtempSync(join(tmpdir(), 'fw-sum-'));
    expect(reviewSummary(home, 'f').state).toBe('none');
    mkdirSync(join(home, 'flows', 'f'), { recursive: true });
    writeFileSync(
      join(home, 'flows', 'f', 'review.json'),
      JSON.stringify({ at: '2026-11-09T00:00:00Z', scorecard: { hunts: [] } }),
    );
    const s = reviewSummary(home, 'f');
    expect(s).toMatchObject({ state: 'thin', sample_ok: false, week: '2026-W46' });
    expect(s.dimensions.every((d) => !d.tracked)).toBe(true);
  });
});
