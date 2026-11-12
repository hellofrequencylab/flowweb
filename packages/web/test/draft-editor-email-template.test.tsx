import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDraft } from '../src/api/types';
import { DraftEditor } from '../src/flows/DraftEditor';
import { LOGO_URL } from '../src/flows/draft-html';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draft: FlowDraft = {
  id: 'email_1',
  fire_id: null,
  lead_id: 'template:email-studio:subscribed_members',
  channel: 'email',
  subject: 'A lot has changed since you joined',
  preheader: 'Your Space can have its own website now.',
  body: 'Hi there,\n\nHere is the update.\n\nDaniel Tyack\nFrequency',
  status: 'waiting_for_owner',
  created_at: '2026-11-11T12:00:00Z',
};

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('DraftEditor for Email Studio templates', () => {
  it('offers copy only and includes subject, preheader, body, and the Frequency HTML wrapper', async () => {
    const writes: unknown[][] = [];
    class ClipboardItemStub {
      constructor(readonly data: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', ClipboardItemStub);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: async (items: unknown[]) => writes.push(items) },
    });

    render(<DraftEditor flow="email-queue" draft={draft} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy for Email Studio' }));
    expect(await screen.findByRole('button', { name: 'Copied for Email Studio' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy and send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'I sent it' })).toBeNull();
    expect(screen.queryByText('After you send it')).toBeNull();

    const items = writes[0] as ClipboardItemStub[];
    expect(await readBlob(items![0]!.data['text/plain']!)).toBe(
      'Subject: A lot has changed since you joined\n\nPreheader: Your Space can have its own website now.\n\nHi there,\n\nHere is the update.\n\nDaniel Tyack\nFrequency',
    );
    const html = await readBlob(items![0]!.data['text/html']!);
    expect(html).toContain(LOGO_URL);
    expect(html).toContain('Subject: A lot has changed since you joined');
    expect(html).toContain('Preheader: Your Space can have its own website now.');

    if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
});
