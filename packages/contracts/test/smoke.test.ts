import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/contracts resolves', () => {
  expect(PACKAGE).toBe('@fw/contracts');
});
