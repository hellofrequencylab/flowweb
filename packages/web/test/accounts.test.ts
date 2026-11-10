import { describe, expect, it } from 'vitest';
import { accountSpec } from '../src/hosted/Machines';

describe('the account badge on Settings', () => {
  it('shows the last real test call when there is one', () => {
    expect(accountSpec(true, true).word).toBe('Works');
    expect(accountSpec(true, false)).toMatchObject({ word: 'Test failed', tone: 'fail' });
  });

  it('falls back to set up or not, and not set up beats an old passing test', () => {
    expect(accountSpec(true, undefined).word).toBe('Set up');
    expect(accountSpec(false, true).word).toBe('Not set up');
    expect(accountSpec(null, undefined).word).toBe("Mac can't tell");
    expect(accountSpec(undefined, undefined).word).toBe('Not reported yet');
  });
});
