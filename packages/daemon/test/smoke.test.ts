import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/daemon resolves', () => {
  expect(PACKAGE).toBe('@fw/daemon');
});
