import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Targeting } from '../src/api/client';
import { isCopyKey } from '../src/flows/FlowCopyPage';
import { TargetingEditor } from '../src/flows/TargetingEditor';

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
const KEY = 'neighborhood-activation--coaches-guides';
const URL = `/v1/flows/${KEY}/targeting`;

const targeting = (over: Partial<Targeting> = {}): Targeting => ({
  key: KEY,
  has_playbook: true,
  playbook: {
    seek: 'Coaches who host.',
    signals: '',
    where: '',
    queries: '',
    skip: '',
    rank: '',
    record: '',
    note: 'Warm and short.',
  },
  link_line: 'Start here:',
  door: '/for/coaches-and-healers',
  niches: [
    {
      key: 'coaching',
      label: 'Coaches',
      door: null,
      angles: [
        { key: 'fill_room', line: 'Filling a room is hard.' },
        { key: 'come_back', line: 'People do not come back.' },
      ],
    },
  ],
  ...over,
});

function stubFwd(saved: Targeting) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const data = method === 'POST' ? saved : targeting();
    return new Response(JSON.stringify({ data, as_of: '2026-11-18T12:00:00Z', head_seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TargetingEditor', () => {
  it('saves only the lines that changed, and a kept angle keeps its key', async () => {
    stubFwd(targeting({ playbook: { ...targeting().playbook, seek: 'Guides who host weekly.' } }));
    render(<TargetingEditor flow={KEY} />);
    const seek = (await screen.findByLabelText(/Who to look for/)) as HTMLTextAreaElement;
    expect(seek.value).toBe('Coaches who host.');
    expect(screen.getByText('The link opens /for/coaches-and-healers on Frequency.')).toBeTruthy();
    fireEvent.change(seek, { target: { value: 'Guides who host weekly.' } });
    fireEvent.change(screen.getByLabelText(/Reasons to care: Coaches/), {
      target: { value: 'People do not come back.\nA new reason.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. The next run uses it.')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe(URL);
    expect(post?.body).toEqual({
      playbook: { seek: 'Guides who host weekly.' },
      niches: {
        coaching: {
          angles: [{ key: 'come_back', line: 'People do not come back.' }, { line: 'A new reason.' }],
        },
      },
    });
  });

  it('sends nothing when nothing changed', async () => {
    stubFwd(targeting());
    render(<TargetingEditor flow={KEY} />);
    await screen.findByLabelText(/Who to look for/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing to save.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('knows a copy key from a base key', () => {
    expect(isCopyKey(KEY)).toBe(true);
    expect(isCopyKey('neighborhood-activation')).toBe(false);
    expect(isCopyKey(undefined)).toBe(false);
  });
});
