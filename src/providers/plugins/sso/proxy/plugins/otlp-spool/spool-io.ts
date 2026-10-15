import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises';
import { logger } from '@/utils/logger.js';
import { sanitizeLogArgs } from '@/utils/security.js';
import { SPOOL_STREAMS, spoolRoot, streamFile, type SpoolStream } from './spool-paths.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatus, writeStatus, type SessionStatus } from './session-status.js';
import {
  applyProjectDecision,
  decideProject,
  hookEventProjectNames,
  projectGate,
} from './session-project.js';

const NEWLINE = 0x0a;

/* ------------------------------------------------------- unlocked internals --- */
// These assume the caller already holds the session lock.

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Range-read everything after `cursor`. Never touches the acknowledged prefix. */
async function readRange(
  sessionId: string,
  stream: SpoolStream,
  cursor: number
): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(streamFile(sessionId, stream), 'r');
  } catch {
    return null; // missing file => nothing pending
  }
  try {
    const { size } = await handle.stat();
    if (size <= cursor) return null; // drained
    const buffer = Buffer.allocUnsafe(size - cursor);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
  } finally {
    await handle.close();
  }
}

/** Project names of every hook on disk, acknowledged prefix included. Malformed lines are skipped. */
async function readHookProjectNames(sessionId: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(streamFile(sessionId, 'hooks'), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const { hookEvent } = JSON.parse(line) as { hookEvent: string };
      names.push(...hookEventProjectNames(JSON.parse(hookEvent)));
    } catch {
      // unusable record: carries no usable project
    }
  }
  return names;
}

/**
 * Legacy recovery: scan the hooks already on disk once and bind or conflict.
 * Mutates `status` only (caller holds the lock and does the single write).
 */
export async function resolveLegacyProjectLocked(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  applyProjectDecision(status, decideProject(await readHookProjectNames(sessionId), status));
  status.projectScanned = true;
}

/**
 * Drop the unsent backlog locally: every cursor to EOF. Frees no disk — the sweeper
 * removes the files once the session is drained and idle. Mutates `status` only.
 */
export async function discardBacklogLocked(
  sessionId: string,
  status: SessionStatus
): Promise<boolean> {
  let changed = false;
  for (const stream of SPOOL_STREAMS) {
    try {
      const { size } = await stat(streamFile(sessionId, stream));
      if (size > status.cursors[stream]) {
        status.cursors[stream] = size;
        changed = true;
      }
    } catch {
      // missing file: nothing to discard
    }
  }
  return changed;
}

/**
 * Snapshot-side gate. Caller holds the lock. Returns the bound project, or `null`
 * after discarding the unsent backlog (conflicted or unbound session). Persists
 * the status once when anything changed.
 */
async function gateProjectLocked(sessionId: string, status: SessionStatus): Promise<string | null> {
  let dirty = false;
  if (!status.projectScanned && (await fileExists(streamFile(sessionId, 'hooks')))) {
    await resolveLegacyProjectLocked(sessionId, status);
    dirty = true;
  }

  const gate = projectGate(status);
  if (gate.state === 'bound') {
    if (dirty) await writeStatus(sessionId, status);
    return gate.project;
  }

  if ((await discardBacklogLocked(sessionId, status)) || dirty) {
    await writeStatus(sessionId, status);
    logger.debug(
      '[otlp-spool] discarded unsent backlog: session project is not sendable',
      ...sanitizeLogArgs({ sessionId, state: gate.state })
    );
  }
  return null;
}

/** Locked check that the session is still bound to `project` (case-insensitive) and unconflicted. */
export async function isProjectStillSendable(sessionId: string, project: string): Promise<boolean> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return false;
    const gate = projectGate(status);
    return gate.state === 'bound' && gate.project.toLowerCase() === project.toLowerCase();
  });
}

/* --------------------------------------------------------------- producers --- */

/**
 * Append spool bytes and make the session discoverable.
 *
 * Holds the session lock so an append can never interleave with a forwarder
 * snapshot (torn record), a cursor advance, or a sweep deletion.
 */
export async function appendSpool(
  sessionId: string,
  stream: SpoolStream,
  data: string | Buffer,
  projectNames?: string[]
): Promise<void> {
  await withSessionLock(sessionId, async () => {
    await mkdir(spoolRoot(), { recursive: true });

    const path = streamFile(sessionId, stream);
    const exists = await fileExists(path);
    const recreated = !exists;

    if (stream === 'hooks' && projectNames) {
      // Observe and decide in the same critical section as the append. The status is
      // written BEFORE the bytes: a failed append leaves a conservative status and
      // the hook client retries the same batch.
      const status = (await readStatus(sessionId)) ?? createStatus();
      if (!status.projectScanned) {
        if (exists) {
          await resolveLegacyProjectLocked(sessionId, status);
        } else {
          status.projectScanned = true;
        }
      }
      applyProjectDecision(status, decideProject(projectNames, status));
      if (recreated) status.cursors.hooks = 0;
      await writeStatus(sessionId, status);
      await appendFile(path, data);
      return;
    }

    await appendFile(path, data);

    const status = await readStatus(sessionId);
    if (!status) {
      await writeStatus(sessionId, createStatus());
      return;
    }
    // A recreated file restarts at offset 0, so a cursor left over from a swept
    // (or partially deleted) session would otherwise skip these bytes forever.
    if (recreated && status.cursors[stream] !== 0) {
      status.cursors[stream] = 0;
      await writeStatus(sessionId, status);
    }
  });
}

/* --------------------------------------------------------------- consumers --- */

export interface PendingBytes {
  /** Project the session is bound to; sent as `X-CodeMie-Project`. */
  project: string;
  /** Cursor the snapshot was taken from — pass it back when acknowledging. */
  cursor: number;
  bytes: Buffer;
}

/**
 * Consistent snapshot of the bytes pending for an OTEL stream.
 *
 * The lock guarantees the snapshot never contains a partially written append,
 * so the protobuf payload handed to the backend is always whole.
 * Must NOT be called while already holding the session lock.
 */
export async function snapshotPendingBytes(
  sessionId: string,
  stream: SpoolStream
): Promise<PendingBytes | null> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return null; // session was swept
    const project = await gateProjectLocked(sessionId, status);
    if (!project) return null;
    const cursor = status.cursors[stream];
    const bytes = await readRange(sessionId, stream, cursor);
    return bytes ? { project, cursor, bytes } : null;
  });
}

export interface PendingHookBatch {
  /** Project the session is bound to; sent as `X-CodeMie-Project`. */
  project: string;
  cursor: number;
  /** Complete, newline-terminated NDJSON records. */
  records: string[];
  /** Exact number of source bytes these records occupy, including newlines. */
  byteLength: number;
}

/**
 * Consistent snapshot of the complete NDJSON records pending for hooks.
 *
 * The chunk is cut at the last newline byte, so an incomplete trailing record
 * stays pending and `byteLength` is a byte-exact acknowledgement amount.
 * Cutting on a newline is safe for UTF-8: `0x0a` cannot occur inside a
 * multi-byte sequence.
 * Must NOT be called while already holding the session lock.
 */
export async function snapshotPendingHookRecords(
  sessionId: string
): Promise<PendingHookBatch | null> {
  return withSessionLock(sessionId, async () => {
    const status = await readStatus(sessionId);
    if (!status) return null;
    const project = await gateProjectLocked(sessionId, status);
    if (!project) return null;

    const cursor = status.cursors.hooks;
    const pending = await readRange(sessionId, 'hooks', cursor);
    if (!pending) return null;

    const lastNewline = pending.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return null; // no complete record yet

    const complete = pending.subarray(0, lastNewline + 1);
    const records = complete
      .toString('utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0);

    return { project, cursor, records, byteLength: complete.length };
  });
}
