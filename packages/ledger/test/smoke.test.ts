import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/ledger resolves', () => {
  expect(PACKAGE).toBe('@fw/ledger');
});
