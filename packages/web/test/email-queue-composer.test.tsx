import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowDraft } from '../src/api/types';

const { stageEmailDraft } = vi.hoisted(() => ({ stageEmailDraft: vi.fn() }));
vi.mock('../src/api/client', () => ({ api: { stageEmailDraft } }));

import { EmailQueueComposer } from '../src/flows/EmailQueueComposer';

afterEach(() => {
  cleanup();
  stageEmailDraft.mockReset();
});

const draft: FlowDraft = {
  id: 'email_1',
  fire_id: null,
  lead_id: 'template:email-studio:subscribed_members',
  channel: 'email',
  subject: 'A note for members',
  preheader: 'A small preview',
  body: 'Hello there.',
  status: 'waiting_for_owner',
  created_at: '2026-11-11T12:00:00Z',
  gate: { blocks: [{ code: 'missing_fact', detail: 'A date needs a source.' }] },
};

describe('EmailQueueComposer', () => {
  it('stages only subscribed-member copy and refreshes the existing drafts inbox', async () => {
    const onStaged = vi.fn();
    stageEmailDraft.mockImplementation(async (_asset, onQueued) => {
      onQueued?.();
      return { draft };
    });
    render(<EmailQueueComposer onStaged={onStaged} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Draft name' }), {
      target: { value: 'whats-new' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), {
      target: { value: 'A note for members' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Preheader/ }), {
      target: { value: 'A small preview' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email copy' }), {
      target: { value: 'Hello there.' },
    });

    expect(screen.getByText('Subscribed members only')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stage draft for Email Studio' }));

    await waitFor(() =>
      expect(
        screen.getByText('Staged for review. The saved draft is blocked by its facts check.'),
      ).toBeTruthy(),
    );
    expect(stageEmailDraft).toHaveBeenCalledWith(
      {
        asset: 'whats-new',
        subject: 'A note for members',
        preheader: 'A small preview',
        body: 'Hello there.',
        audience: 'subscribed_members',
      },
      expect.any(Function),
    );
    expect(onStaged).toHaveBeenCalledWith('email_1');
    expect(screen.getByText(/does not send or schedule anything/)).toBeTruthy();
  });

  it('announces when the request is waiting for the paired Mac', async () => {
    stageEmailDraft.mockImplementation((_asset, onQueued) => {
      onQueued?.();
      return new Promise(() => {});
    });
    render(<EmailQueueComposer onStaged={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft name' }), { target: { value: 'november' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Update' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email copy' }), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage draft for Email Studio' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Waiting for your paired Mac to stage this draft.',
    );
  });
});
