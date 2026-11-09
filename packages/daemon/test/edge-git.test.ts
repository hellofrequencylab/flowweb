import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GhHost, type GhHostLogEntry, type Runner } from '../src/edge-git/gh-host.ts';
import { LocalBareHost } from '../src/edge-git/local-bare-host.ts';
import { GitHostError } from '../src/edge-git/port.ts';
import type { ExecOptions } from '../src/runtime/exec.ts';
import { git } from '../src/runtime/exec.ts';
import { commitAll, initRepo, tempDir, writeFile } from './git-fixtures.ts';

describe('LocalBareHost', () => {
  let tmp: ReturnType<typeof tempDir>;
  let host: LocalBareHost;
  let repo: string;

  beforeEach(async () => {
    tmp = tempDir();
    host = await LocalBareHost.init(join(tmp.path, 'remote.git'));
    ({ repo } = await initRepo(join(tmp.path, 'work')));
    await host.pushBranch({ cwd: repo, branch: 'main' });
  });
  afterEach(() => tmp.cleanup());

  async function branchWithCommit(name: string, file: string): Promise<string> {
    await git(repo, ['checkout', '--quiet', '-b', name, 'main']);
    writeFile(repo, file, `${name}\n`);
    const sha = await commitAll(repo, `work on ${name}`);
    await git(repo, ['checkout', '--quiet', 'main']);
    return sha;
  }

  test('push, open PR, comment, status, fast-forward merge', async () => {
    const sha = await branchWithCommit('fw/R-1/run_a', 'a.txt');
    expect(await host.getHeadSha('fw/R-1/run_a')).toBeNull();
    expect(await host.pushBranch({ cwd: repo, branch: 'fw/R-1/run_a' })).toEqual({
      branch: 'fw/R-1/run_a',
      sha,
    });
    expect(await host.getHeadSha('fw/R-1/run_a')).toBe(sha);

    const pr = await host.openPullRequest({
      title: 'Add a',
      body: 'evidence',
      head: 'fw/R-1/run_a',
      base: 'main',
    });
    expect(pr).toEqual({ number: 1, url: expect.stringMatching(/^file:\/\/.*\/pull\/1$/), head_sha: sha });
    await expect(
      host.openPullRequest({ title: 'again', body: '', head: 'fw/R-1/run_a', base: 'main' }),
    ).rejects.toThrow(/already exists/);

    expect((await host.commentOnPr(1, 'probe passed')).url).toMatch(/#comment-1$/);
    expect(host.comments(1)).toEqual(['probe passed']);
    expect(await host.getPrStatus(1)).toMatchObject({ state: 'open', head_sha: sha, merged_sha: null });

    const merged = await host.merge(1);
    expect(merged).toMatchObject({ state: 'merged', head_sha: sha, merged_sha: sha });
    expect(await host.getHeadSha('main')).toBe(sha);
    await expect(host.merge(1)).rejects.toThrow(/merged/);
  });

  test('merge writes a merge commit when base moved on', async () => {
    const a = await branchWithCommit('fw/R-1/run_a', 'a.txt');
    const b = await branchWithCommit('fw/R-2/run_b', 'b.txt');
    await host.pushBranch({ cwd: repo, branch: 'fw/R-1/run_a' });
    await host.pushBranch({ cwd: repo, branch: 'fw/R-2/run_b' });
    await host.openPullRequest({ title: 'a', body: '', head: 'fw/R-1/run_a', base: 'main' });
    await host.openPullRequest({ title: 'b', body: '', head: 'fw/R-2/run_b', base: 'main' });
    await host.merge(1);
    const s = await host.merge(2);
    expect(s.state).toBe('merged');
    expect(s.merged_sha).not.toBe(b);
    const parents = await git(host.barePath, ['rev-list', '--parents', '-n', '1', s.merged_sha!]);
    expect(parents.split(' ').slice(1)).toEqual([a, b]);
    expect(await host.getHeadSha('main')).toBe(s.merged_sha);
  });

  test('an open PR status follows a later push; closed PRs and bad input', async () => {
    await branchWithCommit('fw/R-1/run_a', 'a.txt');
    await host.pushBranch({ cwd: repo, branch: 'fw/R-1/run_a' });
    await host.openPullRequest({ title: 'a', body: '', head: 'fw/R-1/run_a', base: 'main' });
    await git(repo, ['checkout', '--quiet', 'fw/R-1/run_a']);
    writeFile(repo, 'a2.txt', 'more');
    const sha2 = await commitAll(repo, 'more');
    await host.pushBranch({ cwd: repo, branch: 'fw/R-1/run_a' });
    expect((await host.getPrStatus(1)).head_sha).toBe(sha2);
    expect((await host.close(1)).state).toBe('closed');

    await expect(host.getPrStatus(99)).rejects.toThrow(GitHostError);
    await expect(host.openPullRequest({ title: 'x', body: '', head: 'nope', base: 'main' })).rejects.toThrow(
      /does not exist/,
    );
    await expect(host.getHeadSha('--upload-pack=evil')).rejects.toThrow(GitHostError);
    await expect(host.pushBranch({ cwd: repo, branch: 'a..b' })).rejects.toThrow(GitHostError);
  });
});

describe('GhHost (fake runner, no network)', () => {
  type Call = { cmd: string; args: readonly string[]; opts: ExecOptions };
  function fakeRunner(responses: ((c: Call) => { code?: number; stdout?: string; stderr?: string })[]) {
    const calls: Call[] = [];
    const run: Runner = async (cmd, args, opts) => {
      const c = { cmd, args, opts };
      calls.push(c);
      const r = responses.shift();
      if (!r) throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
      const out = r(c);
      return { code: out.code ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
    };
    return { run, calls };
  }
  const env = { PATH: '/usr/bin', GH_TOKEN: 'fake-token-for-tests' };
  const viewJson = (state: string, merge: string | null) =>
    JSON.stringify({
      number: 7,
      url: 'https://example.invalid/o/r/pull/7',
      state,
      headRefName: 'fw/R-1/run_a',
      baseRefName: 'main',
      headRefOid: 'a'.repeat(40),
      mergeCommit: merge ? { oid: merge } : null,
    });

  test('openPullRequest uses argv, sends the body on stdin and re-reads the PR', async () => {
    const { run, calls } = fakeRunner([
      () => ({ stdout: 'https://example.invalid/o/r/pull/7\n' }),
      () => ({ stdout: viewJson('OPEN', null) }),
    ]);
    const host = new GhHost({ repo: 'o/r', env, run });
    const pr = await host.openPullRequest({
      title: '-rf; echo $(x)',
      body: 'b`o`dy',
      head: 'fw/R-1/run_a',
      base: 'main',
    });
    expect(pr).toEqual({ number: 7, url: 'https://example.invalid/o/r/pull/7', head_sha: 'a'.repeat(40) });
    expect(calls[0]!.cmd).toBe('gh');
    expect(calls[0]!.args).toEqual([
      'pr',
      'create',
      '--repo',
      'o/r',
      '--title=-rf; echo $(x)',
      '--body-file',
      '-',
      '--head=fw/R-1/run_a',
      '--base=main',
    ]);
    expect(calls[0]!.opts.input).toBe('b`o`dy');
    expect(calls[0]!.opts.env?.GH_TOKEN).toBe('fake-token-for-tests');
    expect(calls[1]!.args.slice(0, 3)).toEqual(['pr', 'view', '7']);
  });

  test('getPrStatus maps merged state and merge sha', async () => {
    const { run } = fakeRunner([() => ({ stdout: viewJson('MERGED', 'b'.repeat(40)) })]);
    const s = await new GhHost({ repo: 'o/r', env, run }).getPrStatus(7);
    expect(s).toMatchObject({
      state: 'merged',
      merged_sha: 'b'.repeat(40),
      head: 'fw/R-1/run_a',
      base: 'main',
    });
  });

  test('rate limits and 5xx are retried with backoff and logged; other errors are not', async () => {
    const log: GhHostLogEntry[] = [];
    const sleeps: number[] = [];
    const { run, calls } = fakeRunner([
      () => ({ code: 1, stderr: 'HTTP 502: Bad Gateway' }),
      () => ({ code: 1, stderr: 'API rate limit exceeded' }),
      () => ({ stdout: viewJson('OPEN', null) }),
    ]);
    const host = new GhHost({
      repo: 'o/r',
      env,
      run,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      log: (e) => log.push(e),
    });
    expect((await host.getPrStatus(7)).state).toBe('open');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([10, 20]);
    expect(log.map((e) => e.event)).toEqual(['git_host.retry', 'git_host.retry']);

    const bad = fakeRunner([() => ({ code: 1, stderr: 'HTTP 422: Validation Failed' })]);
    await expect(new GhHost({ repo: 'o/r', env, run: bad.run }).getPrStatus(7)).rejects.toThrow(GitHostError);
    expect(bad.calls).toHaveLength(1);

    const down = fakeRunner(Array.from({ length: 3 }, () => () => ({ code: 1, stderr: 'HTTP 503' })));
    const log2: GhHostLogEntry[] = [];
    await expect(
      new GhHost({
        repo: 'o/r',
        env,
        run: down.run,
        retries: 2,
        sleep: async () => {},
        log: (e) => log2.push(e),
      }).getPrStatus(7),
    ).rejects.toThrow(GitHostError);
    expect(log2.map((e) => e.event)).toEqual(['git_host.retry', 'git_host.retry', 'git_host.gave_up']);
  });

  test('getHeadSha returns null on 404', async () => {
    const { run, calls } = fakeRunner([() => ({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })]);
    expect(await new GhHost({ repo: 'o/r', env, run }).getHeadSha('fw/R-1/run_a')).toBeNull();
    expect(calls[0]!.args).toEqual(['api', 'repos/o/r/git/ref/heads/fw/R-1/run_a', '--jq', '.object.sha']);
  });

  test('pushBranch runs git with argv and a scrubbed git env', async () => {
    const { run, calls } = fakeRunner([() => ({}), () => ({ stdout: `${'c'.repeat(40)}\n` })]);
    const host = new GhHost({ repo: 'o/r', env: { ...env, GIT_DIR: '/elsewhere' }, run });
    expect(await host.pushBranch({ cwd: '/w', branch: 'fw/R-1/run_a' })).toEqual({
      branch: 'fw/R-1/run_a',
      sha: 'c'.repeat(40),
    });
    expect(calls[0]!.cmd).toBe('git');
    expect(calls[0]!.args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      '--porcelain',
      'origin',
      'refs/heads/fw/R-1/run_a:refs/heads/fw/R-1/run_a',
    ]);
    expect(calls[0]!.opts.cwd).toBe('/w');
    expect(calls[0]!.opts.env?.GIT_DIR).toBeUndefined();
  });

  test('token scope check refuses admin tokens and accepts a narrow one', async () => {
    const classicAdmin = fakeRunner([
      () => ({ stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, admin:org\n\n{}' }),
    ]);
    expect(await new GhHost({ repo: 'o/r', env, run: classicAdmin.run }).verifyTokenScope()).toMatchObject({
      ok: false,
      token_kind: 'classic',
      scopes: ['repo', 'admin:org'],
    });

    const fineAdmin = fakeRunner([() => ({ stdout: 'HTTP/2.0 200 OK\n\n{}' }), () => ({ stdout: 'true\n' })]);
    expect(await new GhHost({ repo: 'o/r', env, run: fineAdmin.run }).verifyTokenScope()).toMatchObject({
      ok: false,
      token_kind: 'fine_grained_or_app',
      repo_admin: true,
    });

    const narrow = fakeRunner([() => ({ stdout: 'HTTP/2.0 200 OK\n\n{}' }), () => ({ stdout: 'false\n' })]);
    expect(await new GhHost({ repo: 'o/r', env, run: narrow.run }).verifyTokenScope()).toMatchObject({
      ok: true,
    });

    expect(
      await new GhHost({ repo: 'o/r', env: { PATH: '/usr/bin' }, run: narrow.run }).verifyTokenScope(),
    ).toMatchObject({
      ok: false,
      token_kind: 'none',
    });
  });

  test('rejects a malformed repo and PR number', async () => {
    expect(() => new GhHost({ repo: 'o/r; rm -rf /' })).toThrow(GitHostError);
    const { run } = fakeRunner([]);
    await expect(new GhHost({ repo: 'o/r', env, run }).getPrStatus(-1)).rejects.toThrow(GitHostError);
  });
});
