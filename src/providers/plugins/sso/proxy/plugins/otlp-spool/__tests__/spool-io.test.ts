/**
 * Spool I/O: atomic hook ingest with project binding, and the locked snapshots.
 * Real temp spool root, real session lock.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));

vi.mock('../spool-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spool-paths.js')>();
  const { join: pathJoin } = await import('node:path');
  return {
    ...actual,
    spoolRoot: (): string => state.root,
    streamFile: (sessionId: string, stream: string): string => {
      const ext: Record<string, string> = {
        hooks: '.hooks.ndjson',
        logs: '.otel_logs.bin',
        metrics: '.otel_metrics.bin',
        traces: '.otel_traces.bin',
      };
      return pathJoin(state.root, sessionId + ext[stream]);
    },
    statusFile: (sessionId: string): string => pathJoin(state.root, sessionId + '.status'),
  };
});

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'sess-1';

/** One spool line as the daemon stores it: envelope around the wire event. */
function hookLine(project?: string): string {
  const event: Record<string, unknown> = { type: 'agent.tool.end', session_id: SESSION };
  if (project !== undefined) event['codemie_project_name'] = project;
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(event) }) + '\n';
}

const file = (name: string): string => join(state.root, `${SESSION}.${name}`);

describe('appendSpool — project binding', () => {
  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-spool-io-'));
  });
  afterEach(async () => {
    await rm(state.root, { recursive: true, force: true });
  });

  it('records a conflict for a mixed first batch and binds nothing', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'hooks', hookLine('A') + hookLine('B'), ['A', 'B']);

    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.project).toBeUndefined();
  });

  it('records a late conflict after the cursor advanced over bound hooks', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, advanceCursor } = await import('../session-status.js');

    const first = hookLine('A');
    await appendSpool(SESSION, 'hooks', first, ['A']);
    await advanceCursor(SESSION, 'hooks', Buffer.byteLength(first));
    expect((await readStatus(SESSION))?.project).toBe('A');

    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    const status = await readStatus(SESSION);
    expect(status?.projectConflict).toEqual(['A', 'B']);
    expect(status?.cursors.hooks).toBe(Buffer.byteLength(first));
  });

  it('keeps the binding and the conflict across a restart', async () => {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);

    vi.resetModules();
    let { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.project).toBe('A');

    const io = await import('../spool-io.js');
    await io.appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);

    vi.resetModules();
    ({ readStatus } = await import('../session-status.js'));
    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
  });

  it('treats another case as the same project, keeps the first spelling, ignores blanks', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'hooks', hookLine(''), ['', '  ']);
    let status = await readStatus(SESSION);
    expect(status?.project).toBeUndefined();
    expect(status?.projectConflict).toBeUndefined();

    await appendSpool(SESSION, 'hooks', hookLine('Alpha'), ['Alpha']);
    await appendSpool(SESSION, 'hooks', hookLine('ALPHA'), ['ALPHA', '']);
    status = await readStatus(SESSION);
    expect(status?.project).toBe('Alpha');
    expect(status?.projectConflict).toBeUndefined();
  });

  describe('legacy session (status without projectScanned, hooks file present)', () => {
    async function seedLegacy(lines: string): Promise<void> {
      const { writeStatus, createStatus } = await import('../session-status.js');
      await writeFile(file('hooks.ndjson'), lines);
      await writeStatus(SESSION, createStatus());
    }

    it('binds the single project found on disk and persists it', async () => {
      await seedLegacy(hookLine('A') + hookLine('a'));
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);

      const status = await readStatus(SESSION);
      expect(status).toMatchObject({ project: 'A', projectScanned: true });
      expect(status?.projectConflict).toBeUndefined();
    });

    it('records a conflict when the disk holds two projects', async () => {
      await seedLegacy(hookLine('A') + hookLine('B'));
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);

      expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
    });

    it('stays unbound for blank names and never rescans', async () => {
      await seedLegacy(hookLine('') + hookLine());
      const { appendSpool } = await import('../spool-io.js');
      const { readStatus } = await import('../session-status.js');

      await appendSpool(SESSION, 'hooks', hookLine(), []);
      let status = await readStatus(SESSION);
      expect(status?.projectScanned).toBe(true);
      expect(status?.project).toBeUndefined();
      expect(status?.projectConflict).toBeUndefined();

      await appendFile(file('hooks.ndjson'), hookLine('A') + hookLine('B'));
      await appendSpool(SESSION, 'hooks', hookLine(), []);
      status = await readStatus(SESSION);
      expect(status?.project).toBeUndefined();
      expect(status?.projectConflict).toBeUndefined();
    });
  });

  it('still appends the hook bytes on conflict and resets the cursor of a recreated file', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus, writeStatus, createStatus } = await import('../session-status.js');
    await appendSpool(SESSION, 'hooks', hookLine('A') + hookLine('B'), ['A', 'B']);
    const before = Buffer.byteLength(hookLine('A') + hookLine('B'));

    await appendSpool(SESSION, 'hooks', hookLine('C'), ['C']);

    const { readFile } = await import('node:fs/promises');
    expect((await readFile(file('hooks.ndjson'))).length).toBe(before + Buffer.byteLength(hookLine('C')));

    await rm(file('hooks.ndjson'));
    const status = (await readStatus(SESSION)) ?? createStatus();
    status.cursors.hooks = 999;
    await writeStatus(SESSION, status);

    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);

    expect((await readStatus(SESSION))?.cursors.hooks).toBe(0);
  });

  it('keeps the OTEL append path unchanged', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { readStatus } = await import('../session-status.js');

    await appendSpool(SESSION, 'logs', Buffer.from('abc'));

    const status = await readStatus(SESSION);
    expect(status?.cursors).toEqual({ hooks: 0, logs: 0, metrics: 0, traces: 0 });
    expect(status?.projectScanned).toBeUndefined();
  });
});
