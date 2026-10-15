/**
 * Ingest/forwarding interleaving: the decision to send is made under the same lock as the
 * hook append that can introduce a conflicting project. Real spool root and real lock;
 * only fetch, the daemon state and the logger are faked. Ordering uses deferreds, not timers.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ root: '' }));
const readStateMock = vi.hoisted(() => vi.fn());

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
vi.mock('@/cli/commands/proxy/daemon-manager.js', () => ({ readState: readStateMock }));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = 'sess-1';
const credentials = { cookies: { codemie_access_token: 'tok' }, apiUrl: 'https://api', timestamp: 0 };

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function hookLine(project: string): string {
  const event = { type: 'agent.tool.end', session_id: SESSION, codemie_project_name: project };
  return JSON.stringify({ agentName: 'claude-code-otlp', hookEvent: JSON.stringify(event) }) + '\n';
}

describe('project gate — ingest vs forwarding', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    state.root = await mkdtemp(join(tmpdir(), 'otlp-interleave-'));
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    readStateMock.mockResolvedValue({ url: 'http://127.0.0.1:1', targetUrl: 'https://api.example.com' });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(state.root, { recursive: true, force: true });
  });

  /** Session bound to A with hooks and all three OTLP streams pending. */
  async function seedBoundA(): Promise<void> {
    const { appendSpool } = await import('../spool-io.js');
    await appendSpool(SESSION, 'hooks', hookLine('A'), ['A']);
    await appendSpool(SESSION, 'logs', Buffer.from('L'));
    await appendSpool(SESSION, 'metrics', Buffer.from('MM'));
    await appendSpool(SESSION, 'traces', Buffer.from('TTT'));
  }

  async function cursorsAtEof(hooksSize: number): Promise<void> {
    const { readStatus } = await import('../session-status.js');
    expect((await readStatus(SESSION))?.cursors).toEqual({
      hooks: hooksSize,
      logs: 1,
      metrics: 2,
      traces: 3,
    });
  }

  it('A. the queue order is the lock order', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    await seedBoundA();

    // append(B) queued before the snapshot: the snapshot sees the conflict.
    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const append = appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    release.resolve();
    await held;
    await append;
    expect(await snapshot).toBeNull();
  });

  it('A. a snapshot queued before the append sees project A, the append then persists the conflict', async () => {
    const { appendSpool, snapshotPendingBytes } = await import('../spool-io.js');
    const { withSessionLock } = await import('../session-lock.js');
    const { readStatus } = await import('../session-status.js');
    await seedBoundA();

    const release = deferred();
    const held = withSessionLock(SESSION, () => release.promise);
    const snapshot = snapshotPendingBytes(SESSION, 'logs');
    const append = appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    release.resolve();
    await held;
    await append;

    expect(await snapshot).toMatchObject({ project: 'A' });
    expect((await readStatus(SESSION))?.projectConflict).toEqual(['A', 'B']);
  });

  it('B. a request already in flight is the stated limit; nothing else is sent after the conflict', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { forwardSession } = await import('../forwarder.js');
    await seedBoundA();
    const events: string[] = [];
    const started = deferred();
    const response = deferred<{ ok: boolean; status: number }>();
    fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
      events.push(`fetch:${init.headers['X-CodeMie-Project']}`);
      started.resolve();
      return response.promise;
    });

    const pass = forwardSession(SESSION, false, credentials as never);
    await started.promise;
    await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
    events.push('conflict-persisted');
    response.resolve({ ok: true, status: 200 });
    await pass;
    await forwardSession(SESSION, false, credentials as never); // next pass drains B's hook

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['fetch:A', 'conflict-persisted']);
    const hooksSize = Buffer.byteLength(hookLine('A') + hookLine('B'));
    await cursorsAtEof(hooksSize);
  });

  it('C. a conflict persisted between the hooks snapshot and the OTLP snapshots stops all OTLP requests', async () => {
    const { appendSpool } = await import('../spool-io.js');
    const { forwardSession } = await import('../forwarder.js');
    await seedBoundA();
    fetchMock.mockImplementation(async () => {
      await appendSpool(SESSION, 'hooks', hookLine('B'), ['B']);
      return { ok: true, status: 200 };
    });

    await forwardSession(SESSION, false, credentials as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('event-hooks');
  });
});
