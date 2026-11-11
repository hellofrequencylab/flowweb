// FW-C-113: the facts check beside a draft (S9). It lists what the draft gate and the email rules found:
// blocks stop the draft, warnings only flag it. A queue email also shows its preheader and every link with
// its tags, so the Owner can click each one before pasting the email into Frequency Email Studio.
import type { FlowDraft } from '../api/types';
import { Icon } from '../ui-kit/Icon';

const LINK = /https?:\/\/[^\s<>"')\]]+/gi;
const TAGS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

function linksOf(body: string): { url: string; path: string; tags: string }[] {
  return (body.match(LINK) ?? []).flatMap((raw) => {
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (!URL.canParse(url)) return [];
    const u = new URL(url);
    const tags = TAGS.map((k) => (u.searchParams.has(k) ? `${k}=${u.searchParams.get(k)}` : null))
      .filter(Boolean)
      .join(' ');
    return [{ url, path: `${u.hostname.replace(/^www\./, '')}${u.pathname}`, tags }];
  });
}

export function FactsCheck({ draft }: { draft: FlowDraft }) {
  const blocks = draft.gate?.blocks ?? [];
  const warns = draft.gate?.warns ?? [];
  const links = linksOf(draft.body);
  return (
    <section className="draft-ai draft-facts" aria-label="Facts check">
      <span className="field-label">
        <Icon name={blocks.length ? 'shield-x' : 'check'} /> Facts check
      </span>
      {blocks.length === 0 ? (
        <p className="muted">
          Passed every rule: no dash, no Midnight, no typed price, no made-up number or date, tagged live
          links.
        </p>
      ) : (
        <ul className="facts-list">
          {blocks.map((b) => (
            <li key={`${b.code}-${b.detail}`} className="facts-block">
              <strong>Blocked:</strong> {b.detail}
            </li>
          ))}
        </ul>
      )}
      {warns.length > 0 && (
        <ul className="facts-list">
          {warns.map((w) => (
            <li key={`${w.code}-${w.detail}`}>Note: {w.detail}</li>
          ))}
        </ul>
      )}
      {draft.preheader && (
        <p>
          <span className="muted">Preheader:</span> {draft.preheader}
        </p>
      )}
      {links.length > 0 && (
        <ul className="facts-list" aria-label="Links in this draft">
          {links.map((l) => (
            <li key={l.url}>
              <a href={l.url} target="_blank" rel="noreferrer">
                {l.path}
              </a>{' '}
              <span className="muted">{l.tags || 'no tags'}</span>
            </li>
          ))}
        </ul>
      )}
      {draft.gate?.facts_from && <p className="muted">Facts from {draft.gate.facts_from}.</p>}
    </section>
  );
}
