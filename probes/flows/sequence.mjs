// Probe for FW-C-104 (every lead moves through three touches, stops on a reply or a no, and email touches
// reach the sender only in a batch the Owner approves): `pnpm probe flows/sequence`.
// probe-timeout-s: 120
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token), the drafts folder $FW_HOME/flows/<key>/drafts/,
// the flow's state.json and a config.json override in $FW_HOME/flows/<key>/, the outbox
// $FW_HOME/outbox/<key>/, and $FW_HOME/flows/<key>/sequence.json.
// The surface this probe expects:
//   GET  /v1/flows/{key}/sequence -> 200 { data: { due: [{ lead, n, route, previous_route, due_at }],
//        leads: [{ lead, touches: [{ n, route, draft_id, sent_at }], state, next_due_at, closed_reason }] } }
//   POST /v1/flows/{key}/batch/approve { draft_ids } -> 200 { data: { handed_off: [id], held: [{ id, reason }],
//        refused: [{ id, reason }], cap, used_today } }   (CLI token; 401 without)
//   A draft's lead is its sequence_lead, else its lead_id, else its address (to), else its contact page.
//   A sent draft is a touch. Touch 2 is due 5 days after touch 1, touch 3 12 days after; never a fourth.
//   replied or declined on any of a lead's drafts closes it at once; so does do-not-contact.
//   A lead whose last touch went by DM and that has a public email (to or public_email) gets route email.
//   Batch approval hands email-route drafts (send_via email, with an address) to the outbox through the
//   same hand-off as Copilot, even with the flow at Draft when config.json sets
//   sequence.email_batch_approval true; at most 20 a day (sequence.email_daily_cap may lower it); the
//   rest are held with a reason starting daily_cap. A DM draft is refused (not_email), and so is a draft
//   for a closed lead or a lead past three touches.
//
// Proves, in order:
//   1. A lead whose touch 1 was sent 5 days ago is due for touch 2; one sent 2 days ago is not.
//   2. A reply closes a lead (replied); a no closes it the same day (declined, closed_at today).
//   3. A lead with three touches sent is never due again and has exactly three touches.
//   4. A DM lead with a public email is offered touch 2 by email.
//   5. The batch needs the CLI token.
//   6. A batch of 25 email drafts plus a DM draft and a draft for a closed lead: 20 handed off, 5 held
//      (daily_cap), the DM refused (not_email), the closed one refused; 20 files in the outbox, each for
//      the email sender (lead.to, lead.send_via email). The flow stays at Draft.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/sequence';
const KEY = 'neighborhood-activation';
const DAY = 86_400_000;

await probe(NAME, async () => {
  const home = freshHome('sequence');
  const f = await startFwd(home);
  try {
    const call = (method, path, body, auth = f.token) => api(f.port, method, path, { auth, body });
    const sup = `/v1/supervisor/flows/${KEY}`;
    check((await call('POST', `${sup}/enable`)).status === 200, `enabling ${KEY} failed`);
    const flowDir = join(home, 'flows', KEY);
    const drafts = join(flowDir, 'drafts');
    mkdirSync(drafts, { recursive: true });
    const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
    writeFileSync(join(flowDir, 'config.json'), JSON.stringify({ ...cfg, sequence: { email_batch_approval: true } }));
    const now = Date.now();
    const ago = (days) => new Date(now - days * DAY).toISOString();
    const put = (id, extra = {}) =>
      writeFileSync(
        join(drafts, `${id}.json`),
        JSON.stringify({
          flow: KEY,
          id,
          channel: 'frequency',
          send_via: 'email',
          to: `${id}@example.com`,
          source_url: 'https://example.com/events',
          subject: 'A question about your circle',
          body: 'Hi, I found you on https://example.com/events. If this is not for you, just reply "no" and I will not write again.',
          status: 'waiting_for_owner',
          created_at: ago(30),
          ...extra,
        }),
      );

    put('due1', { sent_at: ago(5.1) });
    put('soon1', { sent_at: ago(2) });
    put('rep1', { sequence_lead: 'lead-rep', sent_at: ago(5.1), replied_at: ago(0.1) });
    put('no1', { sequence_lead: 'lead-no', sent_at: ago(5.1) });
    for (const [i, d] of [20, 15, 8].entries())
      put(`three${i + 1}`, { sequence_lead: 'lead-three', sent_at: ago(d), created_at: ago(d) });
    put('dm1', { send_via: 'social_dm', to: null, public_email: 'dmhost@example.com', sequence_lead: 'lead-dm', sent_at: ago(5.2) });

    const seq = await call('GET', `/v1/flows/${KEY}/sequence`);
    if (seq.status === 404 || seq.status === 405) missing(`GET /v1/flows/${KEY}/sequence answered ${seq.status}`);
    check(seq.status === 200, `GET sequence answered ${seq.status}: ${seq.text.slice(0, 200)}`);
    const due = seq.json?.data?.due ?? [];
    const leads = Object.fromEntries((seq.json?.data?.leads ?? []).map((l) => [l.lead, l]));
    const dueOf = (lead) => due.find((d) => d.lead === lead);

    // 1.
    check(dueOf('due1@example.com')?.n === 2, `touch 1 sent 5 days ago is not due for touch 2: ${JSON.stringify(due)}`);
    check(!dueOf('soon1@example.com'), 'touch 1 sent 2 days ago is already due');
    // 2.
    check(!dueOf('lead-rep') && leads['lead-rep']?.closed_reason === 'replied', `a reply did not close the lead: ${JSON.stringify(leads['lead-rep'])}`);
    put('no1', { sequence_lead: 'lead-no', sent_at: ago(5.1), declined_at: new Date().toISOString() });
    const seq2 = await call('GET', `/v1/flows/${KEY}/sequence`);
    const no = (seq2.json?.data?.leads ?? []).find((l) => l.lead === 'lead-no');
    check(no?.state === 'closed' && no?.closed_reason === 'declined', `a no did not close the lead: ${JSON.stringify(no)}`);
    check(new Date(no.closed_at ?? 0).toDateString() === new Date().toDateString(), `the no closed on ${no.closed_at}, not today`);
    check(!(seq2.json?.data?.due ?? []).some((d) => d.lead === 'lead-no'), 'a lead that said no is still due');
    // 3.
    check(!dueOf('lead-three'), 'a fourth touch is due');
    check(leads['lead-three']?.touches?.length === 3 && leads['lead-three']?.state === 'closed', `three touches: ${JSON.stringify(leads['lead-three'])}`);
    // 4.
    check(dueOf('lead-dm')?.route === 'email', `a DM lead with a public email is not offered email: ${JSON.stringify(dueOf('lead-dm'))}`);

    // 5.
    const path = `/v1/flows/${KEY}/batch/approve`;
    check((await call('POST', path, { draft_ids: ['due1'] }, null)).status === 401, 'batch approval answered without the CLI token');

    // 6.
    const ids = Array.from({ length: 25 }, (_, i) => `mail${String(i + 1).padStart(2, '0')}`);
    for (const id of ids) put(id);
    put('dmnew', { send_via: 'social_dm', to: null, contact_url: 'https://example.com/host' });
    put('rep2', { sequence_lead: 'lead-rep' });
    const r = await call('POST', path, { draft_ids: ['dmnew', 'rep2', ...ids] });
    check(r.status === 200, `batch approve answered ${r.status}: ${r.text.slice(0, 300)}`);
    const d = r.json?.data ?? {};
    check(d.handed_off?.length === 20, `handed off ${d.handed_off?.length}, want 20: ${r.text.slice(0, 300)}`);
    check(d.held?.length === 5 && d.held.every((h) => /^daily_cap/.test(h.reason)), `held: ${JSON.stringify(d.held)}`);
    const refused = Object.fromEntries((d.refused ?? []).map((x) => [x.id, x.reason]));
    check(/^not_email/.test(refused.dmnew ?? ''), `the DM draft was not refused as not_email: ${JSON.stringify(d.refused)}`);
    check(/^closed/.test(refused.rep2 ?? ''), `a draft for a closed lead was not refused: ${JSON.stringify(d.refused)}`);
    const outDir = join(home, 'outbox', KEY);
    const out = existsSync(outDir) ? readdirSync(outDir).filter((x) => x.endsWith('.json')) : [];
    check(out.length === 20, `outbox holds ${out.length} files, want 20`);
    for (const x of out) {
      const item = JSON.parse(readFileSync(join(outDir, x), 'utf8'));
      check(item.lead?.send_via === 'email' && /@example\.com$/.test(item.lead?.to ?? ''), `outbox item ${x} is not for the email sender`);
    }
    check(!out.includes('dmnew.json'), 'the DM draft reached the outbox');
    const flow = ((await call('GET', '/v1/supervisor')).json?.data?.flows ?? []).find((x) => x.key === KEY);
    check(flow?.dial === 'draft', `the flow left Draft: ${flow?.dial}`);
  } finally {
    await f.stop();
  }
});
