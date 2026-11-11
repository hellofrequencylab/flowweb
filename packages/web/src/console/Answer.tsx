// The console's answer as tidy text: short paragraphs, bullet and numbered lists, **bold** and `code`.
// Built from React elements only (never HTML), so nothing in an answer can run or style the page.
import type { ReactNode } from 'react';

/** **bold** and `code` inside one line. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={`${key}-${m.index}`}>{m[1]}</strong>);
    else out.push(<code key={`${key}-${m.index}`}>{m[2]}</code>);
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

type Block = { kind: 'p' | 'ul' | 'ol'; lines: string[] };

/** Splits an answer into paragraphs and lists. A list item's wrapped lines join the item before them. */
export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(HEADING, '');
    if (!line.trim()) {
      blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    const kind = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : 'p';
    const prev = blocks[blocks.length - 1];
    if (kind === 'p' && prev && prev.kind !== 'p' && /^\s/.test(raw)) {
      prev.lines[prev.lines.length - 1] += ` ${line.trim()}`;
    } else if (prev && prev.kind === kind && (kind !== 'p' || prev.lines.length)) {
      prev.lines.push(line.replace(BULLET, '').replace(NUMBER, ''));
    } else {
      blocks.push({ kind, lines: [line.replace(BULLET, '').replace(NUMBER, '')] });
    }
  }
  return blocks.filter((b) => b.lines.length);
}

export function Answer({ text }: { text: string }) {
  return (
    <div className="console-answer">
      {blocksOf(text).map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'p') return <p key={key}>{inline(b.lines.join(' '), key)}</p>;
        const items = b.lines.map((l, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an answer's items never reorder or change once shown
          <li key={`${key}-${j}`}>{inline(l, `${key}-${j}`)}</li>
        ));
        return b.kind === 'ul' ? <ul key={key}>{items}</ul> : <ol key={key}>{items}</ol>;
      })}
    </div>
  );
}
