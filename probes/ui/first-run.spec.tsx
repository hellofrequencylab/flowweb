// The component checks for FW-C-082; run by probes/ui/first-run.mjs (not on its own). Tier 0.
// hosted/auth is stood in by spies, so nothing here reaches an auth server.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  createAccount: vi.fn(async (name: string) => ({ id: 'acc_1', name, role: 'owner' })),
  acceptInvite: vi.fn(async (_t: string) => ({ account_id: 'acc_9' })),
}));
vi.mock('../../packages/web/src/hosted/auth', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    HOSTED: true,
    authMethods: { password: true, link: true, google: true },
    accessToken: async () => null,
    signedInEmail: () => null,
    createAccount: fake.createAccount,
    acceptInvite: fake.acceptInvite,
  };
});

import {
  clearInvite,
  inviteFromPath,
  JoinInvite,
  NameBusiness,
  pendingInvite,
  rememberInvite,
} from '../../packages/web/src/home/firstRun';
import { HomePage } from '../../packages/web/src/home/HomePage';

beforeEach(() => {
  fake.createAccount.mockClear();
  fake.acceptInvite.mockClear();
  sessionStorage.clear();
});
afterEach(cleanup);

const nameField = () => document.querySelector('input[autocomplete="organization"]') as HTMLInputElement | null;

describe('first run and invites on flowweb.app', () => {
  it('names a new business and hands back the account', async () => {
    const onDone = vi.fn();
    render(<NameBusiness onDone={onDone} />);
    expect(screen.getByRole('heading', { name: /name your business/i })).toBeTruthy();
    const field = nameField();
    expect(field).toBeTruthy();
    fireEvent.change(field as HTMLInputElement, { target: { value: '  Sunrise Yoga  ' } });
    fireEvent.submit((field as HTMLInputElement).closest('form') as HTMLFormElement);
    await waitFor(() => expect(fake.createAccount).toHaveBeenCalledWith('Sunrise Yoga'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'acc_1' })));
    expect(document.body.textContent ?? '').not.toMatch(/—/);
  });

  it('does nothing with a blank name', async () => {
    render(<NameBusiness onDone={() => undefined} />);
    const field = nameField() as HTMLInputElement;
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.createAccount).not.toHaveBeenCalled();
  });

  it('shows a failed create in an alert', async () => {
    fake.createAccount.mockRejectedValueOnce(new Error('That name did not save. Try again.'));
    render(<NameBusiness onDone={() => undefined} />);
    const field = nameField() as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Sunrise Yoga' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toMatch(/did not save/));
  });

  it('accepts an invite once and says you are in', async () => {
    const onJoined = vi.fn();
    render(<JoinInvite token="tok_abc" onJoined={onJoined} />);
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('acc_9'));
    expect(fake.acceptInvite).toHaveBeenCalledTimes(1);
    expect(fake.acceptInvite).toHaveBeenCalledWith('tok_abc');
    expect(screen.getByText(/you're in|you are in/i)).toBeTruthy();
  });

  it('shows a used-up invite in an alert with a way on', async () => {
    fake.acceptInvite.mockRejectedValueOnce(new Error('That invite has already been used.'));
    render(<JoinInvite token="tok_old" onJoined={() => undefined} />);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toMatch(/already been used/));
    expect(screen.getByRole('button', { name: /flowweb/i })).toBeTruthy();
  });

  it('reads the invite token from the address and keeps it across sign-in', () => {
    expect(inviteFromPath('/join/tok_abc')).toBe('tok_abc');
    expect(inviteFromPath('/join/')).toBeNull();
    expect(inviteFromPath('/inbox')).toBeNull();
    rememberInvite('tok_abc');
    expect(pendingInvite()).toBe('tok_abc');
    clearInvite();
    expect(pendingInvite()).toBeNull();
  });

  it('tells a signed-out visitor on an invite link that they were invited', () => {
    render(<HomePage invite />);
    expect(screen.getByText(/invited/i)).toBeTruthy();
  });
});
