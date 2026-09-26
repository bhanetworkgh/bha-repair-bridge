/**
 * Proof for a workflow whose input was chosen by its caller (26 Sep 2026).
 *
 * **What happened.** `Bays — Post Loop Digest` is a tool the Bays agent calls.
 * At 12:02:04Z the agent called it with an empty input (execution 18124, mode
 * `integrated`, `parentAgentRun` set) and it threw. Nine seconds later, in the
 * same agent run, the agent called it again with real inputs and it passed
 * (18129). The repair found the real root cause and fixed it (cee8afc1) — then
 * "verified" by retrying 18124. A retry replays the same empty input, so it
 * failed again (18135), the row said `not_repaired`, and a person was asked to
 * check something four later real runs had already shown.
 *
 * So, for an execution another agent or workflow called:
 *
 * - **Retrying it is not proof.** It replays the caller's bad input and tests
 *   nothing about the fix. The proof is a later real run: a successful
 *   execution that started after the new version was published.
 * - **A later failure counts against the fix only when it fails the same way**
 *   — the same node, the same message. A different failure is a different
 *   problem, and is not this repair's verdict.
 * - **A refusal is not a pass.** A workflow that answers a bad call with
 *   `ok: false` instead of throwing (Post Loop Digest does, since 189849ca)
 *   ends as `success` having done nothing. Such a run is counted as neither.
 *
 * Workflows started by their own trigger keep the retry: their input is the
 * event that fired them, so replaying it is a real test.
 */
import * as n8n from './n8n.js';

/** Modes that are not real traffic: the healer's own retries, and a person pressing Run. */
const NOT_REAL = new Set(['retry', 'manual']);

/** How far after a failure a success still counts as "the agent recovered on its own". */
const SAME_RUN_WINDOW_MS = 30 * 60 * 1000;

/** How many candidate executions are read whole in one check, so a busy workflow cannot turn a check into a crawl. */
const MAX_READS = 15;

const startOf = (e) => {
  const t = Date.parse(e?.startedAt ?? '');
  return Number.isFinite(t) ? t : null;
};

/**
 * Who called an execution, as n8n recorded it.
 *
 * An agent's tool call has mode `integrated` and carries `parentAgentRun`,
 * whose `runId` is the agent run; a sub-workflow carries `parentExecution`.
 * Read from the record and from its `data`, because the two APIs put them in
 * different places.
 */
export function callerOf(exec) {
  const data = exec?.data ?? {};
  const agent = data.parentAgentRun ?? exec?.parentAgentRun ?? null;
  const parent = data.parentExecution ?? exec?.parentExecution ?? null;
  const mode = String(exec?.mode ?? '').toLowerCase();
  const agentRunId = agent && typeof agent === 'object' && agent.runId ? String(agent.runId) : null;
  const parentExecutionId = parent && typeof parent === 'object' && (parent.executionId ?? parent.id) ? String(parent.executionId ?? parent.id) : null;
  return {
    mode,
    agentRunId,
    parentExecutionId,
    called: mode === 'integrated' || Boolean(agent) || Boolean(parentExecutionId),
  };
}

/** The last node's first output item, where a refusal would be. */
function lastOutput(exec) {
  const rd = exec?.data?.resultData ?? {};
  const runs = rd.lastNodeExecuted && rd.runData ? rd.runData[rd.lastNodeExecuted] : null;
  const run = Array.isArray(runs) ? runs[runs.length - 1] : null;
  const items = run?.data?.main?.[0];
  return Array.isArray(items) && items[0] ? items[0].json : null;
}

/** Why a successful run did nothing, or null when it did its work. */
export function refusalOf(exec) {
  const json = lastOutput(exec);
  if (json && typeof json === 'object' && (json.ok === false || json.refused === true)) {
    return String(json.error ?? json.reason ?? json.message ?? 'answered ok:false');
  }
  return null;
}

/** "Loop digest needs … [line 19]" and the same without the line number are one failure. */
function normalise(message) {
  return String(message ?? '')
    .replace(/\s*\[line \d+\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** The node and message a failure is recognised by. */
export function failureSignature(exec, fallbackNode = null) {
  const rd = exec?.data?.resultData ?? {};
  return {
    node: rd.lastNodeExecuted ?? fallbackNode ?? null,
    message: normalise(rd.error?.message ?? rd.error?.description ?? ''),
  };
}

function sameFailure(a, b) {
  if (!a || !b) return false;
  if (a.node && b.node && a.node !== b.node) return false;
  return Boolean(a.message) && a.message === b.message;
}

async function readWhole(id) {
  try {
    return await n8n.execution(id, { includeData: true });
  } catch {
    return null;
  }
}

/**
 * Did the same workflow succeed later in the same parent agent run?
 *
 * Only asked where the failed execution names an agent run: without a runId
 * to match, "later" is just any later run, which is the verification's
 * question, not this one. Returns the evidence — the execution, when it
 * started, and how long after the failure — or null.
 */
export async function agentRecovery({ workflowId, failed }) {
  const { agentRunId } = callerOf(failed);
  const t0 = startOf(failed);
  if (!agentRunId || t0 === null) return null;

  const later = (await n8n.executionsSince(workflowId, t0)).filter((e) => String(e.id) !== String(failed.id) && startOf(e) - t0 <= SAME_RUN_WINDOW_MS && n8n.succeeded(e.status));
  for (const e of later.slice(0, MAX_READS)) {
    const whole = await readWhole(e.id);
    if (!whole || callerOf(whole).agentRunId !== agentRunId || refusalOf(whole)) continue;
    return {
      execution_id: String(e.id),
      started_at: e.startedAt ?? null,
      after_seconds: Math.round((startOf(e) - t0) / 1000),
      agent_run_id: agentRunId,
    };
  }
  return null;
}

/**
 * What real runs since the fix say about it.
 *
 * `passed` is every real, successful, non-refusing execution that started after
 * `sinceMs`, oldest first; `failedSame` is the first one that failed the way
 * the original did. Runs still going are left for the next check.
 */
export async function laterRuns({ workflowId, sinceMs, signature, excludeIds = [] }) {
  const skip = new Set(excludeIds.map(String));
  const runs = (await n8n.executionsSince(workflowId, sinceMs)).filter((e) => !skip.has(String(e.id)) && !NOT_REAL.has(String(e.mode ?? '').toLowerCase()) && n8n.isFinal(e.status));

  const passed = [];
  const refused = [];
  const otherFailures = [];
  let failedSame = null;
  let reads = 0;

  for (const e of runs) {
    if (reads >= MAX_READS) break;
    reads++;
    const whole = await readWhole(e.id);
    const at = { execution_id: String(e.id), started_at: e.startedAt ?? null };
    if (n8n.succeeded(e.status)) {
      const why = whole ? refusalOf(whole) : null;
      if (why) refused.push({ ...at, refusal: why });
      else passed.push(at);
    } else if (whole && sameFailure(failureSignature(whole), signature)) {
      failedSame = { ...at, status: String(e.status) };
      break;
    } else {
      otherFailures.push({ ...at, status: String(e.status) });
    }
  }
  return { passed, refused, otherFailures, failedSame };
}

/** `18142 at 12:11:26Z` — the form an execution is named in, everywhere a report names one. */
export function named(runs) {
  return runs.map((r) => `${r.execution_id} at ${r.started_at ? String(r.started_at).replace(/\.\d+Z$/, 'Z') : 'an unknown time'}`).join(', ');
}
