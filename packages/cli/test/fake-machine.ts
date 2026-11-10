// A fake machine for `fw accounts`: fake claude and codex CLIs, keychain and HTTPS. Shared by the
// accounts tests and the router's --json test, so no test ever reaches the real machine.
import type { RunOptions, RunResult, System } from '../src/accounts/system.ts';

export const TOKEN = `sk-ant-oat01-${'T'.repeat(40)}`;
export const AKEY = `sk-ant-api03-${'A'.repeat(40)}`;
export const OKEY = `sk-proj-${'O'.repeat(40)}`;

interface Call {
  cmd: string;
  args: string[];
  opts: RunOptions;
}
export interface Machine {
  secrets: Record<string, string>;
  claude?: boolean;
  codex?: boolean;
  codexSignedIn?: boolean;
  claudeAnswer?: RunResult;
  codexAnswer?: RunResult;
  http?: Record<string, number | null>;
}

export function fakeSystem(m: Machine) {
  const calls: Call[] = [];
  const http: { url: string; headers: Record<string, string> }[] = [];
  let report: unknown;
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const missing: RunResult = { code: null, stdout: '', stderr: '', error: 'ENOENT' };
  const sys: System = {
    home: '/fwhome',
    env: { PATH: '/bin', HOME: '/Users/me', ANTHROPIC_API_KEY: AKEY, CODEX_API_KEY: OKEY },
    run(cmd, args, opts = {}) {
      calls.push({ cmd, args, opts });
      if (cmd === 'claude') {
        if (!m.claude) return missing;
        if (args[0] === '--version') return ok('2.1.321');
        return m.claudeAnswer ?? ok('{"type":"result","is_error":false,"result":"OK"}');
      }
      if (cmd === 'codex') {
        if (!m.codex) return missing;
        if (args[0] === '--version') return ok('codex-cli 0.80.0');
        if (args[0] === 'login' && args[1] === 'status')
          return m.codexSignedIn
            ? ok('Logged in using ChatGPT')
            : { code: 1, stdout: 'Not logged in', stderr: '' };
        if (args[1] === '--help') return ok('--skip-git-repo-check  --sandbox <MODE>');
        return m.codexAnswer ?? ok('OK');
      }
      return missing;
    },
    async get(url, headers) {
      http.push({ url, headers });
      const host = new URL(url).host;
      const s = m.http?.[host];
      return s === null ? { status: null, error: 'getaddrinfo ENOTFOUND' } : { status: s ?? 200 };
    },
    getSecret(h) {
      const v = m.secrets[h];
      return v ? { value: v, where: 'keychain' } : null;
    },
    writeReport(name, body) {
      report = JSON.parse(JSON.stringify(body));
      return `/fwhome/${name}`;
    },
    tempDir: () => '/tmp/fw-accounts-x',
  };
  return { sys, calls, http, report: () => report };
}
