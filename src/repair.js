/**
 * The repair itself: accept, refuse, queue, diagnose, verify, report.
 *
 * The shape of it, and why each part is where it is:
 *
 * **One repair runs at a time, across every workflow** (22 Sep 2026, after the
 * 08:00 incident). Three repairs were accepted within seconds, three Claude
 * Code runs started together on a starter instance, the service ran out of
 * memory and was restarted, and three North Star workflows came out of it
 * switched off with nothing saved. The lock used to be per workflow, which made
 * three different workflows three permitted concurrent runs. It is global now
 * and the rest wait their turn — see `queue.js`.
 *
 * **Refusals are decided synchronously**, before the 202 goes back, because one
 * of them is a reservation, and a reservation made after the response is a race
 * with the next request.
 *
 * **A workflow's active state is never a repair's to change.** It is recorded
 * before the run and put back afterwards if it differs — including after a
 * restart, from the record on disk. Restoring is not editing: it undoes a
 * change nobody asked for.
 *
 * **The outcome is decided here, not by the model.** Claude Code says what it
 * believes it did; this module records `repaired` only where n8n's own
 * versionId moved *and* the retried execution passed. A run that ended without
 * a parseable result is `needs_human`. That guard exists twice, here and in the
 * dashboard, because a guard that lives only in the caller is not a guard.
 *
 * **An agent-called workflow is not proved by retrying its failed input**
 * (26 Sep 2026). A retry replays whatever the caller sent that one time; for
 * `Bays — Post Loop Digest` that was an empty call, so the retry of a correct
 * fix failed and the row said `not_repaired` while four real runs passed. For
 * those the proof is a later real run, watched for in the background without
 * holding the queue — see `verify.js` and `watchForProof` below.
 *
 * **Every path ends in a report.** The try/catch around the whole job is not
 * defensive habit: an exception that escaped would be a repair that happened in
 * silence, which is the one outcome this service may not have.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dryRun, env, repairTimeoutMs, retryWaitMs, verifyPollMs, verifyWindowMs } from './config.js';
import { runClaude } from './claude.js';
import { errText, log, logError } from './log.js';
import * as n8n from './n8n.js';
import { context, prompt, snapshotOf } from './prompt.js';
import * as queue from './queue.js';
import { INFRASTRUCTURE, infrastructureFailure, isRefusedWorkflow } from './refusals.js';
import { failedWriteNote, lastFailedWrite, readCallLog, wroteSuccessfully, writeHelperScripts } from './scripts.js';
import { reportBoth } from './report.js';
import * as state from './state.js';
import { agentRecovery, callerOf, failureSignature, laterRuns, named } from './verify.js';

export { REFUSED_WORKFLOWS, isRefusedWorkflow, normalizeName } from './refusals.js';
export { infrastructureFailure } from './refusals.js';

export function repairIdFor(request) {
  return `REP-${request?.workflow?.id ?? 'unknown'}-${request?.execution?.id ?? 'unknown'}`;
}

/** Running plus waiting. One of them can be running; the rest are queued. */
export function busy() {
  return queue.busy();
}

export function running() {
  return queue.runningCount();
}

export function queued() {
  return queue.queuedCount();
}

/** What is running and what is waiting, in order. */
export function activeRepairs() {
  return { ...queue.snapshot(), verifying: pendingVerifications() };
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
 * `repaired` needs both halves: a version that moved, and proof that the
 * failure is gone. Either one alone is a story about a repair, not a repair.
 *
 * The proof is a passing retry for a workflow started by its own trigger, and
 * a later real run for one an agent or another workflow called (26 Sep 2026):
 * `laterPassed` is a real success after the fix was published, `laterFailed` a
 * real run that failed the same way, and `pending` means neither has happened
 * yet — reported as `repaired_pending` and settled by a second report.
 */
export function decideOutcome({ claimed, versionChanged, retryPassed, retryRan, isDryRun, laterPassed = false, laterFailed = false, pending = false }) {
  if (isDryRun) return 'not_repaired';
  if (!claimed) return 'needs_human';
  if (claimed === 'error') return 'error';
  if (!versionChanged) {
    // Claiming a repair the workflow does not show is not an error and not a
    // repair: it is the case a person has to look at.
    return claimed === 'repaired' ? 'needs_human' : claimed;
  }
  if (claimed === 'needs_human') return 'needs_human';
  if (laterFailed) return 'not_repaired';
  if (laterPassed) return 'repaired';
  if (pending) return 'repaired_pending';
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
 * Takes a repair request, decides in-line whether it is refused, and puts it in
 * the queue. Returns as soon as the id exists — everything after is
 * asynchronous, including the wait for its turn.
 *
 * The three synchronous refusals, in order:
 *
 * 1. **A refused workflow** — the machinery that decides when repairs happen.
 * 2. **An infrastructure failure** — a crashed execution or an out-of-memory
 *    error. There is no workflow bug for a repair to find, and ten minutes of
 *    Claude Code looking for one is ten minutes inviting an edit to a workflow
 *    that was working.
 * 3. **A workflow already running or already waiting** — deduplicated as
 *    before, because two runs editing one workflow overwrite each other whether
 *    they are concurrent or merely consecutive.
 *
 * Everything else joins one global queue. It is not refused for being second:
 * it waits, and a wait is not a silence — its report comes when it runs.
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

  const skip = (step, detail, { rootCause, humanAction }) => {
    log(repairId, step, detail);
    void finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome: 'skipped',
      rootCause,
      changeSummary: 'Nothing was read or changed.',
      humanAction,
      workflowName,
    });
    return { repair_id: repairId, accepted: true, skipped: true };
  };

  if (isRefusedWorkflow(workflowName)) {
    return skip('skipped.refused', { workflow: workflowName }, {
      rootCause: `${workflowName} is on the refuse list: the error handlers, the self healer, the retry workflow and the reports workflow are the machinery that decides when workflows get repaired, and this service does not edit that.`,
      humanAction: `If ${workflowName} is genuinely broken, fix it by hand — that is deliberate.`,
    });
  }

  /**
   * The crash and out-of-memory refusal, from what the request itself says.
   * The execution is checked again once it has been read — this first pass
   * exists so the obvious cases never reach n8n or the queue at all.
   */
  const infrastructure = infrastructureFailure({ request });
  if (infrastructure.refused) {
    return skip('skipped.infrastructure', { matched: infrastructure.matched }, {
      rootCause: infrastructure.reason,
      humanAction: 'Look at the instance rather than the workflow: memory, concurrency, and what else was running at the time. If the workflow really does need less memory to run, that is a change for a person to design.',
    });
  }

  const held = queue.heldBy(workflowId);
  if (held) {
    return skip('skipped.busy', { already: held }, {
      rootCause: `A repair of this workflow is already ${held.state} (${held.repair_id}). One repair per workflow: two runs editing one workflow would overwrite each other.`,
      humanAction: `Wait for ${held.repair_id} to report, then look at whether this failure is the same one.`,
    });
  }

  const { position, waiting_for } = queue.enqueue({
    repairId,
    workflowId,
    onStart: () => log(repairId, 'queue.turn', { waited_ms: Date.now() - t0 }),
    job: () => run({ request, repairId, workflowId, executionId, workflowName, startedAt, t0 }),
  });

  if (position > 0) {
    log(repairId, 'queued', { position, behind: waiting_for, busy: queue.busy() });
  }

  return { repair_id: repairId, accepted: true, skipped: false, queue_position: position };
}

/* ------------------------------------------------------- the active state */

/**
 * Puts a workflow's active state back if the repair changed it.
 *
 * A repair has no business switching a workflow on or off, and the prompt says
 * so — but a prompt is guidance and this is the guard. On 22 Sep three North
 * Star workflows were left switched off by an interrupted repair, which is the
 * worst version of this: the failure was not repaired *and* the workflow
 * stopped running at all.
 *
 * Returns what happened rather than throwing. A restore that failed is on the
 * row, because a workflow still switched off is the most urgent thing a report
 * can say.
 */
export async function restoreActive({ repairId, workflowId, activeBefore, workflow = null }) {
  if (typeof activeBefore !== 'boolean') return { checked: false, changed: false, restored: false, now: null, error: null };

  try {
    const current = workflow ?? (await n8n.workflow(workflowId));
    const activeNow = Boolean(current?.active);
    if (activeNow === activeBefore) return { checked: true, changed: false, restored: false, now: activeNow, error: null };

    logError(repairId, 'active.changed', { was: activeBefore, now: activeNow });
    await n8n.setActive(workflowId, activeBefore);

    // Read it back: a restore is a claim about another system's state, and this
    // service does not make those without asking.
    const after = await n8n.workflow(workflowId);
    const ok = Boolean(after?.active) === activeBefore;
    log(repairId, ok ? 'active.restored' : 'active.restore.failed', { was: activeBefore, is: Boolean(after?.active) });
    return {
      checked: true,
      changed: true,
      restored: ok,
      now: Boolean(after?.active),
      error: ok ? null : `n8n still reports active=${Boolean(after?.active)} after the restore was asked for.`,
    };
  } catch (e) {
    logError(repairId, 'active.restore.error', errText(e));
    return { checked: true, changed: true, restored: false, now: null, error: errText(e) };
  }
}

/**
 * The sentence the report carries when the state had to be put back.
 *
 * Keyed on whether the state had *changed*, never on what it is now: a restore
 * that worked leaves the workflow exactly as it was before, which is precisely
 * the case this sentence exists to report.
 */
function activeNote(restore, activeBefore) {
  if (!restore?.checked || !restore.changed) return null;
  if (restore.restored) return `Active state restored: the workflow had been switched ${activeBefore ? 'off' : 'on'} during this repair and has been set back to ${activeBefore ? 'active' : 'inactive'}.`;
  return `ACTIVE STATE NOT RESTORED: this workflow was switched ${activeBefore ? 'off' : 'on'} during the repair and the bridge could not set it back${restore.error ? ` (${restore.error})` : ''}. Switch it ${activeBefore ? 'on' : 'off'} in n8n.`;
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
  let activeBefore = null;
  let recorded = false;
  let failedNode = str(request?.error?.failed_node) ?? str(request?.execution?.lastNodeExecuted);
  let nameFromN8n = workflowName;

  try {
    /* 3. The workflow and the failed execution, from n8n. */
    const wf = await n8n.workflow(workflowId);
    versionBefore = str(wf?.versionId);
    snapshot = snapshotOf(wf);
    nameFromN8n = str(wf?.name, workflowName);
    activeBefore = typeof wf?.active === 'boolean' ? wf.active : null;
    log(repairId, 'n8n.workflow.read', { version_before: versionBefore, active: activeBefore, nodes: Array.isArray(wf?.nodes) ? wf.nodes.length : 0 });

    /**
     * On disk before anything can go wrong with it. A file still here at boot
     * is a repair the process did not survive, and boot reports it and puts
     * the active state back — which is what nobody did on 22 Sep.
     */
    await state.markRunning({
      repair_id: repairId,
      workflow_id: workflowId,
      workflow_name: nameFromN8n,
      execution_id: executionId,
      active_before: activeBefore,
      version_before: versionBefore,
      started_at: startedAt,
      request,
    });
    recorded = true;

    const exec = await n8n.execution(executionId, { includeData: true });
    log(repairId, 'n8n.execution.read', { status: exec?.status ?? null });

    /**
     * The crash and out-of-memory refusal again, now against the execution's
     * own status — the reliable version of the check `accept` made on the
     * request. Refused here, Claude Code is never started.
     */
    const infrastructure = infrastructureFailure({ request, execution: exec });
    if (infrastructure.refused) {
      log(repairId, 'skipped.infrastructure', { matched: infrastructure.matched, status: exec?.status ?? null });
      await finish({
        request,
        repairId,
        startedAt,
        t0,
        outcome: 'skipped',
        rootCause: infrastructure.reason,
        changeSummary: `Skipped — ${INFRASTRUCTURE}. The workflow was read and nothing was changed; Claude Code was never started.`,
        humanAction: 'Look at the instance rather than the workflow: memory, concurrency, and what else was running at the time. If the workflow really does need less memory to run, that is a change for a person to design.',
        workflowName: nameFromN8n,
        failedNode,
        versionBefore,
        activeBefore,
        snapshot,
      });
      return;
    }

    const ctx = context({ workflow: wf, execution: exec, failedNodeName: failedNode });
    failedNode = ctx.nodeName ?? failedNode;

    /**
     * Who called this execution, and whether the caller got past it (26 Sep
     * 2026). An agent's tool call that failed once and succeeded moments later
     * in the same agent run is worth saying in the report — and the model is
     * told, so it looks for a real defect rather than for why an empty call
     * was empty. The diagnosis and the repair still run: 18124 had a real cause.
     */
    const caller = callerOf(exec);
    const signature = failureSignature(exec, failedNode);
    const findRecovery = async () => {
      if (!caller.agentRunId) return null;
      try {
        return await agentRecovery({ workflowId, failed: exec });
      } catch (e) {
        log(repairId, 'agent.recovery.unread', errText(e));
        return null;
      }
    };
    let recovered = await findRecovery();
    log(repairId, 'caller', { mode: caller.mode, called: caller.called, agent_run_id: caller.agentRunId, parent_execution_id: caller.parentExecutionId, recovered: recovered?.execution_id ?? null });

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
      caller,
      recovered,
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
    /** For a called workflow: the later real runs that decide it (26 Sep 2026). */
    let verification = null;
    let later = null;
    let publishedAt = null;

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
      } else if (caller.called) {
        /**
         * Called by an agent or another workflow: retrying would replay the
         * caller's input, so the proof is a real run after the new version was
         * published. One may already exist; if not, the report goes out as
         * `repaired_pending` and `watchForProof` settles it later.
         */
        verification = 'later_runs';
        publishedAt = publishTime(calls);
        later = await laterRunsOrNothing({ repairId, workflowId, sinceMs: Date.parse(publishedAt), signature, executionId });
        log(repairId, 'verify.later_runs', { published_at: publishedAt, passed: later.passed.map((r) => r.execution_id), failed_same: later.failedSame?.execution_id ?? null });
      } else {
        verification = 'retry';
        const retry = await retryAndWait({ repairId, executionId, workflowId });
        retryRan = retry.ran;
        retryPassed = retry.passed;
        retryExecutionId = retry.executionId;
        retryNote = retry.note;
      }
    }

    // The caller may have recovered while the model worked: 18129 started nine
    // seconds after 18124, before the healer's request had even been answered.
    if (!recovered) recovered = await findRecovery();

    /**
     * The active state, put back if the run changed it. Before the report is
     * built, so what the report says about it is what actually happened.
     */
    const restore = await restoreActive({ repairId, workflowId, activeBefore });
    const activeSentence = activeNote(restore, activeBefore);

    const outcome = decideOutcome({
      claimed,
      versionChanged,
      retryPassed,
      retryRan,
      isDryRun,
      laterPassed: Boolean(later?.passed.length),
      laterFailed: Boolean(later?.failedSame),
      pending: verification === 'later_runs' && !later?.passed.length && !later?.failedSame,
    });
    const verifyUntil = outcome === 'repaired_pending' ? new Date(Date.now() + verifyWindowMs()).toISOString() : null;

    const rootCause = str(result?.root_cause) ?? (claudeRun.ok ? 'Claude Code finished without a parseable result, so what it found is not recorded. Nothing is assumed about the workflow.' : `Claude Code did not finish: ${claudeRun.error ?? 'no reason given'}`);

    const changeSummary = (() => {
      const said = str(result?.change_summary) ?? (claudeRun.ok ? 'No change was reported.' : 'No change was reported: the run did not finish.');
      if (isDryRun) return `DRY RUN: ${said}`;
      const extra = [];
      if (refusedWrite) extra.push(failedWriteNote(refusedWrite));
      if (retryNote) extra.push(retryNote);
      const proof = proofNote({ outcome, verification, later, publishedAt, verifyUntil, executionId, caller });
      if (proof) extra.push(proof);
      if (recovered) extra.push(recoveredNote(recovered));
      if (claimed === 'repaired' && !versionChanged) extra.push('Claude Code reported a repair, but n8n shows the same versionId as before it ran — so this is recorded as needing a person rather than as a repair.');
      if (claimed && claimed !== 'repaired' && outcome === 'repaired') {
        extra.push(`Claude Code reported this as ${claimed.replace(/_/g, ' ')}, but the workflow's version moved and ${verification === 'later_runs' ? 'a later real run passed' : 'the retried execution passed'} — the evidence is what this row records.`);
      }
      if (activeSentence) extra.push(activeSentence);
      return extra.length ? `${said} ${extra.join(' ')}` : said;
    })();

    /**
     * A person is asked only for what the evidence cannot settle (26 Sep 2026).
     * Once the fix is proved, or is being proved by the runs after it, the
     * model's own request — 18124's was "confirm the agent populates these
     * fields", which the next four runs showed — is kept on the payload as
     * `model_suggestion` rather than put to a person.
     */
    const settledByEvidence = outcome === 'repaired' || outcome === 'repaired_pending';
    const modelSuggestion = settledByEvidence ? str(result?.human_action) : null;

    const humanAction = (() => {
      const said = settledByEvidence ? null : str(result?.human_action);
      /** A workflow left switched off is the most urgent thing a report can say. */
      const stillWrong = restore.changed && !restore.restored ? activeSentence : null;
      if (stillWrong) return said ? `${stillWrong} ${said}` : stillWrong;
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
      if (outcome === 'not_repaired' && later?.failedSame) return sameFailureAction(later.failedSame, nameFromN8n);
      if (outcome === 'not_repaired') return 'The failure is still there. Look at the root cause above and decide whether it is worth fixing by hand.';
      return null;
    })();

    /** Measured once, so a pending repair's second report carries the same duration as its first. */
    const repairMs = Date.now() - t0;

    await finish({
      request,
      repairId,
      startedAt,
      t0,
      durationMs: repairMs,
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
      activeBefore,
      activeRestored: restore.restored,
      activeNow: restore.now,
      verification,
      verifiedBy: later?.passed ?? [],
      failedAgain: later?.failedSame ?? null,
      publishedAt,
      verifyUntil,
      agentRecovered: recovered,
      modelSuggestion,
    });

    /**
     * Not proved yet, and not held for it: the queue moves on and the watch
     * runs beside it, on disk so a restart resumes it (26 Sep 2026).
     */
    if (outcome === 'repaired_pending') {
      const watch = {
        repair_id: repairId,
        workflow_id: workflowId,
        execution_id: executionId,
        since_ms: Date.parse(publishedAt),
        until: verifyUntil,
        signature,
        report: {
          request,
          startedAt,
          durationMs: repairMs,
          rootCause,
          saidChange: str(result?.change_summary) ?? 'No change was reported.',
          nodesChanged: strings(result?.nodes_changed),
          workflowName: nameFromN8n,
          failedNode,
          versionBefore,
          versionAfter,
          snapshot,
          model: claudeRun.model,
          activeBefore,
          activeRestored: restore.restored,
          activeNow: restore.now,
          publishedAt,
          agentRecovered: recovered,
          modelSuggestion,
          caller,
        },
      };
      await state.markPending(watch).catch((e) => logError(repairId, 'verify.pending.unsaved', errText(e)));
      watchForProof(watch);
    }
  } catch (e) {
    logError(repairId, 'failed', { error: errText(e) });

    // A run that ended on an error may still have switched the workflow off,
    // so the state is checked on this path too.
    const restore = await restoreActive({ repairId, workflowId, activeBefore });
    const activeSentence = activeNote(restore, activeBefore);

    await finish({
      request,
      repairId,
      startedAt,
      t0,
      outcome: 'error',
      rootCause: `The repair could not be carried out: ${errText(e)}`,
      changeSummary: `Nothing was changed, or nothing can be said about what was: the run ended on an error before it could be verified.${activeSentence ? ` ${activeSentence}` : ''}`,
      humanAction: activeSentence && !restore.restored ? activeSentence : 'Look at the bridge’s log for this repair id. The failure is in the bridge or in reaching n8n, not in the workflow.',
      activeBefore,
      activeRestored: restore.restored,
      activeNow: restore.now,
      workflowName: nameFromN8n,
      failedNode,
      versionBefore,
      versionAfter,
      retryExecutionId,
      snapshot,
    });
  } finally {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {});
    // The record exists to mark a repair that never reported. This one has.
    if (recorded) await state.clear(repairId).catch((e) => logError(repairId, 'state.clear.failed', errText(e)));
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

/* ------------------------------------------- proof from later real runs */

/**
 * When the fixed version was published: the last write n8n accepted, from the
 * scripts' own call log. Its clock is to the second, so the second is rounded
 * up — a run that started in that same second may have run the old version,
 * and a proof has to be one that could not have.
 */
function publishTime(calls) {
  const put = [...calls].reverse().find((c) => /^PUT$/i.test(c.method) && c.status >= 200 && c.status < 300);
  const at = put ? Date.parse(put.at) : NaN;
  return new Date(Number.isFinite(at) ? at + 999 : Date.now()).toISOString();
}

/** One look at the runs after the fix. A read that fails is "nothing yet", never a verdict. */
async function laterRunsOrNothing({ repairId, workflowId, sinceMs, signature, executionId }) {
  try {
    return await laterRuns({ workflowId, sinceMs, signature, excludeIds: [executionId] });
  } catch (e) {
    logError(repairId, 'verify.later_runs.unread', errText(e));
    return { passed: [], refused: [], otherFailures: [], failedSame: null, unread: errText(e) };
  }
}

const hhmm = (iso) => (iso ? String(iso).replace(/\.\d+Z$/, 'Z') : 'an unknown time');

function calledBy(caller) {
  if (caller?.agentRunId) return 'called by an agent';
  if (caller?.parentExecutionId) return `called by another workflow (execution ${caller.parentExecutionId})`;
  return 'called by an agent or another workflow';
}

/** The sentence that says how the fix was proved, or why it is not proved yet. */
function proofNote({ outcome, verification, later, publishedAt, verifyUntil, executionId, caller }) {
  if (verification !== 'later_runs' || !later) return null;
  const why = `Execution ${executionId} was not retried: it was ${calledBy(caller)}, so a retry would only replay that call's input.`;
  if (later.failedSame) {
    return `${why} A real run after the fix (published ${hhmm(publishedAt)}) failed the same way: execution ${later.failedSame.execution_id} at ${hhmm(later.failedSame.started_at)}.`;
  }
  if (later.passed.length) {
    return `${why} Verified by ${later.passed.length === 1 ? 'a later real run' : `${later.passed.length} later real runs`} after the fix was published at ${hhmm(publishedAt)}: execution ${named(later.passed)}.`;
  }
  if (outcome === 'repaired_pending') {
    return `${why} No real run has started since the fix was published at ${hhmm(publishedAt)}, so it is not proved yet. The bridge checks every ${Math.round(verifyPollMs() / 60000)} minutes until ${hhmm(verifyUntil)} and will send a second report.`;
  }
  return why;
}

function recoveredNote(r) {
  return `The agent recovered on its own after ${r.after_seconds}s: execution ${r.execution_id}, in the same agent run, succeeded.`;
}

function sameFailureAction(run, name) {
  return `Execution ${run.execution_id} at ${hhmm(run.started_at)} failed the same way after the fix, so the fix did not hold. Open that execution of ${name || 'the workflow'} in n8n and compare what it was called with against the root cause above.`;
}

/** The watches running now, by repair id. For /repairs/active, and so one repair is never watched twice. */
const watching = new Map();

export function pendingVerifications() {
  return [...watching.values()].map((w) => ({ repair_id: w.repair_id, workflow_id: w.workflow_id, since: new Date(w.since_ms).toISOString(), until: w.until }));
}

/**
 * Settles a `repaired_pending` repair with a second report (26 Sep 2026).
 *
 * Every `VERIFY_POLL_MS` (ten minutes) until `until` (a day after the fix):
 * a real successful run after the publish upgrades it to `repaired`, naming
 * the executions; a real run that fails the same way downgrades it to
 * `not_repaired`, naming that one. A day with neither is the one case the
 * evidence cannot settle, and only then is a person asked — for exactly that.
 *
 * Outside the queue on purpose: a day of waiting must not stop the next repair.
 */
export function watchForProof(watch, { pollMs = verifyPollMs() } = {}) {
  if (watching.has(watch.repair_id)) return;
  const entry = { ...watch, timer: null };
  watching.set(watch.repair_id, entry);
  const deadline = Date.parse(watch.until);
  log(watch.repair_id, 'verify.watching', { since: new Date(watch.since_ms).toISOString(), until: watch.until, every_ms: pollMs });

  const tick = async () => {
    const later = await laterRunsOrNothing({ repairId: watch.repair_id, workflowId: watch.workflow_id, sinceMs: watch.since_ms, signature: watch.signature, executionId: watch.execution_id });
    const settled = later.passed.length > 0 || Boolean(later.failedSame);
    const over = Date.now() >= deadline;
    log(watch.repair_id, 'verify.check', { passed: later.passed.map((r) => r.execution_id), failed_same: later.failedSame?.execution_id ?? null, over });

    if (!settled && !over) {
      entry.timer = setTimeout(tick, Math.min(pollMs, Math.max(0, deadline - Date.now())));
      entry.timer.unref?.();
      return;
    }
    watching.delete(watch.repair_id);
    try {
      await settle(watch, later);
    } catch (e) {
      logError(watch.repair_id, 'verify.settle.failed', errText(e));
    } finally {
      await state.clearPending(watch.repair_id).catch(() => {});
    }
  };

  entry.timer = setTimeout(tick, Math.min(pollMs, Math.max(0, deadline - Date.now())));
  entry.timer.unref?.();
}

/** The second report: the first one's facts, and what the later runs showed. */
async function settle(watch, later) {
  const r = watch.report;
  const outcome = later.failedSame ? 'not_repaired' : later.passed.length ? 'repaired' : 'needs_human';
  const proof = proofNote({ outcome, verification: 'later_runs', later, publishedAt: r.publishedAt, verifyUntil: watch.until, executionId: watch.execution_id, caller: r.caller });

  const extra = [proof];
  if (outcome === 'needs_human') {
    extra.push(
      later.unread
        ? `n8n could not be read at the last check (${later.unread}), so nothing after the fix could be judged.`
        : `No real run of the workflow started between ${hhmm(r.publishedAt)} and ${hhmm(watch.until)}${later.refused.length ? ` (only ${later.refused.length} that refused its input: ${named(later.refused)})` : ''}${later.otherFailures.length ? `, and ${later.otherFailures.length} that failed some other way: ${named(later.otherFailures)}` : ''}.`,
    );
  }
  if (r.agentRecovered) extra.push(recoveredNote(r.agentRecovered));

  const humanAction =
    outcome === 'not_repaired'
      ? sameFailureAction(later.failedSame, r.workflowName)
      : outcome === 'needs_human'
        ? `Unverified: whether the fix published at ${hhmm(r.publishedAt)} holds for a real call — nothing has called ${r.workflowName || 'the workflow'} since${later.unread ? ' that n8n would show this bridge' : ''}. The next real call settles it; if one is expected soon, look at that execution when it arrives.`
        : null;

  await finish({
    request: r.request,
    repairId: watch.repair_id,
    startedAt: r.startedAt,
    t0: Date.parse(r.startedAt),
    durationMs: r.durationMs,
    outcome,
    rootCause: r.rootCause,
    changeSummary: `${r.saidChange} ${extra.filter(Boolean).join(' ')}`,
    nodesChanged: r.nodesChanged,
    humanAction,
    workflowName: r.workflowName,
    failedNode: r.failedNode,
    versionBefore: r.versionBefore,
    versionAfter: r.versionAfter,
    snapshot: r.snapshot,
    model: r.model,
    activeBefore: r.activeBefore,
    activeRestored: r.activeRestored,
    activeNow: r.activeNow,
    verification: 'later_runs',
    verifiedBy: later.passed,
    failedAgain: later.failedSame,
    publishedAt: r.publishedAt,
    verifyUntil: watch.until,
    agentRecovered: r.agentRecovered,
    modelSuggestion: r.modelSuggestion,
    followUp: true,
  });
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
  activeBefore = null,
  activeRestored = false,
  activeNow = null,
  interrupted = false,
  durationMs: givenDuration = null,
  verification = null,
  verifiedBy = [],
  failedAgain = null,
  publishedAt = null,
  verifyUntil = null,
  agentRecovered = null,
  modelSuggestion = null,
  followUp = false,
}) {
  const finishedAt = new Date().toISOString();
  /** A follow-up report keeps the repair's own duration: a day of watching is not a slow repair. */
  const durationMs = givenDuration ?? Date.now() - t0;

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
    /**
     * The active state, as three plain fields.
     *
     * `active_restored` is the one to read: true means this repair switched the
     * workflow on or off and the bridge put it back. It is a field as well as a
     * sentence in `change_summary` because the dashboard stores the whole
     * payload, and a fact worth acting on should not need reading out of prose.
     */
    active_before: activeBefore,
    active_restored: Boolean(activeRestored),
    active_now: activeNow,
    ...(interrupted ? { interrupted_by_restart: true } : {}),
    ...(model ? { model } : {}),
    /**
     * How the fix was proved, and what proved it (26 Sep 2026). `verification`
     * is "retry" or "later_runs" (null where nothing was changed);
     * `verified_by` lists the later real runs that passed, `failed_again` the
     * one that failed the same way, `published_at` when the fixed version went
     * live, `verify_until` when a `repaired_pending` watch gives up.
     * `agent_recovered` says the caller got past the failure on its own, and
     * `model_suggestion` holds a request the model made that the evidence has
     * since answered. `follow_up` marks the second report of a pending repair.
     */
    verification,
    verified_by: verifiedBy,
    failed_again: failedAgain,
    published_at: publishedAt,
    verify_until: verifyUntil,
    agent_recovered: agentRecovered,
    model_suggestion: modelSuggestion,
    follow_up: followUp,
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
    active_restored: Boolean(activeRestored),
  });

  await reportBoth({ repairId, dashboardBody, webhookBody });
}

/* ------------------------------------------------------------- the restart */

/**
 * What boot does about repairs the last process did not finish.
 *
 * This is the whole reason the on-disk record exists. On 22 Sep three repairs
 * died with the process: nothing was reported, and three workflows were left
 * switched off. From the dashboard's side those repairs never happened.
 *
 * So for each record still on disk, in order:
 *
 * 1. Put the workflow's active state back if it differs from what was recorded
 *    before the run. This is the urgent half — a workflow switched off is not
 *    failing, it is not running at all.
 * 2. Report it to both places as `error`, because that is what it was: the
 *    bridge failed, and nothing is claimed about the workflow. `root_cause`
 *    says it was interrupted by a restart, and `interrupted_by_restart` is on
 *    the payload for anything that wants to count them.
 * 3. Clear the record, so a second restart does not report it twice.
 *
 * A record that cannot be read is still reported. We know a repair was running;
 * not knowing which workflow is a reason to tell somebody, not to stay quiet.
 */
export async function recover() {
  /**
   * Fixes still waiting for a later real run (26 Sep 2026). Their first report
   * went out as `repaired_pending`; the watch picks up where it was, with the
   * same deadline, so the second report still comes.
   */
  for (const watch of await state.pendingWatches()) {
    if (watch.unreadable) {
      logError(watch.repair_id, 'verify.pending.unreadable', 'A pending verification could not be read back after a restart, so it will not be settled automatically. Its row stays repaired_pending; look at the workflow’s runs since the fix.');
      await state.clearPending(watch.repair_id).catch(() => {});
      continue;
    }
    watchForProof(watch);
  }

  const records = await state.inFlight();
  if (records.length === 0) return { recovered: 0, repairs: [] };

  logError(null, 'recover.start', { in_flight: records.length, repairs: records.map((r) => r.repair_id) });

  const done = [];
  for (const record of records) {
    const repairId = record.repair_id;
    try {
      const restore = record.unreadable
        ? { checked: false, restored: false, now: null, error: 'the in-flight record could not be read' }
        : await restoreActive({ repairId, workflowId: record.workflow_id, activeBefore: record.active_before });
      const activeSentence = activeNote(restore, record.active_before);

      const startedAt = record.started_at ?? record.written_at ?? new Date().toISOString();
      const ran = Date.parse(startedAt);

      await finish({
        request: record.request ?? { workflow: { id: record.workflow_id, name: record.workflow_name }, execution: { id: record.execution_id } },
        repairId,
        startedAt,
        t0: Number.isFinite(ran) ? ran : Date.now(),
        outcome: 'error',
        rootCause: record.unreadable
          ? 'Interrupted by a restart. The bridge restarted while this repair was running, and its own record of it could not be read, so nothing is known about how far it got.'
          : `Interrupted by a restart. The bridge restarted while this repair was running — it was killed part-way through, so nothing is known about whether the workflow was changed.`,
        changeSummary: `Interrupted by a restart: this repair never reported because the process it was running in stopped.${activeSentence ? ` ${activeSentence}` : ''}`,
        humanAction: activeSentence && !restore.restored
          ? activeSentence
          : `Check ${record.workflow_name ?? record.workflow_id ?? 'this workflow'} in n8n: compare its current version with ${record.version_before ?? 'the one it was on before'} and decide whether a half-finished edit is sitting in it. The original failure has not been repaired.`,
        workflowName: record.workflow_name,
        versionBefore: record.version_before ?? null,
        activeBefore: record.active_before ?? null,
        activeRestored: restore.restored,
        activeNow: restore.now,
        interrupted: true,
      });

      done.push({ repair_id: repairId, active_restored: restore.restored });
    } catch (e) {
      logError(repairId, 'recover.failed', errText(e));
    } finally {
      // Cleared whatever happened: a record reported twice is its own problem,
      // and the log above carries anything that went wrong here.
      await state.clear(repairId).catch(() => {});
    }
  }

  logError(null, 'recover.done', { reported: done.length, repairs: done });
  return { recovered: done.length, repairs: done };
}
