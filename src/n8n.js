/**
 * The n8n public API, as this bridge uses it.
 *
 * Reads: a workflow, an execution with its data, and a workflow's executions
 * (only as the fallback for a retry that did not say which execution it
 * started). Two writes, both narrow: retrying the failed execution, and putting
 * a workflow's active state back.
 *
 * **The bridge never edits a workflow's content.** That is Claude Code's job,
 * through the two helper scripts, and only when DRY_RUN is off. The one thing
 * this module writes is `active` — and only ever back to what it was before a
 * repair started (22 Sep 2026, after three North Star workflows came out of an
 * interrupted repair switched off). Restoring is not editing: it is undoing a
 * change nobody asked for.
 */
import { env, n8nApiBase, n8nTimeoutMs } from './config.js';

export class N8nError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'N8nError';
    this.status = status ?? 0;
  }
}

function requireConfig() {
  const base = n8nApiBase();
  const key = env('N8N_API_KEY');
  if (!base) throw new N8nError('N8N_BASE_URL is not set, so n8n cannot be reached.', 0);
  if (!key) throw new N8nError('N8N_API_KEY is not set, so n8n cannot be reached.', 0);
  return { base, key };
}

async function call(path, { method = 'GET', body } = {}) {
  const { base, key } = requireConfig();
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-N8N-API-KEY': key,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(n8nTimeoutMs()),
    });
  } catch (e) {
    throw new N8nError(`${method} ${path} could not reach n8n: ${e instanceof Error ? e.message : String(e)}`, 0);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new N8nError(`${method} ${path} answered ${res.status}: ${raw.slice(0, 400)}`, res.status);
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new N8nError(`${method} ${path} answered ${res.status} with something that is not JSON: ${raw.slice(0, 200)}`, res.status);
  }
}

/** One workflow, whole — nodes, connections, settings and the versionId a repair is measured by. */
export async function workflow(id) {
  return call(`/workflows/${encodeURIComponent(id)}`);
}

/** One execution, with its run data, which is where the failed node's input and output live. */
export async function execution(id, { includeData = true } = {}) {
  return call(`/executions/${encodeURIComponent(id)}?includeData=${includeData ? 'true' : 'false'}`);
}

/**
 * Retries an execution, loading the workflow as it now stands — which is the
 * whole point: the retry is the test of the repair.
 *
 * n8n's answer to this call is not one shape across versions. It may be the new
 * execution, or an id, or a bare boolean. The caller is told which it got rather
 * than being handed a guess.
 */
export async function retryExecution(id) {
  const answer = await call(`/executions/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { loadWorkflow: true } });
  if (answer && typeof answer === 'object' && (answer.id || answer.executionId)) {
    return { started: true, executionId: String(answer.id ?? answer.executionId), answer };
  }
  if (typeof answer === 'string' || typeof answer === 'number') {
    return { started: true, executionId: String(answer), answer };
  }
  return { started: Boolean(answer), executionId: null, answer };
}

/**
 * Switches a workflow back on, or off.
 *
 * n8n's public API has dedicated endpoints for this — a PUT of the workflow
 * body ignores `active` entirely — so this is the only way to put the state
 * back, and it touches nothing else about the workflow.
 */
export async function setActive(id, active) {
  const path = `/workflows/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`;
  return call(path, { method: 'POST' });
}

/** A workflow's executions, newest first. Only used to find a retry that did not name itself. */
export async function executionsFor(workflowId, limit = 10) {
  const r = await call(`/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}&includeData=false`);
  return Array.isArray(r?.data) ? r.data : [];
}

/**
 * A workflow's executions that started after `sinceMs`, oldest first.
 *
 * n8n lists newest first and its public API has no "started after" filter, so
 * this pages back with the cursor until it passes `sinceMs` (26 Sep 2026: how an
 * agent-called workflow's fix is proved — see `verify.js`).
 */
export async function executionsSince(workflowId, sinceMs, { maxPages = 5, pageSize = 100 } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ workflowId: String(workflowId), limit: String(pageSize), includeData: 'false' });
    if (cursor) q.set('cursor', cursor);
    const r = await call(`/executions?${q.toString()}`);
    const data = Array.isArray(r?.data) ? r.data : [];
    let passed = false;
    for (const e of data) {
      const t = Date.parse(e?.startedAt ?? '');
      if (Number.isFinite(t) && t <= sinceMs) passed = true;
      else if (Number.isFinite(t)) out.push(e);
    }
    cursor = r?.nextCursor ?? null;
    if (passed || !cursor) break;
  }
  return out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** The statuses that mean an execution is over. Anything else is still running. */
const FINAL = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled', 'failed', 'warning']);

export function isFinal(status) {
  return FINAL.has(String(status || '').toLowerCase());
}

export function succeeded(status) {
  const s = String(status || '').toLowerCase();
  return s === 'success' || s === 'warning';
}

/**
 * Waits for one execution to finish.
 *
 * Returns what it knows rather than what it hopes: a wait that ran out says so,
 * and a timed-out retry is never read as a success.
 */
export async function waitForExecution(id, { timeoutMs, pollMs = 5000, onPoll } = {}) {
  const deadline = Date.now() + (timeoutMs ?? 5 * 60 * 1000);
  let last = null;
  for (;;) {
    try {
      last = await execution(id, { includeData: false });
      if (last && isFinal(last.status)) {
        return { done: true, status: String(last.status), execution: last, timedOut: false };
      }
    } catch (e) {
      // A read that failed is not a verdict. Keep waiting until the deadline;
      // if it never answers, the caller gets timedOut and nothing is assumed.
      if (onPoll) onPoll(`execution ${id} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Date.now() >= deadline) {
      return { done: false, status: last ? String(last.status ?? 'unknown') : 'unknown', execution: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
