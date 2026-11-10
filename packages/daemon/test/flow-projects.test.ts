// A shipped flow's project is created on start and labelled once; the Owner's labels are kept.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelProject, listProjects } from '@fw/ledger';
import { afterEach, expect, test } from 'vitest';
import { REPO_ROOT } from '../src/daemon.ts';
import { flowProjects, registerFlowProjects } from '../src/flows/projects.ts';
import { setFlowEnabled } from '../src/overseer/index.ts';
import { tempHome, withWriter } from './api-fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
const home = () => {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return h.path;
};

test('the activation flow ships as a Frequency marketing project', () => {
  const p = flowProjects(REPO_ROOT).find((x) => x.id === 'prj_frequency1');
  expect(p).toMatchObject({ slug: 'frequency', brand: 'Frequency', category: 'marketing' });
});

test('fwd creates the project once and labels it once', () => {
  const h = home();
  withWriter(h, (w) => {
    expect(registerFlowProjects(w, REPO_ROOT)).toEqual({
      created: ['prj_frequency1'],
      labelled: ['prj_frequency1'],
    });
    expect(registerFlowProjects(w, REPO_ROOT)).toEqual({ created: [], labelled: [] });
    const p = listProjects(w).find((x) => x.id === 'prj_frequency1');
    expect(p).toMatchObject({ name: 'Frequency', brand: 'Frequency', category: 'marketing' });
  });
});

test("the Owner's labels are never overwritten", () => {
  const h = home();
  withWriter(h, (w) => {
    registerFlowProjects(w, REPO_ROOT);
    labelProject(w, 'prj_frequency1', { category: 'sales' });
    registerFlowProjects(w, REPO_ROOT);
    expect(listProjects(w).find((x) => x.id === 'prj_frequency1')?.category).toBe('sales');
  });
});

test('turning the flow on files it under Frequency', () => {
  const h = home();
  withWriter(h, (w) => {
    expect(listProjects(w).some((x) => x.id === 'prj_frequency1')).toBe(false);
    setFlowEnabled(w, REPO_ROOT, 'neighborhood-activation', true);
    expect(listProjects(w).find((x) => x.id === 'prj_frequency1')).toMatchObject({ brand: 'Frequency' });
  });
});

test('a broken project.json is reported and skipped', () => {
  const root = home();
  mkdirSync(join(root, 'flows', 'bad'), { recursive: true });
  writeFileSync(join(root, 'flows', 'bad', 'project.json'), '{"id": "nope"}');
  const warnings: string[] = [];
  expect(flowProjects(root, (m) => warnings.push(m))).toEqual([]);
  expect(warnings[0]).toMatch(/flows\/bad\/project.json/);
});
