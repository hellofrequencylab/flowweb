import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/policy resolves', () => {
  expect(PACKAGE).toBe('@fw/policy');
});
