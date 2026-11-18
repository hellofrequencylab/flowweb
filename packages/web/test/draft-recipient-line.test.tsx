import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowDraft } from '../src/api/types';
import { DraftEditor } from '../src/flows/DraftEditor';

afterEach(cleanup);

const base: FlowDraft = {
  id: 'd_1',
  fire_id: 'f_1',
  lead_id: null,
  channel: 'frequency',
  subject: 'Your open mic',
  body: 'Hi there, a short note.',
  status: 'waiting_for_owner',
  created_at: '2026-11-18T12:00:00Z',
};

describe('The line at the top of a draft that says who it goes to', () => {
  it('an email draft shows the address and a plain link that opens the message in Gmail', () => {
    render(
      <DraftEditor
        flow="neighborhood-activation"
        draft={{ ...base, to: 'hello@studio.example' }}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText('hello@studio.example')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open in Gmail' }) as HTMLAnchorElement;
    expect(link.href).toContain('https://mail.google.com/mail/?view=cm');
    expect(link.href).toContain('to=hello%40studio.example');
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeTruthy();
  });

  it('a draft with no address and only the page it was found on says so and links to that page', () => {
    render(
      <DraftEditor
        flow="neighborhood-activation"
        draft={{ ...base, source_url: 'https://www.poet.example/contact' }}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText(/No email address\. Send it through/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open their page' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://www.poet.example/contact');
    expect(screen.queryByRole('button', { name: 'Copy address' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
  });

  it('a draft with neither says nothing is on record', () => {
    render(<DraftEditor flow="neighborhood-activation" draft={base} onChanged={() => {}} />);
    expect(screen.getByText('No email address or page on record.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
