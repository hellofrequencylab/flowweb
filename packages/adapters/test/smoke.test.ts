import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/adapters resolves', () => {
  expect(PACKAGE).toBe('@fw/adapters');
});
