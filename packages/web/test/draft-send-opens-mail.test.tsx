import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDraft } from '../src/api/types';
import { DraftEditor } from '../src/flows/DraftEditor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draft: FlowDraft = {
  id: 'd_1',
  fire_id: 'f_1',
  lead_id: 'lead:d_1',
  channel: 'founder_email',
  subject: 'Your Saturday market',
  body: 'Hi Front Porch Gallery, a note.',
  status: 'waiting_for_owner',
  created_at: '2026-11-18T10:00:00Z',
  to: 'hello@frontporch.example',
};

describe('Copy and send', () => {
  it('opens the message during the press, before the copy has finished, and leaves a link to it', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => {
      opened.push(String(url));
      return null;
    });
    let finishCopy: () => void = () => {};
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => new Promise<void>((done) => (finishCopy = done)) },
    });

    render(<DraftEditor flow="neighborhood-activation" draft={draft} sender={false} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy and send' }));

    // The copy is still running: a browser only lets a new tab open while the press is being handled.
    expect(opened.length).toBe(1);
    expect(opened[0]).toContain('mail.google.com');
    expect(decodeURIComponent(opened[0] ?? '')).toContain('hello@frontporch.example');

    finishCopy();
    const link = await screen.findByRole('link', { name: 'Open the message in Gmail' });
    expect(link.getAttribute('href')).toBe(opened[0]);
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
