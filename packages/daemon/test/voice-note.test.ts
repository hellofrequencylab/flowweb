// FW-C-167: the Owner's saved "How I write" note, the block briefs carry, and the draft edits kept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { REPO_ROOT } from '../src/daemon.ts';
import { OWNER_NOTE, VOICE_BRIEF } from '../src/flows/voice.ts';
import {
  DEFAULT_VOICE,
  EDITS_KEPT,
  keepEdit,
  listEdits,
  readVoice,
  saveVoice,
  voiceBlock,
} from '../src/flows/voice-note.ts';
import { brief } from '../src/overseer/cycle.ts';
import { editDraft } from '../src/overseer/drafts.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const home = () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return h.path;
};

test('with no note saved the Owner starts from the voice that shipped, and no block is added', () => {
  const h = home();
  expect(readVoice(h)).toEqual({ note: DEFAULT_VOICE, saved: false, updated_at: null, edits: 0 });
  expect(DEFAULT_VOICE).toContain(OWNER_NOTE);
  expect(DEFAULT_VOICE.length).toBeLessThanOrEqual(2000);
  expect(voiceBlock(h)).toBe('');
});

test('a saved note is read back, and an empty one goes back to the original', () => {
  const h = home();
  const v = saveVoice(h, { note: '  Short lines. Say thanks once.  ' });
  expect(v).toMatchObject({ note: 'Short lines. Say thanks once.', saved: true });
  expect(JSON.parse(readFileSync(join(h, 'voice.json'), 'utf8')).note).toBe('Short lines. Say thanks once.');
  expect(voiceBlock(h)).toContain('How the Owner writes, in his words: "Short lines. Say thanks once."');
  expect(saveVoice(h, { note: '' })).toMatchObject({ note: DEFAULT_VOICE, saved: false });
  expect(existsSync(join(h, 'voice.json'))).toBe(false);
});

test('a note with a long dash, the banned word, too many characters or no text is refused', () => {
  const h = home();
  for (const note of ['Warm — never stiff', 'Pages 3–4', 'Like Midnight oil', 'x'.repeat(2001), 5])
    expect(() => saveVoice(h, { note })).toThrow();
  expect(existsSync(join(h, 'voice.json'))).toBe(false);
});

test('the hunt brief carries the block after the shipped voice, with and without a playbook', () => {
  const hunt = { id: 'hnt_1' } as never;
  const block = 'How the Owner writes, in his words: "Short lines."';
  const plain = brief(KEY, {}, [hunt], [], false, undefined, [], null, block);
  expect(plain.indexOf(block)).toBeGreaterThan(plain.indexOf(VOICE_BRIEF));
  const pb = brief(KEY, {}, [hunt], [], false, undefined, [], { note: 'The copy note.' } as never, block);
  expect(pb.indexOf(block)).toBeGreaterThan(pb.indexOf('The copy note.'));
  expect(brief(KEY, {}, [hunt], [], false)).not.toContain('How the Owner writes');
  expect(brief(KEY, {}, [], ['host'], false, undefined, [], null, block)).not.toContain(block);
});

test('an edit that changes a waiting draft keeps one before and after pair; the newest 200 are kept', () => {
  const h = home();
  const dir = join(h, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id: string, status: string) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ flow: KEY, id, fire_id: 'f1', lead_id: id, subject: 'Hi', body: 'Before.', status }),
    );
  put('a', 'waiting_for_owner');
  put('b', 'approved');
  const o = { repoRoot: REPO_ROOT, fwHome: h, flow: KEY };
  editDraft({ ...o, id: 'a', subject: 'Only the subject' });
  editDraft({ ...o, id: 'a', body: 'Before.' });
  editDraft({ ...o, id: 'b', body: 'An approved draft, changed.' });
  expect(listEdits(h)).toEqual([]);
  editDraft({ ...o, id: 'a', body: 'After.' });
  expect(listEdits(h)).toMatchObject([{ flow: KEY, draft_id: 'a', before: 'Before.', after: 'After.' }]);
  expect(Object.keys(listEdits(h)[0] ?? {}).sort()).toEqual(['after', 'at', 'before', 'draft_id', 'flow']);
  for (let i = 0; i < EDITS_KEPT + 5; i++)
    keepEdit(h, { flow: KEY, draft_id: `d${i}`, before: 'x', after: `y${i}` });
  expect(readVoice(h).edits).toBe(EDITS_KEPT);
  expect(listEdits(h, 2).map((e) => e.draft_id)).toEqual([`d${EDITS_KEPT + 4}`, `d${EDITS_KEPT + 3}`]);
});
