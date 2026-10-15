/**
 * Pure project resolution and the persisted binding/conflict fields.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});

import {
  applyProjectDecision,
  decideProject,
  hookEventProjectNames,
  isSendableProjectName,
  projectGate,
} from '../session-project.js';
import { createStatus, type SessionStatus } from '../session-status.js';

const withProject = (project: string): SessionStatus => ({ ...createStatus(), project });

describe('decideProject', () => {
  it('is a noop without names', () => {
    expect(decideProject([], createStatus())).toEqual({ action: 'noop' });
  });

  it('binds a single name', () => {
    expect(decideProject(['A'], createStatus())).toEqual({ action: 'bind', project: 'A' });
  });

  it('treats the same name in another case as one project and keeps the first spelling', () => {
    expect(decideProject(['A', 'a'], createStatus())).toEqual({ action: 'bind', project: 'A' });
  });

  it('flags a conflict for two projects in one call, even though A is first', () => {
    expect(decideProject(['A', 'B'], createStatus())).toEqual({
      action: 'conflict',
      names: ['A', 'B'],
    });
  });

  it('flags a conflict for a stored binding plus a different name', () => {
    expect(decideProject(['B'], withProject('A'))).toEqual({
      action: 'conflict',
      names: ['A', 'B'],
    });
  });

  it('ignores blank names next to a stored binding', () => {
    expect(decideProject(['', '  '], withProject('A'))).toEqual({ action: 'noop' });
  });

  it('is a noop for the stored binding in another case', () => {
    expect(decideProject(['a'], withProject('A'))).toEqual({ action: 'noop' });
  });

  it('is a noop once a conflict is stored', () => {
    const status = { ...createStatus(), projectConflict: ['A', 'B'] };
    expect(decideProject(['C'], status)).toEqual({ action: 'noop' });
  });

  it.each([[' A'], ['A\n'], ['Проект']])('treats %j as a conflict on its own', (name) => {
    expect(decideProject([name], createStatus())).toEqual({ action: 'conflict', names: [name] });
  });

  it('ignores blank names when nothing is bound', () => {
    expect(decideProject(['', ' '], createStatus())).toEqual({ action: 'noop' });
  });
});

describe('applyProjectDecision / projectGate', () => {
  it('bind, conflict and unbound states', () => {
    const status = createStatus();
    expect(projectGate(status)).toEqual({ state: 'unbound' });

    applyProjectDecision(status, { action: 'bind', project: 'A' });
    expect(projectGate(status)).toEqual({ state: 'bound', project: 'A' });

    applyProjectDecision(status, { action: 'conflict', names: ['A', 'B'] });
    expect(projectGate(status)).toEqual({ state: 'conflict' });
    expect(status.project).toBe('A');
  });

  it('keeps a conflict set-once', () => {
    const status = createStatus();
    applyProjectDecision(status, { action: 'conflict', names: ['A', 'B'] });
    applyProjectDecision(status, { action: 'conflict', names: ['C', 'D'] });
    expect(status.projectConflict).toEqual(['A', 'B']);
  });
});

describe('isSendableProjectName / hookEventProjectNames', () => {
  it('accepts plain header-safe names only', () => {
    expect(isSendableProjectName('My Project-1')).toBe(true);
    expect(isSendableProjectName('')).toBe(false);
    expect(isSendableProjectName('  ')).toBe(false);
    expect(isSendableProjectName(' A')).toBe(false);
    expect(isSendableProjectName('A\u0000')).toBe(false);
    expect(isSendableProjectName('Проект')).toBe(false);
  });

  it('collects top-level and raw names', () => {
    expect(
      hookEventProjectNames({ codemie_project_name: 'A', raw: { codemie_project_name: 'B' } })
    ).toEqual(['A', 'B']);
    expect(hookEventProjectNames({ codemie_project_name: 5, raw: 'x' })).toEqual([]);
    expect(hookEventProjectNames(null)).toEqual([]);
  });
});

describe('status persistence', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-project-'));
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it('keeps all three fields across readStatus -> advanceCursor -> readStatus', async () => {
    const { readStatus, writeStatus, advanceCursor } = await import('../session-status.js');
    await writeStatus('s1', {
      ...createStatus(),
      project: 'A',
      projectConflict: ['A', 'B'],
      projectScanned: true,
    });

    await advanceCursor('s1', 'hooks', 7);

    const status = await readStatus('s1');
    expect(status).toMatchObject({
      project: 'A',
      projectConflict: ['A', 'B'],
      projectScanned: true,
    });
    expect(status?.cursors.hooks).toBe(7);
  });

  it('drops malformed project fields', async () => {
    const { readStatus } = await import('../session-status.js');
    await writeFile(
      join(state.root, 's2.status'),
      JSON.stringify({ cursors: {}, project: '', projectConflict: [1, 'A'], projectScanned: 'yes' })
    );
    const status = await readStatus('s2');
    expect(status?.project).toBeUndefined();
    expect(status?.projectConflict).toBeUndefined();
    expect(status?.projectScanned).toBeUndefined();
  });
});
