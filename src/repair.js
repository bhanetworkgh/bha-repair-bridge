/**
 * The repair itself: accept, refuse, diagnose, verify, report.
 *
 * The shape of it, and why each part is where it is:
 *
 * **Refusals are decided synchronously**, before the 202 goes back, because one
 * of them — one repair per workflow at a time — is a reservation, and a
 * reservation made after the response is a race with the next request.
 *
 * **The outcome is decided here, not by the model.** Claude Code says what it
 * believes it did; this module records `repaired` only where n8n's own
 * versionId moved *and* the retried execution passed. A run that ended without
 * a parseable result is `needs_human`. That guard exists twice, here and in the
 * dashboard, because a guard that lives only in the caller is not a guard.
 *
 * **Every path ends in a report.** The try/catch around the whole job is not
 * defensive habit: an exception that escaped would be a repair that happened in
 * silence, which is the one outcome this service may not have.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dryRun, env, repairTimeoutMs, retryWaitMs } from './config.js';
import { runClaude } from './claude.js';
import { errText, log, logError } from './log.js';
import * as n8n from './n8n.js';
import { context, prompt, snapshotOf } from './prompt.js';
import { failedWriteNote, lastFailedWrite, readCallLog, wroteSuccessfully, writeHelperScripts } from './scripts.js';
import { reportBoth } from './report.js';

/**
 * The workflows this bridge will not touch, by name.
 *
 * The three error handlers, the healer that calls this service, the retry
 * workflow and the reporter: repairing any of them means a machine editing the
 * thing that decides when machines edit things. They are refused by name, and
 * the refusal is reported like any other outcome — a skip is a result, not a
 * silence.
 */
export const REFUSED_WORKFLOWS = [
  'Bays — Error Handler',
  'North Star — Error Handler',
  'Research Twin — Error Handler',
  'BHA — Self Healer',
  'Engine — Self-Healing Retry',
  'BHA — Self Healer Reports',
];

/** Dashes differ between what n8n stores and what a payload carries, so compare on a flattened name. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[‐-―−-]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const REFUSED_SET = new Set(REFUSED_WORKFLOWS.map(normalizeName));

export function isRefusedWorkflow(name) {
  return REFUSED_SET.has(normalizeName(name));
}

export function repairIdFor(request) {
  return `REP-${request?.workflow?.id ?? 'unknown'}-${request?.execution?.id ?? 'unknown'}`;
}

/** One repair per workflow at a time. The map is the lock and its size is `busy`. */
const ACTIVE = new Map();

export function busy() {
  return ACTIVE.size;
}

export function activeRepairs() {
  return [...ACTIVE.entries()].map(([workflow_id, repair_id]) => ({ workflow_id, repair_id }));
}

/**
 * The last JSON object in Claude Code's answer that looks like a result.
 *
 * Scanned with a brace counter rather than a regular expression, because the
 * answer routinely contains JSON inside prose and inside fenced blocks, and the
 * one that counts is the last complete object carrying an `outcome`.
 */
export function extractResult(text) {
  if (!text) return null;
  const s = String(text);
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          found.push(s.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  for (let i = found.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(found[i]);
      if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.outcome === 'string') return o;
    } catch {
      /* not this one */
    }
  }
  return null;
}

const CLAIMS = new Set(['repaired', 'not_repaired', 'needs_human', 'error']);

function claimOf(result) {
  const said = String(result?.outcome ?? '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return CLAIMS.has(said) ? said : null;
}

function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 200) : [];
}

function str(v, fallback = null) {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/**
 * The outcome, from evidence rather than from the model's own account.
 *
 * `repaired` needs both halves: a version that moved, and a retry that passed.
 * Either one alone is a story about a repair, not a repair.
 */
export function decideOutcome({ claimed, versionChanged, retryPassed, retryRan, isDryRun }) {
  if (isDryRun) return 'not_repaired';
  if (!claimed) return 'needs_human';
  if (claimed === 'error') return 'error';
  if (!versionChanged) {
    // Claiming a repair the workflow does not show is not an error and not a
    // repair: it is the case a person has to look at.
    return claimed === 'repaired' ? 'needs_human' : claimed;
  }
  if (claimed === 'needs_human') return 'needs_human';
  if (retryRan && retryPassed) return 'repaired';
  return 'not_repaired';
}

/* --------------------------------------------------------------- accepting */

export class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

/**
 * Takes a repair request, decides in-line whether it is refused, and starts the
 * work. Returns as soon as the id exists — everything after is asynchronous.
 */
export function accept(request) {
  const workflowId = str(request?.workflow?.id);
  const executionId = str(request?.execution?.id ?? request?.execution?.executionId);
  if (!workflowId || !executionId) {
    throw new RequestError('workflow.id and execution.id are both required: together they are the repair id, and a repair without one cannot be reported or read back.', 422);
  }

  const repairId = repairIdFor({ workflow: { id: workflowId }, execution: { id: executionId } });
  const workflowName = str(request?.workflow?.name, '');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (isRefusedWorkflow(workflowName)) {
    log(repairId, 'skipped.refused', { workflow: workflowName });
    void finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome: 'skipped',
      rootCause: `${workflowName} is on the refuse list: the error handlers, the self healer, the retry workflow and the reports workflow are the machinery that decides when workflows get repaired, and this service does not edit that.`,
      changeSummary: 'Nothing was read or changed.',
      humanAction: `If ${workflowName} is genuinely broken, fix it by hand — that is deliberate.`,
    });
    return { repair_id: repairId, accepted: true, skipped: true };
  }

  const running = ACTIVE.get(workflowId);
  if (running) {
    log(repairId, 'skipped.busy', { already_running: running });
    void finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome: 'skipped',
      rootCause: `A repair of this workflow is already running (${running}). One repair per workflow at a time: two Claude Code runs editing one workflow would overwrite each other's changes.`,
      changeSummary: 'Nothing was read or changed.',
      humanAction: `Wait for ${running} to report, then look at whether this failure is the same one.`,
    });
    return { repair_id: repairId, accepted: true, skipped: true };
  }

  ACTIVE.set(workflowId, repairId);
  void run({ request, repairId, workflowId, executionId, workflowName, startedAt, t0 }).finally(() => {
    ACTIVE.delete(workflowId);
  });

  return { repair_id: repairId, accepted: true, skipped: false };
}

/* ---------------------------------------------------------------- the work */

async function run({ request, repairId, workflowId, executionId, workflowName, startedAt, t0 }) {
  const isDryRun = dryRun();
  log(repairId, 'start', { workflow_id: workflowId, workflow_name: workflowName, execution_id: executionId, dry_run: isDryRun });

  let workspace = null;
  let snapshot = null;
  let versionBefore = null;
  let versionAfter = null;
  let retryExecutionId = null;
  let failedNode = str(request?.error?.failed_node) ?? str(request?.execution?.lastNodeExecuted);
  let nameFromN8n = workflowName;

  try {
    /* 3. The workflow and the failed execution, from n8n. */
    const wf = await n8n.workflow(workflowId);
    versionBefore = str(wf?.versionId);
    snapshot = snapshotOf(wf);
    nameFromN8n = str(wf?.name, workflowName);
    log(repairId, 'n8n.workflow.read', { version_before: versionBefore, nodes: Array.isArray(wf?.nodes) ? wf.nodes.length : 0 });

    const exec = await n8n.execution(executionId, { includeData: true });
    log(repairId, 'n8n.execution.read', { status: exec?.status ?? null });

    const ctx = context({ workflow: wf, execution: exec, failedNodeName: failedNode });
    failedNode = ctx.nodeName ?? failedNode;

    /* 4. Claude Code, on a working directory holding the whole of what it was shown. */
    workspace = await mkdtemp(path.join(tmpdir(), 'repair-'));

    /**
     * The two scripts are the only way the model reaches n8n (21 Sep 2026,
     * after a live repair hand-rolled a curl and got a 401 on a working key).
     * They carry the URL, the workflow id and the header themselves, and they
     * log every call to `callLog`, which is read below: a write n8n refused is
     * then a fact this service holds, not a claim the model makes about itself.
     */
    const helpers = await writeHelperScripts({ dir: workspace, workflowId });
    const callLog = helpers.log;

    const files = ['workflow.json', 'execution.json', 'failed-node.json', 'error.json', 'request.json', ...helpers.names];
    await Promise.all([
      writeFile(path.join(workspace, 'workflow.json'), JSON.stringify(wf, null, 2)),
      writeFile(path.join(workspace, 'execution.json'), JSON.stringify(exec, null, 2)),
      writeFile(path.join(workspace, 'failed-node.json'), JSON.stringify({ node: ctx.node, error: ctx.nodeError, input: ctx.input, output: ctx.output }, null, 2)),
      writeFile(path.join(workspace, 'error.json'), JSON.stringify(request?.error ?? {}, null, 2)),
      writeFile(path.join(workspace, 'request.json'), JSON.stringify({ ...request, workflow: request?.workflow, execution: request?.execution }, null, 2)),
    ]);

    const text = prompt({
      repairId,
      request,
      workflow: wf,
      ctx,
      files,
      dryRun: isDryRun,
    });

    log(repairId, 'claude.start', { timeout_ms: repairTimeoutMs(), prompt_chars: text.length, cwd: workspace });
    const claudeRun = await runClaude({
      prompt: text,
      cwd: workspace,
      timeoutMs: repairTimeoutMs(),
      tools: env('CLAUDE_ALLOWED_TOOLS') || 'Bash,Read,Write,Edit,Glob,Grep',
      extraEnv: {
        // Only what the two scripts read. The model is told never to use these
        // itself, and it has no reason to: the scripts send them.
        N8N_BASE_URL: process.env.N8N_BASE_URL ?? '',
        N8N_API_KEY: process.env.N8N_API_KEY ?? '',
        N8N_CALL_LOG: callLog,
      },
      onLog: (detail) => log(repairId, 'claude.note', detail),
    });
    log(repairId, 'claude.finished', { ok: claudeRun.ok, ms: claudeRun.ms, model: claudeRun.model, timed_out: claudeRun.timedOut, error: claudeRun.error ?? null });

    const result = claudeRun.ok ? extractResult(claudeRun.text) : null;
    const claimed = claimOf(result);
    if (!result) {
      logError(repairId, 'claude.unparseable', { tail: (claudeRun.text || claudeRun.stderr || '').slice(-800) });
    }

    /**
     * What n8n actually answered, from the scripts' own log rather than from
     * the model's account of the run. A refused write is carried into
     * human_action whatever the model said about it.
     */
    const calls = await readCallLog(callLog);
    const wrote = wroteSuccessfully(calls);
    const refusedWrite = lastFailedWrite(calls);
    log(repairId, 'n8n.calls', {
      calls: calls.length,
      wrote,
      statuses: calls.map((c) => `${c.method} ${c.status}`),
    });
    if (refusedWrite) logError(repairId, 'n8n.write.refused', { status: refusedWrite.status, body: refusedWrite.body.slice(0, 400) });

    /* 5. What n8n says happened, which is the only thing that decides a repair. */
    let versionChanged = false;
    let retryRan = false;
    let retryPassed = false;
    let retryNote = null;

    // A write n8n accepted is reason enough to re-read, whatever the model
    // claimed — including a run that ended without a parseable result.
    const looksChanged = wrote || Boolean(claimed && (claimed === 'repaired' || strings(result?.nodes_changed).length > 0));

    if (isDryRun) {
      log(repairId, 'dry_run.no_writes', 'DRY_RUN is on: nothing was written to n8n and no retry was run.');
    } else if (looksChanged) {
      const after = await n8n.workflow(workflowId);
      versionAfter = str(after?.versionId);
      versionChanged = Boolean(versionAfter && versionBefore && versionAfter !== versionBefore) || Boolean(versionAfter && !versionBefore);
      log(repairId, 'n8n.workflow.reread', { version_before: versionBefore, version_after: versionAfter, changed: versionChanged });

      if (!versionChanged) {
        versionAfter = null;
        retryNote = 'The workflow’s version did not move, so nothing was actually changed in n8n and there was nothing to retry.';
      } else {
        const retry = await retryAndWait({ repairId, executionId, workflowId });
        retryRan = retry.ran;
        retryPassed = retry.passed;
        retryExecutionId = retry.executionId;
        retryNote = retry.note;
      }
    }

    const outcome = decideOutcome({ claimed, versionChanged, retryPassed, retryRan, isDryRun });

    const rootCause = str(result?.root_cause) ?? (claudeRun.ok ? 'Claude Code finished without a parseable result, so what it found is not recorded. Nothing is assumed about the workflow.' : `Claude Code did not finish: ${claudeRun.error ?? 'no reason given'}`);

    const changeSummary = (() => {
      const said = str(result?.change_summary) ?? (claudeRun.ok ? 'No change was reported.' : 'No change was reported: the run did not finish.');
      if (isDryRun) return `DRY RUN: ${said}`;
      const extra = [];
      if (refusedWrite) extra.push(failedWriteNote(refusedWrite));
      if (retryNote) extra.push(retryNote);
      if (claimed === 'repaired' && !versionChanged) extra.push('Claude Code reported a repair, but n8n shows the same versionId as before it ran — so this is recorded as needing a person rather than as a repair.');
      if (claimed && claimed !== 'repaired' && outcome === 'repaired') {
        extra.push(`Claude Code reported this as ${claimed.replace(/_/g, ' ')}, but the workflow's version moved and the retried execution passed — the evidence is what this row records.`);
      }
      return extra.length ? `${said} ${extra.join(' ')}` : said;
    })();

    const humanAction = (() => {
      const said = str(result?.human_action);
      /**
       * A write n8n refused goes on the row whether or not the model mentioned
       * it. This is the case the scripts were built for: the status and the
       * body are the two things a person needs, and they must not depend on the
       * model having quoted them.
       */
      const refusal = refusedWrite ? failedWriteNote(refusedWrite) : null;
      if (said && refusal && !said.includes(String(refusedWrite.status))) return `${refusal} ${said}`;
      if (said) return said;
      if (refusal) return `${refusal} Look at the workflow in n8n and decide whether the fix above is worth applying by hand.`;
      if (outcome === 'needs_human' && !result) return 'Read this repair’s log on the bridge, then look at the workflow yourself: the run finished without saying what it found, so nothing here should be trusted as a diagnosis.';
      if (outcome === 'not_repaired') return 'The failure is still there. Look at the root cause above and decide whether it is worth fixing by hand.';
      return null;
    })();

    await finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome,
      rootCause,
      changeSummary,
      nodesChanged: strings(result?.nodes_changed),
      humanAction,
      workflowName: nameFromN8n,
      failedNode,
      versionBefore,
      versionAfter,
      retryExecutionId,
      snapshot,
      model: claudeRun.model,
    });
  } catch (e) {
    logError(repairId, 'failed', { error: errText(e) });
    await finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome: 'error',
      rootCause: `The repair could not be carried out: ${errText(e)}`,
      changeSummary: 'Nothing was changed, or nothing can be said about what was: the run ended on an error before it could be verified.',
      humanAction: 'Look at the bridge’s log for this repair id. The failure is in the bridge or in reaching n8n, not in the workflow.',
      workflowName: nameFromN8n,
      failedNode,
      versionBefore,
      versionAfter,
      retryExecutionId,
      snapshot,
    });
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Retries the failed execution and waits for its verdict.
 *
 * n8n's retry endpoint does not answer the same way on every version, and on
 * some it is not there at all. Each of those is reported as what it is — a
 * repair that could not be verified — rather than smoothed into a pass.
 */
async function retryAndWait({ repairId, executionId, workflowId }) {
  const since = Date.now();
  let started;
  try {
    started = await n8n.retryExecution(executionId);
  } catch (e) {
    const status = e instanceof n8n.N8nError ? e.status : 0;
    if (status === 404 || status === 405 || status === 501) {
      logError(repairId, 'retry.unavailable', { status, error: errText(e) });
      return { ran: false, passed: false, executionId: null, note: `This n8n instance did not accept a retry of execution ${executionId} (${status}), so the fix is in place but unproven. Retry it by hand to see whether it holds.` };
    }
    logError(repairId, 'retry.failed', { status, error: errText(e) });
    return { ran: false, passed: false, executionId: null, note: `The retry could not be started: ${errText(e)}. The change is in place but unproven.` };
  }

  let retryId = started.executionId;
  if (!retryId && started.started) {
    // Some versions answer `true`. Find the run it started rather than guessing.
    try {
      const recent = await n8n.executionsFor(workflowId, 10);
      const candidate = recent.find((x) => String(x.id) !== String(executionId) && (!x.startedAt || new Date(x.startedAt).getTime() >= since - 60_000));
      retryId = candidate ? String(candidate.id) : null;
    } catch (e) {
      log(repairId, 'retry.lookup.failed', errText(e));
    }
  }

  if (!retryId) {
    return { ran: false, passed: false, executionId: null, note: 'n8n accepted the retry but did not say which execution it started, so the result could not be read back. The change is in place but unproven.' };
  }

  log(repairId, 'retry.started', { retry_execution_id: retryId });
  const waited = await n8n.waitForExecution(retryId, { timeoutMs: retryWaitMs(), onPoll: (d) => log(repairId, 'retry.poll', d) });
  log(repairId, 'retry.finished', { retry_execution_id: retryId, status: waited.status, timed_out: waited.timedOut });

  if (waited.timedOut) {
    return { ran: true, passed: false, executionId: retryId, note: `The retried execution ${retryId} had not finished after ${Math.round(retryWaitMs() / 1000)}s, so this is not recorded as a repair. Look at that execution in n8n — it may yet have passed.` };
  }
  const passed = n8n.succeeded(waited.status);
  return {
    ran: true,
    passed,
    executionId: retryId,
    note: passed ? null : `The retried execution ${retryId} ended as ${waited.status}, so the change did not fix the failure.`,
  };
}

/* --------------------------------------------------------------- reporting */

/** Builds both bodies and sends them. Every path through a repair ends here. */
async function finish({
  request,
  repairId,
  startedAt,
  t0,
  outcome,
  rootCause,
  changeSummary,
  nodesChanged = [],
  humanAction = null,
  workflowName = null,
  failedNode = null,
  versionBefore = null,
  versionAfter = null,
  retryExecutionId = null,
  snapshot = null,
  model = null,
}) {
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  const dashboardBody = {
    repair_id: repairId,
    outcome,
    workflow: {
      id: str(request?.workflow?.id),
      name: workflowName || str(request?.workflow?.name),
    },
    failed_node: failedNode ?? str(request?.error?.failed_node),
    error_class: str(request?.error?.class),
    error_message: str(request?.error?.message),
    execution_id: str(request?.execution?.id),
    root_cause: rootCause,
    change_summary: changeSummary,
    nodes_changed: nodesChanged,
    human_action: humanAction,
    version_before: versionBefore,
    version_after: versionAfter,
    duration_ms: durationMs,
    report_channel: str(request?.report_channel) ?? env('SLACK_REPORT_CHANNEL'),
    started_at: startedAt,
    finished_at: finishedAt,
    payload: request ?? {},
    /**
     * The workflow as it stood before anything was changed.
     *
     * Not in the brief's field list, and sent anyway: the dashboard's Revert
     * restores from this snapshot and refuses where it is absent, because n8n's
     * public API cannot fetch a version by id. A `version_before` with no
     * snapshot beside it names a restore point without containing it.
     */
    workflow_before: snapshot,
    dry_run: dryRun(),
    ...(model ? { model } : {}),
  };

  const webhookBody = {
    ...dashboardBody,
    incident: request?.incident ?? null,
    lane: str(request?.lane),
    alert_permalink: str(request?.alert_permalink),
    retry_execution_id: retryExecutionId,
  };

  log(repairId, 'outcome', {
    outcome,
    duration_ms: durationMs,
    version_before: versionBefore,
    version_after: versionAfter,
    retry_execution_id: retryExecutionId,
    nodes_changed: nodesChanged,
  });

  await reportBoth({ repairId, dashboardBody, webhookBody });
}
