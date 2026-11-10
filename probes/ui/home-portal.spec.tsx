// The component checks for FW-C-081; run by probes/ui/home-portal.mjs (not on its own). Tier 0.
// hosted/auth is stood in by spies, so nothing here reaches an auth server.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  google: true,
  signInWithPassword: vi.fn(async (_e: string, _p: string) => undefined),
  signUp: vi.fn(async (_e: string, _p: string) => ({ needsConfirm: true })),
  sendLink: vi.fn(async (_e: string) => undefined),
  signInWithGoogle: vi.fn(async () => undefined),
  sendPasswordReset: vi.fn(async (_e: string) => undefined),
  setPassword: vi.fn(async (_p: string) => undefined),
}));
vi.mock('../../packages/web/src/hosted/auth', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    HOSTED: true,
    get authMethods() {
      return { password: true, link: true, google: fake.google };
    },
    accessToken: async () => null,
    signedInEmail: () => null,
    signInWithPassword: fake.signInWithPassword,
    signUp: fake.signUp,
    sendLink: fake.sendLink,
    signInWithGoogle: fake.signInWithGoogle,
    sendPasswordReset: fake.sendPasswordReset,
    setPassword: fake.setPassword,
  };
});

import { HomePage } from '../../packages/web/src/home/HomePage';

const EMAIL = 'friend@example.com';
const PW = 'correct horse battery';

const byAuto = (re: RegExp) =>
  [...document.querySelectorAll('input')].find((i) => re.test(i.getAttribute('autocomplete') ?? '')) as
    | HTMLInputElement
    | undefined;
const type = (el: HTMLInputElement | undefined, value: string) => {
  expect(el).toBeTruthy();
  fireEvent.change(el as HTMLInputElement, { target: { value } });
};
const emailInput = () => byAuto(/^(username|email)$/);
const submitOf = (el: HTMLInputElement | undefined) => {
  const form = el?.closest('form');
  expect(form).toBeTruthy();
  fireEvent.submit(form as HTMLFormElement);
};
const pick = (name: RegExp) =>
  screen.queryAllByRole('tab', { name })[0] ??
  screen.queryAllByRole('button', { name })[0] ??
  screen.getAllByRole('link', { name })[0];

beforeEach(() => {
  fake.google = true;
  for (const f of Object.values(fake)) if (typeof f === 'function') (f as ReturnType<typeof vi.fn>).mockClear();
});
afterEach(cleanup);

describe('the flowweb.app homepage and login portal', () => {
  it('has one h1, says what FlowWeb is, offers Sign in and Create account, and has no em dash', () => {
    render(<HomePage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByText(/FlowWeb/).length).toBeGreaterThan(0);
    expect(pick(/^Sign in$/)).toBeTruthy();
    expect(pick(/^Create (an )?account$/)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/—/);
  });

  it('signs in with email and a password a password manager can fill', async () => {
    render(<HomePage />);
    const email = emailInput();
    const pw = byAuto(/^current-password$/);
    expect(pw?.type).toBe('password');
    expect(email?.type).toBe('email');
    type(email, EMAIL);
    type(pw, PW);
    submitOf(pw);
    await waitFor(() => expect(fake.signInWithPassword).toHaveBeenCalledWith(EMAIL, PW));
  });

  it('can show the password while typing it', () => {
    render(<HomePage />);
    const pw = byAuto(/^current-password$/);
    fireEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(pw?.type).toBe('text');
  });

  it('creates an account with a new password and says to check email', async () => {
    render(<HomePage />);
    fireEvent.click(pick(/^Create (an )?account$/));
    const pw = byAuto(/^new-password$/);
    expect(pw?.type).toBe('password');
    type(emailInput(), EMAIL);
    type(pw, PW);
    submitOf(pw);
    await waitFor(() => expect(fake.signUp).toHaveBeenCalledWith(EMAIL, PW));
    expect(await screen.findByText(/check your email/i)).toBeTruthy();
  });

  it('emails a sign-in link', async () => {
    render(<HomePage />);
    type(emailInput(), EMAIL);
    fireEvent.click(screen.getByRole('button', { name: /email me a (sign-in )?link/i }));
    await waitFor(() => expect(fake.sendLink).toHaveBeenCalledWith(EMAIL));
    expect(await screen.findByText(/check your email/i)).toBeTruthy();
  });

  it('continues with Google, and hides Google when it is not set up', async () => {
    render(<HomePage />);
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(fake.signInWithGoogle).toHaveBeenCalled());
    cleanup();
    fake.google = false;
    render(<HomePage />);
    expect(screen.queryByRole('button', { name: /continue with google/i })).toBeNull();
  });

  it('sends a password reset email', async () => {
    render(<HomePage />);
    type(emailInput(), EMAIL);
    fireEvent.click(pick(/forgot/i));
    const email = emailInput();
    if (email && email.value !== EMAIL) type(email, EMAIL);
    submitOf(emailInput());
    await waitFor(() => expect(fake.sendPasswordReset).toHaveBeenCalledWith(EMAIL));
    expect(await screen.findByText(/check your email/i)).toBeTruthy();
  });

  it('shows a failed sign-in in an alert, and shows a notice passed in', async () => {
    fake.signInWithPassword.mockRejectedValueOnce(new Error('That email and password do not match.'));
    render(<HomePage notice="That link has expired." />);
    expect(screen.getByText('That link has expired.')).toBeTruthy();
    type(emailInput(), EMAIL);
    type(byAuto(/^current-password$/), PW);
    submitOf(byAuto(/^current-password$/));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert.textContent).toMatch(/do not match/));
  });

  it('after a reset link lands, asks for a new password and saves it', async () => {
    render(<HomePage recovery />);
    expect(screen.getByRole('heading', { name: /choose a new password/i })).toBeTruthy();
    const pw = byAuto(/^new-password$/);
    expect(pw?.type).toBe('password');
    type(pw, PW);
    submitOf(pw);
    await waitFor(() => expect(fake.setPassword).toHaveBeenCalledWith(PW));
  });
});
