import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ hosted: false }));
vi.mock('../src/hosted/auth', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  get HOSTED() {
    return mode.hosted;
  },
}));

import { Button, MAC_ONLY, macOnlyReason } from '../src/ui-kit/Button';

afterEach(cleanup);

describe('Mac-only actions', () => {
  it('give a reason only on the site', () => {
    mode.hosted = false;
    expect(macOnlyReason()).toBeNull();
    mode.hosted = true;
    expect(macOnlyReason()).toBe(MAC_ONLY);
    expect(macOnlyReason(false)).toBeNull();
  });

  it('a macOnly button on the site keeps its own reason off the Mac reason', () => {
    mode.hosted = true;
    render(
      <Button macOnly disabledReason="Something else">
        Go
      </Button>,
    );
    expect(screen.getByText(MAC_ONLY)).toBeTruthy();
    expect(screen.queryByText('Something else')).toBeNull();
  });

  it('on the Mac a macOnly button falls back to its own reason', () => {
    mode.hosted = false;
    render(
      <Button macOnly disabledReason="Something else">
        Go
      </Button>,
    );
    expect(screen.getByText('Something else')).toBeTruthy();
  });
});
