import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/cli resolves', () => {
  expect(PACKAGE).toBe('@fw/cli');
});
