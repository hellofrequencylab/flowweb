import type { ReactNode } from 'react';

/** Page title block: optional script greeting or overline, the h1, a lede, and an aside (figures, meta). */
export function PageHead({
  title,
  script,
  overline,
  lede,
  aside,
}: {
  title: ReactNode;
  script?: ReactNode;
  overline?: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {script && <span className="script">{script}</span>}
        {overline && <span className="overline">{overline}</span>}
        <h1 tabIndex={-1}>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {aside}
    </header>
  );
}

/** Overline, title and right-aligned meta, over a hairline. */
export function SectionHead({
  title,
  overline,
  meta,
  id,
}: {
  title: ReactNode;
  overline?: ReactNode;
  meta?: ReactNode;
  id?: string;
}) {
  return (
    <div className="section-head">
      <div>
        {overline && <span className="overline">{overline}</span>}
        <h2 id={id}>{title}</h2>
      </div>
      {meta && <div className="section-meta">{meta}</div>}
    </div>
  );
}

export type FigureItem = {
  label: string;
  value: ReactNode;
  of?: ReactNode;
  tone?: 'waiting' | 'active' | 'fail';
};

/** Large light summary numbers divided by hairlines. Pass an Unknown pill as the value when it is not known. */
export function Figures({ items, label }: { items: FigureItem[]; label?: string }) {
  return (
    <dl className="figures" aria-label={label}>
      {items.map((f) => (
        <div key={f.label} className={`figure${f.tone ? ` figure-${f.tone}` : ''}`}>
          <dt>{f.label}</dt>
          <dd>
            {f.value}
            {f.of && <span className="of">{f.of}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
