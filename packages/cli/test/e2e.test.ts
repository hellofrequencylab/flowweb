// fw end to end, as separate processes against a temp FW_HOME, with the core client discovered at run
// time (see src/client.ts). Fixture row files are generated from CORE-BACKLOG.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { findProviders, findWorkspaceRoot } from '../src/index.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const BIN = resolve(import.meta.dirname, '../src/bin.ts');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const dir = mkdtempSync(join(tmpdir(), 'fw-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const home = join(dir, 'home');
const rows = join(dir, 'rows');
const repo = join(dir, 'repo');
const db = join(home, 'db/fw.sqlite');
/** Every row in CORE-BACKLOG.json; the count grows when the Owner adds a row. */
const ROWS = (
  JSON.parse(readFileSync(join(ROOT, 'ledger/backlog/CORE-BACKLOG.json'), 'utf8')) as { rows: unknown[] }
).rows.length;

function fw(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, FW_HOME: home };
  delete env.INIT_CWD;
  const r = spawnSync(TSX, [BIN, ...args], { cwd: repo, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function python(sql: string): string {
  const r = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.executescript(sys.argv[2])\nc.commit()\nprint("\\n".join(c.iterdump()))',
      db,
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}
const contentHash = () => createHash('sha256').update(python('')).digest('hex');

/** Read-only query against the database, rows as JSON. */
function query(sql: string, ...params: (string | number)[]): Record<string, unknown>[] {
  const r = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import json,sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nc.row_factory=sqlite3.Row\nprint(json.dumps([dict(x) for x in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))',
      db,
      sql,
      JSON.stringify(params),
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>[];
}

/** Hash of every table except the events appended after seq `upTo`. */
function contentHashUpTo(upTo: number): string {
  const tables = query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((t) => String(t.name));
  const h = createHash('sha256');
  for (const t of tables)
    h.update(
      `${t}\n${JSON.stringify(query(`SELECT * FROM "${t}"${t === 'events' ? ` WHERE seq <= ${upTo}` : ''} ORDER BY rowid`))}\n`,
    );
  return h.digest('hex');
}

mkdirSync(rows, { recursive: true });
mkdirSync(repo, { recursive: true });
// The installed policy copy (CORE-SPEC 5.2); the work-order compiler reads its size table.
mkdirSync(join(home, 'config'), { recursive: true });
copyFileSync(join(ROOT, 'contracts-core/core-policy.yaml'), join(home, 'config/core-policy.yaml'));
spawnSync('git', ['init', '-q', repo]);
const backlog = JSON.parse(readFileSync(join(ROOT, 'ledger/backlog/CORE-BACKLOG.json'), 'utf8')) as {
  rows: { id: string; status?: string }[];
};
for (const r of backlog.rows) {
  const { status: _s, ...def } = r;
  writeFileSync(join(rows, `${r.id}.json`), JSON.stringify(def, null, 2));
}

describe('fw ledger', () => {
  test('the CLI finds a core client provider in the workspace', () => {
    const root = findWorkspaceRoot(import.meta.dirname);
    expect(root).toBe(ROOT);
    expect(findProviders(ROOT).map((p) => p.package)).toContain('@fw/ledger');
  });

  test('sync imports every backlog row, reports an acyclic graph, and is idempotent', () => {
    const first = fw('ledger', 'sync', '--rows', rows);
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(first.out).toMatch(
      new RegExp(
        `^ledger sync: ${ROWS} created, 0 unchanged, 0 refused \\(dependency graph acyclic: ${ROWS} rows`,
      ),
    );
    const hash = contentHash();
    const second = fw('ledger', 'sync', '--rows', rows, '--json');
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ created: [], refused: [], graph: { acyclic: true } });
    expect(JSON.parse(second.out).unchanged).toHaveLength(ROWS);
    expect(contentHash()).toBe(hash);
  });

  test('list, show and next', () => {
    const list = JSON.parse(fw('ledger', 'list', '--json').out) as { code: string; status: string }[];
    expect(list).toHaveLength(ROWS);
    expect(new Set(list.map((r) => r.status))).toEqual(new Set(['open']));
    expect(fw('ledger', 'list', '--status', 'ready', '--json').out.trim()).toBe('[]');
    expect(fw('ledger', 'list', '--status', 'nonsense').code).toBe(2);
    const show = JSON.parse(fw('ledger', 'show', 'WS-P0-016', '--json').out);
    expect(show.row).toMatchObject({ code: 'WS-P0-016', id: 'lr_WSP0016', depends_on: ['FW-C-005'] });
    expect(show.probe.command.argv).toEqual(['pnpm', 'probe', 'kernel/ledger-fsm']);
    expect(fw('ledger', 'show', 'FW-C-999').code).toBe(1);
    expect(JSON.parse(fw('ledger', 'next', '--json').out)).toMatchObject({ row: null });
  });

  test('changing a probe path then syncing exits 1, records one tamper finding and changes nothing else', () => {
    const head = Number(query('SELECT MAX(seq) AS seq FROM events')[0]!.seq);
    const before = contentHashUpTo(head);
    const file = join(rows, 'FW-C-005.json');
    const original = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      original.replace('pnpm probe kernel/ledger-sync', 'pnpm probe kernel/ledger-sync-v2'),
    );
    try {
      const r = fw('ledger', 'sync', '--rows', rows);
      expect(r.code).toBe(1);
      expect(r.out).toContain('REFUSED, no row was written');
      expect(r.out).toMatch(
        /FW-C-005 \(lr_FWC005\): probe changed\n\s+stored [0-9a-f]{64}\n\s+file\s+[0-9a-f]{64}\n\s+tamper finding fnd_\S+ recorded/,
      );
      const added = query('SELECT type, payload FROM events WHERE seq > ? ORDER BY seq', head);
      expect(added.map((e) => e.type)).toEqual(['audit.finding_raised']);
      expect(JSON.parse(String(added[0]!.payload))).toMatchObject({
        check: 'probe_tamper',
        ledger_row_id: 'lr_FWC005',
        code: 'FW-C-005',
      });
      expect(contentHashUpTo(head)).toBe(before);
    } finally {
      writeFileSync(file, original);
    }
  });

  test('close on a row that is not verifying exits 1 with the refusal', () => {
    const r = fw('ledger', 'close', 'FW-C-005', '--merged-sha', 'a'.repeat(40));
    expect(r.code).toBe(1);
    expect(r.err).toContain('illegal ledger_row transition: FW-C-005 open -> done');
  });
});

describe('fw wo issue', () => {
  test('an unready row is refused', () => {
    const r = fw('wo', 'issue', 'FW-C-005', '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.code).toBe('ROW_NOT_READY');
  });

  test('self-verification is refused by policy (exit 3)', () => {
    const r = fw(
      'wo',
      'issue',
      'FW-C-005',
      '--doer',
      'agt_worker0001',
      '--verifier',
      'agt_worker0001',
      '--json',
    );
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe('SELF_VERIFY');
  });
});

describe('fw audit verify', () => {
  test('ok on an intact chain, exit 1 and one line on a broken one', () => {
    const ok = fw('audit', 'verify');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^audit verify: ok, \d+ events, head [0-9a-f]{16}\n$/);
    python(
      "DROP TRIGGER trg_events_no_update; UPDATE events SET payload = replace(payload, 'kernel', 'kernal') WHERE seq = 10;",
    );
    const broken = fw('audit', 'verify');
    expect(broken.code).toBe(1);
    expect(broken.out).toMatch(/^audit verify: BROKEN at seq 10: .+\n$/);
  });
});
