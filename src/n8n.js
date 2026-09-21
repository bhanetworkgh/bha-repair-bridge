/**
 * The n8n public API, as this bridge uses it.
 *
 * Four calls: read a workflow, read an execution with its data, retry an
 * execution, and list a workflow's executions (only as the fallback for a retry
 * that did not say which execution it started).
 *
 * The bridge itself never edits a workflow. The only thing that changes a
 * workflow in this repair loop is Claude Code, through its own curl calls, and
 * only when DRY_RUN is off. This module stays read-plus-retry so that rule is
 * visible in one file rather than argued about across several.
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

/** A workflow's executions, newest first. Only used to find a retry that did not name itself. */
export async function executionsFor(workflowId, limit = 10) {
  const r = await call(`/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${limit}&includeData=false`);
  return Array.isArray(r?.data) ? r.data : [];
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
