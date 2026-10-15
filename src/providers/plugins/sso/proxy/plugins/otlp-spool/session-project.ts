import type { SessionStatus } from './session-status.js';

/** Upper bound on remembered conflicting names; only their existence matters. */
export const MAX_CONFLICT_NAMES = 8;

const blank = (name: string): boolean => name.trim().length === 0;

/** A non-blank name that can travel as an HTTP header value unchanged. */
export function isSendableProjectName(name: string): boolean {
  return !blank(name) && name === name.trim() && /^[\x20-\x7e\xa1-\xff]+$/.test(name);
}

/** String values of `codemie_project_name` at the top level and inside `raw` of a hook event. */
export function hookEventProjectNames(event: unknown): string[] {
  const names: string[] = [];
  const collect = (holder: unknown): void => {
    if (typeof holder !== 'object' || holder === null) return;
    const value = (holder as Record<string, unknown>)['codemie_project_name'];
    if (typeof value === 'string') names.push(value);
  };
  collect(event);
  collect((event as Record<string, unknown> | null)?.['raw']);
  return names;
}

export type ProjectDecision =
  | { action: 'noop' }
  | { action: 'bind'; project: string }
  | { action: 'conflict'; names: string[] };

/**
 * Pure decision over the incoming names plus the stored binding, so a mixed
 * batch is judged as a whole and a later batch against what is already stored.
 */
export function decideProject(names: string[], status: SessionStatus): ProjectDecision {
  if (status.projectConflict) return { action: 'noop' };

  const distinct = new Map<string, string>();
  for (const name of [...(status.project ? [status.project] : []), ...names]) {
    if (blank(name)) continue;
    const key = name.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, name);
  }
  const candidates = [...distinct.values()];

  if (candidates.length > 1 || candidates.some((name) => !isSendableProjectName(name))) {
    return { action: 'conflict', names: candidates };
  }
  if (candidates.length === 1 && !status.project) {
    return { action: 'bind', project: candidates[0] };
  }
  return { action: 'noop' };
}

/** Mutates `status` only; the caller persists it. */
export function applyProjectDecision(status: SessionStatus, decision: ProjectDecision): void {
  if (decision.action === 'bind') {
    status.project = decision.project;
  } else if (decision.action === 'conflict' && !status.projectConflict) {
    status.projectConflict = decision.names.slice(0, MAX_CONFLICT_NAMES);
  }
}

export type ProjectGate =
  | { state: 'bound'; project: string }
  | { state: 'conflict' }
  | { state: 'unbound' };

export function projectGate(status: SessionStatus): ProjectGate {
  if (status.projectConflict) return { state: 'conflict' };
  if (status.project) return { state: 'bound', project: status.project };
  return { state: 'unbound' };
}
