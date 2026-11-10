// Probe for FW-C-080 (anyone can make a FlowWeb login and get back in): `pnpm probe ui/sign-in-methods`.
// probe-timeout-s: 180
// Tier 0.
// Surface: packages/web/src/hosted/auth.ts. The checks are in probes/ui/sign-in-methods.spec.ts, run with
// vitest in jsdom against a fetch stub standing in for Supabase Auth and the hosted /v1, with the module
// loaded fresh under VITE_FW_HOSTED=1 and a fake Supabase URL and key.
//
// The surface this probe expects (all exported from hosted/auth.ts):
//   authMethods { password, link, google }        google only when VITE_FW_AUTH_GOOGLE is on
//   signInWithPassword(email, password)           POST /auth/v1/token?grant_type=password, keeps the session
//   signUp(email, password) -> { needsConfirm }   POST /auth/v1/signup
//   sendLink(email)                               POST /auth/v1/otp with create_user true
//   googleUrl() / signInWithGoogle()              /auth/v1/authorize?provider=google&redirect_to=<site>/
//   sendPasswordReset(email)                      POST /auth/v1/recover
//   setPassword(password)                         PUT /auth/v1/user with the session's token
//   signOut()                                     POST /auth/v1/logout, forgets the session
//   consumeRedirect() -> { kind: 'signin' | 'recovery' | null, error: string | null }
//   listAccounts(), createAccount(name), acceptInvite(token)   the hosted /v1 account calls
//   Every thrown message and every redirect error is one of our own sentences, never Supabase's text or a
//   link's error_description.
//
// Proves: the component checks pass (10 of them).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, missing, probe, root, tmpDir } from '../c0/_lib.mjs';

const NAME = 'ui/sign-in-methods';

await probe(NAME, async () => {
  const src = readFileSync(join(root, 'packages/web/src/hosted/auth.ts'), 'utf8');
  if (!/export\s+(async\s+)?function\s+signInWithPassword\b/.test(src))
    missing('packages/web/src/hosted/auth.ts does not export signInWithPassword (row FW-C-080)');

  const cfg = join(tmpDir('sign-in-methods'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      test: {
        environment: 'jsdom',
        environmentOptions: { jsdom: { url: 'https://flowweb.example/' } },
        include: [join(root, 'probes/ui/sign-in-methods.spec.ts')],
        testTimeout: 30000,
      },
    })};\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the sign-in checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+10 passed/.test(out), `expected 10 sign-in checks to pass:\n${out.slice(-400)}`);
});
