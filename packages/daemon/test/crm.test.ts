import { describe, expect, it } from 'vitest';
import { crmPayload, leadEmail, needsSync } from '../src/flows/crm.ts';

const draft = (extra: Record<string, unknown> = {}) => ({
  flow: 'neighborhood-activation',
  id: 'hnt_a-111',
  hunt_id: 'hnt_a',
  to: 'Hello@FrontPorch.example',
  name: 'Front Porch Gallery',
  source_url: 'https://frontporch.example/events',
  region: 'north-county-sd',
  subject: 'Hi',
  body: 'Hello there.',
  tag: 'hnt_a-111',
  status: 'waiting_for_owner',
  created_at: '2026-11-10T08:00:00.000Z',
  ...extra,
});

describe('crm payload', () => {
  it('posts an email lead with its marks and the hunt name', () => {
    const p = crmPayload(draft({ sent_at: '2026-11-10T09:00:00.000Z' }), 'North County events');
    expect(p).toMatchObject({
      lead: { email: 'hello@frontporch.example', hunt: 'North County events', region: 'north-county-sd' },
      draft: { tag: 'hnt_a-111', sent_at: '2026-11-10T09:00:00.000Z', replied_at: null },
    });
  });
  it('skips form leads, untagged drafts and drafts rejected unsent', () => {
    expect(leadEmail(draft({ to: null }))).toBeNull();
    expect(crmPayload(draft({ to: null, contact_url: 'https://x.example' }), null)).toBeNull();
    expect(crmPayload(draft({ tag: undefined }), null)).toBeNull();
    expect(crmPayload(draft({ status: 'rejected' }), null)).toBeNull();
    expect(
      crmPayload(draft({ status: 'rejected', sent_at: '2026-11-10T09:00:00.000Z' }), null),
    ).not.toBeNull();
  });
});

describe('needsSync', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  const synced = (extra: Record<string, unknown> = {}) =>
    draft({
      crm: { status: 'synced', at: '2026-11-10T11:00:00.000Z', marks: '||', lead_status: 'open', ...extra },
    });
  it('posts a new draft, a failed one and one whose marks changed', () => {
    expect(needsSync(draft(), now)).toBe(true);
    expect(needsSync(draft({ crm: { status: 'failed', at: now.toISOString() } }), now)).toBe(true);
    expect(needsSync({ ...synced(), sent_at: '2026-11-10T11:30:00.000Z' }, now)).toBe(true);
  });
  it('leaves an unchanged draft alone for a day, and a closed lead for good', () => {
    expect(needsSync(synced(), now)).toBe(false);
    expect(needsSync(synced({ at: '2026-11-09T10:00:00.000Z' }), now)).toBe(true);
    expect(needsSync(synced({ at: '2026-11-01T10:00:00.000Z', lead_status: 'closed' }), now)).toBe(false);
  });
});
