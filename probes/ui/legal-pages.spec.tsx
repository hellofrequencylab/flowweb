// The component checks for FW-C-090; run by probes/ui/legal-pages.mjs (not on its own). Tier 0.
// hosted/auth is stood in by spies, so nothing here reaches an auth server.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../packages/web/src/hosted/auth', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const ok = vi.fn(async () => undefined);
  return {
    ...real,
    HOSTED: true,
    authMethods: { password: true, link: true, google: true },
    accessToken: async () => null,
    signedInEmail: () => null,
    signInWithPassword: ok,
    signUp: vi.fn(async () => ({ needsConfirm: true })),
    sendLink: ok,
    signInWithGoogle: ok,
    sendPasswordReset: ok,
    setPassword: ok,
  };
});

import { HomePage } from '../../packages/web/src/home/HomePage';
import { LegalPage, legalRouteOf } from '../../packages/web/src/legal/Legal';

afterEach(cleanup);

const hrefs = () => [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
const text = () => document.body.textContent ?? '';

describe('terms and privacy on flowweb.app', () => {
  it('maps /terms and /privacy, with or without a trailing slash, and nothing else', () => {
    expect(legalRouteOf('/terms')).toBe('terms');
    expect(legalRouteOf('/terms/')).toBe('terms');
    expect(legalRouteOf('/privacy')).toBe('privacy');
    expect(legalRouteOf('/privacy/')).toBe('privacy');
    expect(legalRouteOf('/')).toBeNull();
    expect(legalRouteOf('/settings')).toBeNull();
    expect(legalRouteOf('/terms/extra')).toBeNull();
  });

  for (const page of ['terms', 'privacy'] as const) {
    it(`the ${page} page has one h1, a date, a contact, links to the other page and home, and no em dash`, () => {
      render(<LegalPage page={page} />);
      const h1 = screen.getAllByRole('heading', { level: 1 });
      expect(h1).toHaveLength(1);
      expect(h1[0].textContent).toMatch(page === 'terms' ? /Terms of Service/i : /Privacy Policy/i);
      expect(text()).toMatch(/Last updated/i);
      const links = hrefs();
      expect(links.some((h) => h.startsWith('mailto:'))).toBe(true);
      expect(links).toContain(page === 'terms' ? '/privacy' : '/terms');
      expect(links).toContain('/');
      expect(text()).not.toMatch(/—/);
    });
  }

  it('the privacy page covers Google sign-in, Supabase, business accounts, drafts only and deletion', () => {
    render(<LegalPage page="privacy" />);
    const t = text();
    for (const re of [/Google/, /\bname\b/i, /\bemail\b/i, /Supabase/, /business accounts?/i, /drafts?/i, /delet/i])
      expect(t).toMatch(re);
  });

  it('the terms page says FlowWeb writes drafts and you send them', () => {
    render(<LegalPage page="terms" />);
    const t = text();
    expect(t).toMatch(/drafts?/i);
    expect(t).toMatch(/you send/i);
  });

  it('the signed-out homepage links to both pages', () => {
    render(<HomePage />);
    const links = hrefs();
    expect(links).toContain('/terms');
    expect(links).toContain('/privacy');
  });
});
