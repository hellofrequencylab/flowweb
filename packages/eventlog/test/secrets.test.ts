// Redaction before write, and the trg_events_no_secret_shapes tripwire behind it.
// Every token below is a fake, built from repeated letters; none is a real credential.
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  canonicalJson,
  ForbiddenStatementError,
  GENESIS_HASH,
  hasSecretShape,
  openStore,
  REDACTED,
  REDACTION_KEY,
  redactSecrets,
  SecretShapeError,
  sha256Hex,
} from '../src/index.ts';
import { ev, seededDb, tempDir } from './helpers.ts';

const dir = tempDir();
const x = (n: number) => 'x'.repeat(n);
const FAKES = {
  skAnt: `sk-ant-api03-${x(20)}`,
  skProj: `sk-proj-${x(20)}`,
  ghp: `ghp_${x(36)}`,
  githubPat: `github_pat_${x(22)}`,
  aws: 'AKIAABCDEFGHIJKLMNOP',
  slackBot: `xoxb-${x(12)}`,
  slackUser: `xoxp-${x(12)}`,
  pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${x(40)}\n-----END OPENSSH PRIVATE KEY-----`,
  pkcs8: `-----BEGIN PRIVATE KEY-----\n${x(40)}\n-----END PRIVATE KEY-----`,
};

describe('redactSecrets', () => {
  test('replaces every trigger shape, in nested strings and keys, and reports the paths', () => {
    const input = {
      top: `token ${FAKES.skAnt} end`,
      list: [FAKES.ghp, 'plain', { deep: FAKES.aws }],
      [FAKES.slackBot]: 'key was secret',
      n: 7,
    };
    const { value, paths } = redactSecrets(input);
    expect(value.top).toBe(`token ${REDACTED} end`);
    expect(value.list).toEqual([REDACTED, 'plain', { deep: REDACTED }]);
    expect(value).toHaveProperty(REDACTED, 'key was secret');
    expect(paths.sort()).toEqual(['/list/0', '/list/2/deep', `/${FAKES.slackBot}`, '/top'].sort());
    expect(hasSecretShape(canonicalJson(value))).toBe(false);
    expect(input.top).toContain('sk-ant-'); // the input is not mutated
  });

  for (const [name, secret] of Object.entries(FAKES)) {
    test(`${name} is redacted`, () => {
      const { value } = redactSecrets({ s: `before ${secret} after` });
      expect(hasSecretShape(canonicalJson(value))).toBe(false);
      expect(value.s).toContain(REDACTED);
    });
  }

  test('ordinary text is left alone', () => {
    const v = { s: 'a normal sentence about tokens, keys and AKIA', t: 'ghp_' };
    expect(redactSecrets(v)).toEqual({ value: v, paths: [] });
  });
});

describe('appendEvent redacts before write', () => {
  test('secret-shaped values are stored redacted, the redaction is recorded, and the chain verifies', () => {
    const store = openStore({ path: ':memory:' });
    const e = store.writer!.appendEvent(ev(1, { payload: { ...FAKES, ok: 'fine' } }));
    const stored = store.reader().get<{ payload: string }>('SELECT payload FROM events WHERE seq = 1')!;
    expect(hasSecretShape(stored.payload)).toBe(false);
    for (const k of Object.keys(FAKES)) expect(e.payload[k]).toBe(REDACTED);
    expect(e.payload.ok).toBe('fine');
    expect((e.payload[REDACTION_KEY] as string[]).sort()).toEqual(
      Object.keys(FAKES)
        .map((k) => `/${k}`)
        .sort(),
    );
    expect(store.verifyChain()).toMatchObject({ ok: true, count: 1 });
    store.close();
  });

  test('a shape that spans two values cannot be redacted per value: nothing is written', () => {
    const store = openStore({ path: ':memory:' });
    const payload = { a: 'BEGIN the work', b: 'then lock the PRIVATE KEY drawer' };
    expect(() => store.writer!.appendEvent(ev(1, { payload }))).toThrow(SecretShapeError);
    expect(store.verifyChain()).toMatchObject({ ok: true, count: 0 });
    store.close();
  });

  test('events cannot be inserted around appendEvent through the store', () => {
    const store = openStore({ path: ':memory:' });
    expect(() => store.writer!.run('INSERT INTO events(seq) VALUES (1)', [])).toThrow(
      ForbiddenStatementError,
    );
    store.close();
  });
});

describe('tripwire trigger', () => {
  test('a raw insert that bypasses redaction is refused by trg_events_no_secret_shapes', () => {
    const path = seededDb(dir, 'tripwire.sqlite', 0);
    const raw = new Database(path);
    raw.pragma('foreign_keys = ON');
    const insert = raw.prepare(
      'INSERT INTO events(seq,id,ts,type,actor_kind,actor_id,correlation_id,idempotency_key,payload,payload_hash,prev_hash,hash) ' +
        "VALUES (1,'evt_raw00001',?,'system.config_changed','system','fwd','corr_1',?,?,?,?,?)",
    );
    for (const [name, secret] of Object.entries(FAKES)) {
      if (name === 'pkcs8') continue; // the trigger's GLOB needs text between BEGIN and PRIVATE KEY
      const payload = canonicalJson({ note: secret });
      expect(() =>
        insert.run(
          new Date().toISOString(),
          name,
          payload,
          sha256Hex(payload),
          GENESIS_HASH,
          sha256Hex(name),
        ),
      ).toThrow(/secret-shaped/);
    }
    const clean = canonicalJson({ note: 'a normal sentence' });
    insert.run(new Date().toISOString(), 'clean', clean, sha256Hex(clean), GENESIS_HASH, sha256Hex('clean'));
    raw.close();
  });
});
