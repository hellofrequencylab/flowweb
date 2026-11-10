#!/usr/bin/env node
// Stand-in for the `codex` CLI used by probes/flows/dispatch.mjs step 7. It behaves like Codex
// CLI 0.167.0 from the outside and like a careful agent on the inside, so a flow cycle goes through
// the real Codex adapter (preflight, sign-in check, argv, sandbox env, parser, engine accounting)
// and fails here wherever a real Codex run failed on the Owner's machine:
//   - `--version`, `exec --help` (the adapters' recorded help text) and `login status`; signed in
//     means $CODEX_HOME/auth.json exists. A run with neither sign-in nor CODEX_API_KEY exits 1.
//   - Like Codex, it refuses to run outside a git repository unless --skip-git-repo-check is given.
//   - Like a careful agent, it reads README.md and config.json from its folder and writes nothing
//     when they are missing, when the prompt forbids drafts.json, or when the prompt contradicts
//     itself the way run 5 did: a diff cap of 0 lines, "commit your work" next to "commit nothing",
//     or "find leads" with no hunts.json (the cycle has no network otherwise).
//   - Otherwise it writes drafts.json (one template per funnel) and, like Codex, claims no artifact: its final
//     message is the JSON report and nothing else.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? '';
const signedIn = codexHome !== '' && existsSync(join(codexHome, 'auth.json'));

if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.167.0\n');
  process.exit(0);
}
if (argv[0] === 'exec' && argv.includes('--help')) {
  process.stdout.write(readFileSync(join(root, 'packages/adapters/test/fixtures/codex/help-exec-0.167.0.txt'), 'utf8'));
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (signedIn) {
    process.stdout.write('Logged in using ChatGPT\n');
    process.exit(0);
  }
  process.stderr.write('Not logged in\n');
  process.exit(1);
}
if (argv[0] !== 'exec' || !argv.includes('--json')) {
  process.stderr.write('codex stand-in: not invoked as `codex exec --json`\n');
  process.exit(2);
}
if (!signedIn && !process.env.CODEX_API_KEY) {
  process.stderr.write('Not logged in. Run `codex login`, or set CODEX_API_KEY.\n');
  process.exit(1);
}
if (!existsSync(join(process.cwd(), '.git')) && !argv.includes('--skip-git-repo-check')) {
  process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\n');
  process.exit(1);
}

const prompt = readFileSync(0, 'utf8');
const thread = randomUUID();
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const finish = (summary) => {
  out({
    type: 'item.completed',
    item: {
      id: 'item_9',
      type: 'agent_message',
      text: JSON.stringify({ summary, claims: [], followups: [], stop_requests: [], tests_added: [], tests_modified: [] }),
    },
  });
  out({ type: 'turn.completed', usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 600 } });
  process.exit(0);
};

out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });
const missingFiles = ['README.md', 'config.json'].filter((f) => !existsSync(join(process.cwd(), f)));
if (missingFiles.length > 0) finish(`I could not find ${missingFiles.join(' or ')} in this folder, so I drafted nothing.`);
const never = /Never touch: ([^\n]*)/.exec(prompt)?.[1] ?? '';
const forbidden = never.split(/,\s*/).map((s) => s.replace(/\.$/, '').trim());
if (forbidden.includes('**/*') || forbidden.includes('drafts.json'))
  finish('The work order forbids drafts.json, so I wrote nothing.');

const contradictions = [
  /Keep the diff under 0 lines/.test(prompt) && 'a diff cap of 0 lines',
  /Commit your work/.test(prompt) && /commit nothing/i.test(prompt) && 'commit your work and commit nothing',
  /find leads/i.test(prompt) && !existsSync(join(process.cwd(), 'hunts.json')) && 'find leads with no network',
].filter(Boolean);
if (contradictions.length > 0)
  finish(`The requested work cannot fit the stated constraints (${contradictions.join('; ')}), so I wrote nothing.`);

const config = JSON.parse(readFileSync(join(process.cwd(), 'config.json'), 'utf8'));
const offer = config.offer?.name ?? 'the offer';
const drafts = Object.keys(config.funnels ?? { host: {} }).map((f, i) => ({
  id: `d${i + 1}`,
  lead_id: `template:${f}`,
  send_via: f === 'resident' ? 'frequency' : 'founder_email',
  subject: `${offer}: a Circle near you`,
  body: `Hi, a note for a ${f}: would you like to be part of a ${offer} Circle near you?`,
}));
writeFileSync(join(process.cwd(), 'drafts.json'), JSON.stringify({ drafts }, null, 2));
out({
  type: 'item.completed',
  item: { id: 'item_1', type: 'file_change', changes: [{ path: 'drafts.json', kind: 'add' }], status: 'completed' },
});
finish(`Drafted ${drafts.length} template invites into drafts.json.`);
