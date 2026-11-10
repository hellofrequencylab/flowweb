import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cleanRow, sign } from '../src/flows/outcomes.ts';

describe('cleanRow (FW-C-055)', () => {
  it('keeps only the tag and count fields', () => {
    const row = cleanRow({
      campaign: 'hnt_a',
      content: 'd-1',
      medium: 'email',
      src: 'hunt',
      leads: 2,
      members: 1,
      hosts: 0,
      paid: 0,
      email: 'x@example.com',
    });
    expect(row).toEqual({
      campaign: 'hnt_a',
      content: 'd-1',
      medium: 'email',
      src: 'hunt',
      leads: 2,
      members: 1,
      hosts: 0,
      paid: 0,
    });
  });
  it('drops a row with a count that is not a whole number of 0 or more', () => {
    expect(cleanRow({ campaign: 'a', leads: -1, members: 0, hosts: 0, paid: 0 })).toBeNull();
    expect(cleanRow({ campaign: 'a', leads: '2', members: 0, hosts: 0, paid: 0 })).toBeNull();
    expect(cleanRow(null)).toBeNull();
  });
});

describe('sign (FW-C-055)', () => {
  it("matches Frequency's check: hex HMAC-SHA256 of timestamp.body", () => {
    const want = createHmac('sha256', 's').update('1700000000.{}').digest('hex');
    expect(sign('s', '1700000000', '{}')).toBe(want);
  });
});
