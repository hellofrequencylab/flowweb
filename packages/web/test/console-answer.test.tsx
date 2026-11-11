import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Answer, blocksOf } from '../src/console/Answer';

const SAMPLE = `You're on the **Inbox** page (/inbox).

Here's what it shows right now:
- **22 drafts ready** for you to check.
- **44 drafts written** in the last 14 days.
1. First
2. Second`;

describe('console answer', () => {
  it('splits paragraphs, bullets and numbered lists', () => {
    expect(blocksOf(SAMPLE).map((b) => b.kind)).toEqual(['p', 'p', 'ul', 'ol']);
  });

  it('shows bold as bold and never the stars', () => {
    const { container } = render(<Answer text={SAMPLE} />);
    expect(container.querySelectorAll('strong')).toHaveLength(3);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect(container.textContent).not.toContain('**');
  });

  it('keeps markup as text, never as HTML', () => {
    const { container } = render(<Answer text={'<img src=x onerror=alert(1)> **hi**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img');
  });
});
