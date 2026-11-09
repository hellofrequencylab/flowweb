import { expect, test } from 'vitest';
import { PACKAGE } from '../src/index.ts';

test('@fw/web resolves', () => {
  expect(PACKAGE).toBe('@fw/web');
});
