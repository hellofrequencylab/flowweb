// FW-C-072: what's working, from the flow's latest weekly review, in three or four plain lines. When there
// is no review yet, or too few sent to judge, it says so instead of naming a winner.
import { useId } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { ReviewDimension, ReviewSummary, ReviewValue } from '../api/types';
import { IconTile } from '../ui-kit/flow';
import { AsOf, ResourceView } from '../ui-kit/honest';

const lower = (label: string) => label.toLowerCase();
const pct = (r: number | null) => (r === null ? '' : ` (${Math.round(r * 100)}%)`);

function counts(v: Pick<ReviewValue, 'sent' | 'replied' | 'signups'>): string {
  const signed = v.signups > 0 ? `, ${v.signups} signed up` : '';
  return `${v.replied} of ${v.sent} replied${signed}`;
}

function listOf(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function weekOf(s: ReviewSummary): string {
  if (!s.at) return '';
  const d = new Date(s.at);
  return Number.isNaN(d.getTime())
    ? (s.week ?? '')
    : `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** The lines to show: up to two best values, the weakest one, and the flow's totals. Never more than four. */
export function linesOf(s: ReviewSummary): string[] {
  const judged = s.dimensions.filter((d): d is ReviewDimension & { best: ReviewValue } => d.best !== null);
  const best = judged.map((d) => `Best ${lower(d.label)}: ${d.best.name}, ${counts(d.best)}.`);
  const weak = judged.find((d) => d.worst && d.worst.value !== d.best.value);
  const weakest = weak?.worst
    ? [`Weakest ${lower(weak.label)}: ${weak.worst.name}, ${counts(weak.worst)}.`]
    : [];
  const t = s.totals;
  const total = `Across the flow: ${t.replied} of ${t.sent} replied${pct(t.reply_rate)}, ${t.signups} signed up${pct(t.signup_rate)}.`;
  const lines = [...best.slice(0, 2), ...weakest, total];
  for (const extra of best.slice(2)) if (lines.length < 4) lines.splice(lines.length - 1, 0, extra);
  return lines.slice(0, 4);
}

function Notes({ s }: { s: ReviewSummary }) {
  const untracked = s.dimensions.filter((d) => !d.tracked).map((d) => lower(d.label));
  const thin = s.dimensions.filter((d) => d.tracked && d.judged === 0).map((d) => lower(d.label));
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  return (
    <>
      {untracked.length > 0 && (
        <p className="muted small">
          {cap(listOf(untracked))} {untracked.length === 1 ? 'is' : 'are'} not tracked yet.
        </p>
      )}
      {s.state === 'ready' && thin.length > 0 && (
        <p className="muted small">
          No {listOf(thin)} has {s.min_sent} sent yet, so none is named.
        </p>
      )}
    </>
  );
}

function Body({ s }: { s: ReviewSummary }) {
  if (s.state === 'none')
    return (
      <p className="muted">
        No weekly review yet. Once drafts are marked sent, the review runs each week and this shows what drew
        replies and signups.
      </p>
    );
  if (s.state === 'thin')
    return (
      <>
        <p>
          Too few sent to judge yet: {s.totals.sent} sent so far, {s.totals.replied} replied. A source, hunt
          or funnel needs {s.min_sent} sent before it is named best or worst.
        </p>
        <Notes s={s} />
      </>
    );
  return (
    <>
      <ul className="whats-working-lines">
        {linesOf(s).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <Notes s={s} />
      {s.learnings.length > 0 && (
        <details className="small">
          <summary>What the review learned</summary>
          {s.learnings.map((l) => (
            <p key={l} className="muted">
              {l}
            </p>
          ))}
        </details>
      )}
    </>
  );
}

/** What's working for one flow, from its latest weekly review. */
export function WhatsWorking({ flow }: { flow: string }) {
  const res = useResource(`review-summary:${flow}`, () => api.reviewSummary(flow), ['runs']);
  const head = useId();
  return (
    <section className="panel whats-working" aria-labelledby={head}>
      <div className="inbox-head">
        <IconTile name="sparkles" />
        <div className="inbox-head-text">
          <h2 id={head}>What's working</h2>
          <span className="muted small">{res.data ? weekOf(res.data) : <AsOf res={res} />}</span>
        </div>
      </div>
      <ResourceView res={res} what="the weekly review">
        {(s) => <Body s={s} />}
      </ResourceView>
    </section>
  );
}
