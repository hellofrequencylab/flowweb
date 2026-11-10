// The prompt's rules never contradict a flow cycle's work order: a scratch folder (zero base commit)
// gets "commit nothing" and no diff cap; a checkout keeps the commit and diff rules.
import { expect, test } from 'vitest';
import { buildPrompt } from '../src/sdk/prompt.ts';
import { makeInput, makeWorktree } from './helpers.ts';

test('a scratch folder is told to commit nothing, with no diff cap', () => {
  const wt = makeWorktree();
  try {
    const input = makeInput(wt, (i) => {
      i.workspace.base_commit = '0'.repeat(40);
      i.work_order.constraints.max_diff_lines = 0;
    });
    const p = buildPrompt(input, []);
    expect(p).toContain('commit nothing');
    expect(p).not.toContain('Commit your work');
    expect(p).not.toMatch(/Keep the diff under/);
  } finally {
    wt.cleanup();
  }
});

test('a checkout keeps the commit and diff rules', () => {
  const wt = makeWorktree();
  try {
    const p = buildPrompt(makeInput(wt), []);
    expect(p).toContain('Commit your work on the current branch');
    expect(p).toMatch(/Keep the diff under \d+ lines/);
  } finally {
    wt.cleanup();
  }
});
