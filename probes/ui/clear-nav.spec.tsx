// The component checks for FW-C-067; run by probes/ui/clear-nav.mjs (not on its own). Tier 0.
// fwd is stood in by a fetch stub that answers every route with an empty envelope.
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveProvider } from '../../packages/web/src/api/live';
import { HoodTabs } from '../../packages/web/src/hood';
import { BottomNav, MorePage, TopNav } from '../../packages/web/src/shell/Nav';
import { RouterProvider } from '../../packages/web/src/shell/router';
import { routeOf } from '../../packages/web/src/shell/routes';

function stubFwd() {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ data: {}, as_of: new Date().toISOString(), head_seq: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function at(path: string, ui: React.ReactNode) {
  history.replaceState(null, '', path);
  stubFwd();
  return render(
    <RouterProvider>
      <LiveProvider>{ui}</LiveProvider>
    </RouterProvider>,
  );
}

const hrefs = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.getAttribute('href'));
const current = (el: HTMLElement) =>
  within(el)
    .getAllByRole('link')
    .filter((a) => a.getAttribute('aria-current') === 'page')
    .map((a) => a.getAttribute('href'));

describe('one clear nav', () => {
  it('the top nav is Today, Inbox, Growth and Under the hood, in that order', () => {
    const { container } = at('/', <TopNav />);
    const nav = within(container).getByRole('navigation', { name: 'Main' });
    expect(hrefs(nav)).toEqual(['/', '/inbox', '/growth', '/hood']);
    const words = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent ?? '');
    ['Today', 'Inbox', 'Growth', 'Under the hood'].forEach((w, i) => expect(words[i]).toContain(w));
    for (const old of ['Console', 'Sign-offs', 'Logs', 'Runs', 'Spend', 'Flows'])
      expect(words.join(' ')).not.toContain(old);
  });

  it('old addresses light the new tab', () => {
    const cases: [string, string][] = [
      ['/table', '/inbox'],
      ['/inbox', '/inbox'],
      ['/flows', '/growth'],
      ['/growth', '/growth'],
      ['/hood', '/hood'],
      ['/ledger', '/hood'],
      ['/ledger/lr_FWC019', '/hood'],
      ['/runs', '/hood'],
      ['/spend', '/hood'],
      ['/projects', '/hood'],
    ];
    for (const [path, tab] of cases) {
      const { container, unmount } = at(path, <TopNav />);
      expect(current(within(container).getByRole('navigation', { name: 'Main' })), path).toEqual([tab]);
      unmount();
    }
  });

  it('the phone tab bar is Today, Inbox, Growth and More, and More holds the rest', () => {
    const { container, unmount } = at('/', <BottomNav />);
    expect(hrefs(within(container).getByRole('navigation', { name: 'Main' }))).toEqual([
      '/',
      '/inbox',
      '/growth',
      '/more',
    ]);
    unmount();
    const page = at('/more', <MorePage />);
    const more = hrefs(page.container);
    for (const to of ['/hood', '/setup', '/settings']) expect(more).toContain(to);
  });

  it('Under the hood has tabs for Logs, Runs, Projects and Spend', () => {
    const { container } = at('/runs', <HoodTabs />);
    const tabs = within(container).getByRole('navigation', { name: 'Under the hood' });
    expect(hrefs(tabs)).toEqual(['/ledger', '/runs', '/projects', '/spend']);
    const words = within(tabs)
      .getAllByRole('link')
      .map((a) => (a.textContent ?? '').trim());
    expect(words).toEqual(['Logs', 'Runs', 'Projects', 'Spend']);
    expect(current(tabs)).toEqual(['/runs']);
  });

  it('every address, old and new, maps to one page', () => {
    const want: Record<string, string | null> = {
      '/': 'today',
      '/inbox': 'inbox',
      '/table': 'inbox',
      '/growth': 'growth',
      '/flows': 'growth',
      '/hood': 'logs',
      '/ledger': 'logs',
      '/runs': 'runs',
      '/spend': 'spend',
      '/projects': 'projects',
      '/settings': 'settings',
      '/setup': 'setup',
      '/more': 'more',
      '/no-such-page': null,
    };
    for (const [path, page] of Object.entries(want)) expect(routeOf(path), path).toBe(page);
  });
});
