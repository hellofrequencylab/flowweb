// FW-C-123: the agent roster and the Owner's teams.
import { expect, test } from 'vitest';
import { teamKeyOf, teamView } from '../src/team/index.ts';

const ceo = (t: { members: { level: string; name: string }[] }) => t.members.find((m) => m.level === 'ceo');

test('the main team is Kevin, a brand team gets its own CEO preset or the default', () => {
  const { teams } = teamView({}, ['Frequency', 'Sunrise Yoga']);
  expect(teams.map((t) => t.key)).toEqual(['main', 'frequency', 'sunrise-yoga']);
  expect(ceo(teams[0]!)?.name).toBe('Kevin');
  expect(ceo(teams[1]!)?.name).toBe('Juniper');
  expect(ceo(teams[2]!)?.name).toBe('Kevin');
  expect(teamKeyOf('  Sunrise Yoga! ')).toBe('sunrise-yoga');
});

test('overrides apply to one team only and keep the defaults visible', () => {
  const { teams } = teamView({ teams: { frequency: { editor: { name: 'Red', voice: 'Short.' } } } }, [
    'Frequency',
  ]);
  const ed = (i: number) => teams[i]!.members.find((m) => m.id === 'editor');
  expect(ed(1)).toMatchObject({ name: 'Red', voice: 'Short.', default_name: 'The Editor' });
  expect(ed(0)?.name).toBe('The Editor');
});

test('a flow on puts its manager, its chief and the staff to work', () => {
  const st = (flows: string[], id: string) =>
    teamView({}, [], flows).teams[0]!.members.find((m) => m.id === id)?.status;
  expect(st([], 'connector')).toBe('bench');
  expect(st([], 'scout')).toBe('bench');
  expect(st([], 'ceo')).toBe('working');
  expect(st(['host-moments'], 'mentor')).toBe('working');
  expect(st(['host-moments'], 'cmo')).toBe('working');
  expect(st(['host-moments'], 'scout')).toBe('working');
  expect(st(['host-moments'], 'connector')).toBe('bench');
  expect(st(['host-moments'], 'cfo')).toBe('bench');
});
