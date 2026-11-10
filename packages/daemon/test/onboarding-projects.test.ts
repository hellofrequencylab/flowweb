// FW-C-039: projects with no repository, the Owner's brief, and project writes through fwd while it
// holds the writer. The kernel functions run on a writer; the routes run on a real fwd (auth off).
import { addProject, briefProject, getBrief, PROJECT_BRIEFS_KEY } from '@fw/ledger';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.ts';
import { call, seed, tempHome, withWriter } from './api-fixtures.ts';

const ANSWERS = {
  what: 'Neighborhood events that get people into rooms together.',
  who: 'Hosts who already run small gatherings.',
  voice: 'Plain words, no hype.',
  never: 'Never send anything without my OK.',
  done: 'Ten hosts have a first event on the calendar.',
};

describe('project add and brief on a writer', () => {
  const home = tempHome();
  beforeAll(() => seed(home.path));
  afterAll(() => home.cleanup());

  test('adds a project with no repository, labelled, and refuses a slug that is taken', () => {
    withWriter(home.path, (w) => {
      const r = addProject(w, {
        slug: 'launch',
        name: ' Launch  campaign ',
        brand: 'Frequency',
        category: 'Marketing',
      });
      expect(r.project).toMatchObject({
        slug: 'launch',
        name: 'Launch campaign',
        kind: 'other',
        repo_url: null,
        brand: 'Frequency',
        category: 'marketing',
      });
      expect(() => addProject(w, { slug: 'launch' })).toThrow(
        expect.objectContaining({ code: 'ALREADY_EXISTS' }),
      );
      expect(() => addProject(w, { slug: 'Bad Slug' })).toThrow(
        expect.objectContaining({ code: 'BAD_ARGUMENT' }),
      );
      expect(() => addProject(w, { slug: 'ok', kind: 'castle' })).toThrow(
        expect.objectContaining({ code: 'BAD_ARGUMENT' }),
      );
    });
  });

  test('a brief is all five answers, trimmed and otherwise word for word, or nothing', () => {
    withWriter(home.path, (w) => {
      expect(() => briefProject(w, 'launch', { ...ANSWERS, voice: '  ' })).toThrow(
        expect.objectContaining({ code: 'BAD_ARGUMENT' }),
      );
      const { done: _d, ...four } = ANSWERS;
      expect(() => briefProject(w, 'launch', four)).toThrow(
        expect.objectContaining({ code: 'BAD_ARGUMENT' }),
      );
      expect(w.get('SELECT 1 FROM settings WHERE key = ?', [PROJECT_BRIEFS_KEY])).toBeUndefined();
      expect(getBrief(w, 'launch').brief).toBeNull();

      const saved = briefProject(w, 'launch', { ...ANSWERS, what: `  ${ANSWERS.what}\n` });
      expect(saved.event_seq).not.toBeNull();
      expect(getBrief(w, 'launch').brief).toMatchObject(ANSWERS);
      // The same answers again change nothing and write no event.
      expect(briefProject(w, 'launch', ANSWERS).event_seq).toBeNull();
    });
  });
});

describe('project routes on fwd', () => {
  const home = tempHome();
  let d: Daemon;
  beforeAll(async () => {
    seed(home.path);
    d = await startDaemon({ fwHome: home.path, port: 0, devNoAuth: true, log: () => {} });
  });
  afterAll(async () => {
    await d?.stop('test done');
    home.cleanup();
  });
  const post = (path: string, body: unknown) => call(d.port, 'POST', `/v1${path}`, { body });

  test('add, label and brief are written by fwd', async () => {
    let r = await post('/projects', { slug: 'inbox', name: 'Support inbox', kind: 'inbox' });
    expect(r.status).toBe(200);
    expect(r.json.data.project).toMatchObject({ slug: 'inbox', kind: 'inbox', repo_url: null });
    r = await post('/projects', { slug: 'inbox' });
    expect(r.status).toBe(409);
    r = await post('/projects/inbox/labels', { brand: 'Frequency', category: 'support' });
    expect(r.status).toBe(200);
    expect(r.json.data.project).toMatchObject({ brand: 'Frequency', category: 'support' });
    r = await post('/projects/inbox/brief', { ...ANSWERS, never: '' });
    expect(r.status).toBe(400);
    r = await post('/projects/inbox/brief', ANSWERS);
    expect(r.status).toBe(200);
    expect(r.json.data.brief).toMatchObject(ANSWERS);
    r = await post('/projects/nope/brief', ANSWERS);
    expect(r.status).toBe(404);
  });
});
