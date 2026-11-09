import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/eventlog resolves', () => {
  expect(PACKAGE).toBe('@fw/eventlog');
});
