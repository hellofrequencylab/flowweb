import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../mock/fixtures/supervisor.json';
import type { Supervisor } from '../src/api/types';
import { Controls } from '../src/flows/FlowControls';
import { flowSpec } from '../src/flows/flowState';

afterEach(cleanup);

const s = { data_as_of: new Date().toISOString(), ...fixture } as Supervisor;
const show = (sup: Supervisor) => render(<Controls s={sup} reload={() => {}} />);

describe('the flow controls table (the Supervisor folded in)', () => {
  it('names the one gate holding each flow, in words', () => {
    show(s);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('On, nothing due')).toBeTruthy();
    expect(screen.getByText(/Runs up to 4 at once/)).toBeTruthy();
  });

  it("shows each flow's dial", () => {
    show(s);
    for (const f of s.flows) {
      const row = within(screen.getByRole('group', { name: f.name }));
      const on = row.getAllByRole('radio').find((r) => (r as HTMLInputElement).checked);
      expect(on?.getAttribute('value')).toBe(f.dial);
    }
  });

  it('every gate fwd publishes has a word, and the kill switch says so first', () => {
    for (const gate of s.gates) {
      const spec = flowSpec({ ...s.flows[0], state: 'held', gate });
      expect(spec.word).not.toBe('Held');
    }
    show({ ...s, kill_switch: true, paused: true });
    expect(screen.getAllByText(/kill switch is engaged/).length).toBeGreaterThan(0);
  });

  it('an uncapped flow says so, and an unknown spend is never shown as zero', () => {
    const f = s.flows[1];
    const flows = [
      { ...f, key: 'a', name: 'A', budget: { ...f.budget!, max_usd: null } },
      { ...f, key: 'b', name: 'B', budget: { ...f.budget!, spent_usd: null } },
    ];
    show({ ...s, flows });
    expect(screen.getByText(/no cap/)).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'B' })).getByText(/Unknown of/)).toBeTruthy();
  });
});
