import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../mock/fixtures/supervisor.json';
import type { Supervisor } from '../src/api/types';
import { flowSpec, SupervisorFlows } from '../src/flows/SupervisorPanel';

afterEach(cleanup);

const s = { data_as_of: new Date().toISOString(), ...fixture } as Supervisor;

describe('the Supervisor panel', () => {
  it('names the one gate holding each flow, in words', () => {
    render(<SupervisorFlows s={s} />);
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('On, nothing due')).toBeTruthy();
    expect(screen.getByText(/Runs up to 4 at once/)).toBeTruthy();
  });

  it('every gate fwd publishes has a word, and the kill switch says so first', () => {
    for (const gate of s.gates) {
      const spec = flowSpec({ ...s.flows[0], state: 'held', gate });
      expect(spec.word).not.toBe('Held');
    }
    render(<SupervisorFlows s={{ ...s, kill_switch: true, paused: true }} />);
    expect(screen.getByText(/kill switch is engaged/)).toBeTruthy();
  });

  it('an uncapped flow says so, and an unknown spend is never shown as zero', () => {
    const f = s.flows[1];
    const flows = [
      { ...f, key: 'a', name: 'A', budget: { ...f.budget!, max_usd: null } },
      { ...f, key: 'b', name: 'B', budget: { ...f.budget!, spent_usd: null } },
    ];
    render(<SupervisorFlows s={{ ...s, flows }} />);
    expect(screen.getByText(/no cap/)).toBeTruthy();
    expect(screen.getByText(/^Unknown of/)).toBeTruthy();
  });
});
