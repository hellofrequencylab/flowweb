// WS-P0-019: probes/MANIFEST.sha256 must list every file under probes/ with its current hash, so a
// probe change that skips the manifest fails here, in the PR, and not later when a row is closed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { PROBE_MANIFEST } from '../src/index.ts';

const root = resolve(import.meta.dirname, '../../..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

test('the probe manifest lists every probe file with its current sha256, and nothing else', () => {
  const listed = new Map<string, string>();
  for (const line of readFileSync(join(root, PROBE_MANIFEST), 'utf8').split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    expect(m, `not sha256sum output: ${line}`).not.toBeNull();
    listed.set(m![2]!, m![1]!);
  }
  const actual = new Map(
    files(join(root, 'probes'))
      .map((f) => relative(root, f))
      .filter((f) => f !== PROBE_MANIFEST)
      .map(
        (f) =>
          [
            f,
            createHash('sha256')
              .update(readFileSync(join(root, f)))
              .digest('hex'),
          ] as const,
      ),
  );
  const fix =
    'regenerate: find probes -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | xargs sha256sum > probes/MANIFEST.sha256';
  expect(
    [...actual.keys()].filter((f) => !listed.has(f)),
    `missing from the manifest; ${fix}`,
  ).toEqual([]);
  expect(
    [...listed.keys()].filter((f) => !actual.has(f)),
    `listed but not on disk; ${fix}`,
  ).toEqual([]);
  expect(
    [...actual].filter(([f, h]) => listed.get(f) !== h).map(([f]) => f),
    `hash changed; ${fix}`,
  ).toEqual([]);
});
