import { describe, expect, it } from 'vitest';
import { draftTag, tagLinks } from '../src/overseer/drafts.ts';

describe('draftTag (FW-C-054)', () => {
  it("puts a draft id in Frequency's slug form", () => {
    expect(draftTag('hnt_ab12-CD34ef')).toBe('hnt_ab12-cd34ef');
    expect(draftTag('fire.1:d/2')).toBe('fire-1-d-2');
    expect(draftTag('x'.repeat(80))).toHaveLength(48);
  });
});

describe('tagLinks (FW-C-054)', () => {
  it('adds utm_content to flowweb links only, keeping trailing punctuation', () => {
    const text = [
      'Start here: https://frequencylocal.com/start/host?utm_source=flowweb&utm_campaign=hnt_1.',
      'Our site: https://frequencylocal.com/about',
      'Claim: {{claim_url}}',
    ].join('\n');
    const out = tagLinks(text, 'hnt_1-abc');
    expect(out).toContain('utm_campaign=hnt_1&utm_content=hnt_1-abc.');
    expect(out).toContain('https://frequencylocal.com/about\n');
    expect(out).toContain('{{claim_url}}');
  });
  it('replaces an earlier tag instead of adding a second', () => {
    const once = tagLinks('https://x.test/?utm_source=flowweb&utm_content=old', 'new');
    expect(once).toBe('https://x.test/?utm_source=flowweb&utm_content=new');
  });
});
