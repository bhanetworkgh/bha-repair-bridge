/**
 * Prepared fixes: drafted, tested, applied by a person, proved, undone if wrong
 * (30 Sep 2026).
 *
 * The six agent-facing workflows and the agents' own settings are never changed
 * live by this service. Instead Claude Code edits their DRAFT through n8n's MCP
 * server (a draft is not live until published), tests the draft with pinned
 * data, and the bridge checks every part of that itself: the draft moved, the
 * live version did not, the tests it names exist, ran after the repair started,
 * on this workflow, and passed. What a person then gets is an Apply button.
 *
 * Apply re-checks that the draft is still the one tested and the live version is
 * still the one recorded, publishes exactly that draft, and then proves it: a
 * workflow by the next real runs (a same-way failure republishes the old
 * version), an agent by an eval run (a case that passed before and fails now
 * republishes the old version). Discard throws the draft away, so it can never
 * ship by accident when somebody publishes that workflow for another reason.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, verifyPollMs, verifyWindowMs } from './config.js';
import { errText, log, logError } from './log.js';
import * as mcp from './mcp.js';
import * as n8n from './n8n.js';
import { stateDir } from './state.js';
import { failureSignature, laterRuns, named } from './verify.js';

/** Which agent sits behind each agent-facing workflow. */
export const AGENT_FOR_WORKFLOW = {
  '134ezjaO6gYqYjez': { id: 'Nw5igXu4WWrjUMWB', key: 'bays', name: 'Bays' },
  '5AFqtZQaeKFFiGqe': { id: 'Nw5igXu4WWrjUMWB', key: 'bays', name: 'Bays' },
  '6S4X6UYtDpETB6u6': { id: '8NQRXadH0OrKe5XV', key: 'north_star', name: 'North Star' },
  cnOz6iomtnWVXjso: { id: '8NQRXadH0OrKe5XV', key: 'north_star', name: 'North Star' },
  K1iQ72ZTEzQKrxb9: { id: 'dDtsExaaXhlFd2dv', key: 'research_twin', name: 'Research Twin' },
  w4SdZjjpokMuWPkV: { id: 'dDtsExaaXhlFd2dv', key: 'research_twin', name: 'Research Twin' },
};

export const EVALS_WORKFLOW_ID = '8nv31oanjnkEGHie';

/** What Claude Code may call on n8n's MCP server in a prepare run. Nothing that publishes, runs for real, deletes or archives. */
export const PREPARE_TOOLS = [
  'get_workflow_details',
  'get_workflow_execution',
  'get_workflow_version',
  'get_workflow_history',
  'get_node_types',
  'search_nodes',
  'validate_node_config',
  'validate_workflow',
  'update_workflow',
  'prepare_workflow_pin_data',
  'test_workflow',
  'get_agent',
  'mutate_agent',
  'validate_agent',
  'list_agent_versions',
  'get_agent_builder_reference',
].map((t) => `mcp__n8n__${t}`);

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
};

/** One hash for everything about an agent that publishing would change. Task timestamps and order are noise. */
export function agentFingerprint(a) {
  const tasks = (a?.tasks ?? []).map(({ createdAt, updatedAt, ...t }) => t).sort((x, y) => String(x.id).localeCompare(String(y.id)));
  return createHash('sha256').update(stable({ config: a?.config ?? null, skills: a?.skills ?? null, customTools: a?.customTools ?? null, tasks })).digest('hex').slice(0, 16);
}

export async function workflowState(workflowId) {
  const d = await mcp.callTool('get_workflow_details', { workflowId });
  const w = d?.workflow ?? d ?? {};
  return { versionId: w.versionId ?? null, activeVersionId: w.activeVersionId ?? null, active: Boolean(w.active) };
}

export async function agentState(agentId) {
  const draft = await mcp.callTool('get_agent', { agentId });
  const activeVersionId = draft?.agent?.activeVersionId ?? null;
  const live = activeVersionId ? await mcp.callTool('get_agent', { agentId, versionId: activeVersionId }) : null;
  const draftHash = agentFingerprint(draft);
  const liveHash = live ? agentFingerprint(live) : null;
  return { activeVersionId, draftHash, liveHash, clean: Boolean(liveHash && draftHash === liveHash) };
}

/**
 * Before a prepare run: may this workflow and its agent be drafted at all? A draft
 * that already differs from live is someone's unpublished work, and publishing
 * the healer's fix would ship it too.
 */
export async function beforePrepare(workflowId) {
  const wf = await workflowState(workflowId);
  const agentRef = AGENT_FOR_WORKFLOW[workflowId] ?? null;
  const agent = agentRef ? { ...agentRef, ...(await agentState(agentRef.id)) } : null;
  return {
    workflow: wf,
    workflowClean: Boolean(wf.versionId && wf.versionId === wf.activeVersionId),
    agent,
  };
}

/** Test executions the model named: real, on this workflow, after the start, and the last one passed. */
export async function checkTests({ ids, workflowId, sinceMs }) {
  const seen = [];
  for (const id of (Array.isArray(ids) ? ids : []).map(String).slice(0, 10)) {
    try {
      const e = await n8n.execution(id, { includeData: false });
      const started = Date.parse(e?.startedAt ?? '');
      seen.push({ id, workflow_ok: String(e?.workflowId) === String(workflowId), after_start: Number.isFinite(started) && started >= sinceMs - 5000, status: e?.status ?? null, passed: n8n.succeeded(e?.status) });
    } catch (err) {
      seen.push({ id, error: errText(err), passed: false });
    }
  }
  const valid = seen.filter((t) => t.workflow_ok && t.after_start);
  const last = valid[valid.length - 1];
  return { tests: seen, passed: Boolean(last?.passed), valid: valid.map((t) => t.id) };
}

/**
 * After a prepare run: what actually changed. The live version moving is the one
 * thing that must never happen; if it did, it is put straight back.
 */
export async function afterPrepare({ repairId, workflowId, before, testIds, sinceMs }) {
  const out = { workflowDraft: null, agentDraft: null, published: [], restored: [], tests: null, problems: [] };

  const wf = await workflowState(workflowId);
  if (wf.activeVersionId !== before.workflow.activeVersionId) {
    out.published.push('workflow');
    logError(repairId, 'prepare.live_changed', { was: before.workflow.activeVersionId, now: wf.activeVersionId });
    try {
      await mcp.callTool('publish_workflow', { workflowId, versionId: before.workflow.activeVersionId });
      out.restored.push('workflow');
    } catch (e) {
      out.problems.push(`The live workflow changed during the run and could not be put back: ${errText(e)}`);
    }
  }
  if (before.workflowClean && wf.versionId && wf.versionId !== before.workflow.versionId) {
    out.workflowDraft = { draft_version: wf.versionId, restore_version: before.workflow.activeVersionId };
  }

  if (before.agent) {
    const a = await agentState(before.agent.id);
    if (a.activeVersionId !== before.agent.activeVersionId) {
      out.published.push('agent');
      try {
        await mcp.callTool('publish_agent', { agentId: before.agent.id, versionId: before.agent.activeVersionId });
        out.restored.push('agent');
      } catch (e) {
        out.problems.push(`The live agent changed during the run and could not be put back: ${errText(e)}`);
      }
    }
    if (before.agent.clean && a.draftHash !== before.agent.draftHash) {
      let valid = false;
      let validation = null;
      try {
        validation = await mcp.callTool('validate_agent', { agentId: before.agent.id });
        valid = validation?.valid === true || validation?.ok === true;
      } catch (e) {
        validation = { error: errText(e) };
      }
      out.agentDraft = { agent_id: before.agent.id, agent_key: before.agent.key, draft_version: a.draftHash, restore_version: before.agent.activeVersionId, valid, validation };
    }
  }

  if (out.workflowDraft) out.tests = await checkTests({ ids: testIds, workflowId, sinceMs });

  // Anything else the run touched. Drafts are not live, but a stray one would ship the next time
  // somebody publishes that workflow, so it is named for a person (never auto-restored: that could
  // throw away a colleague's work in progress).
  try {
    const others = (await n8n.workflowsUpdatedSince(sinceMs)).filter((w) => w.id !== String(workflowId));
    if (others.length) out.problems.push(`Other workflows changed while this ran (possibly by people, possibly by the run): ${others.map((w) => `${w.name ?? w.id} (${w.id})`).join(', ')}. Check their drafts before anyone publishes them.`);
  } catch {
    /* unread is not a finding */
  }
  return out;
}

/** Throws a prepared draft away. Never throws itself: says what it could not do. */
export async function discardDraft(fix) {
  try {
    if (fix.kind === 'agent') await mcp.callTool('revert_agent', { agentId: fix.agent_id, versionId: fix.restore_version });
    else await mcp.callTool('restore_workflow_version', { workflowId: fix.workflow_id, versionId: fix.restore_version });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ------------------------------------------------------------ apply and prove */

const appliedDir = () => path.join(stateDir(), 'applied');
const appliedFile = (id) => path.join(appliedDir(), `${encodeURIComponent(id)}.json`);

async function postOutcome(repairId, body) {
  const base = env('DASHBOARD_URL');
  const key = env('DASHBOARD_INBOUND_KEY');
  if (!base || !key) return logError(repairId, 'prepared.outcome.unconfigured', body);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${base.replace(/\/+$/, '')}/api/engine/repairs/${encodeURIComponent(repairId)}/prepared-outcome`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-key': key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) return log(repairId, 'prepared.outcome.sent', { state: body.state });
      logError(repairId, 'prepared.outcome.refused', { status: r.status, body: (await r.text()).slice(0, 300) });
    } catch (e) {
      logError(repairId, 'prepared.outcome.failed', errText(e));
    }
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
  }
  logError(repairId, 'prepared.outcome.undelivered', body);
}

/**
 * Apply. Refuses unless the draft is exactly the one tested and live is exactly
 * the one recorded. Returns at once after publishing; the proof runs behind it.
 */
export async function apply({ repairId, fix, executionId, failedNode }) {
  if (!mcp.configured()) return { ok: false, message: 'N8N_MCP_URL and N8N_MCP_TOKEN are not set on the bridge, so nothing can be published.' };
  try {
    if (fix.kind === 'workflow') {
      const now = await workflowState(fix.workflow_id);
      if (now.activeVersionId !== fix.restore_version) return { ok: false, message: `The live workflow has changed since the fix was prepared (it is on ${now.activeVersionId}, the fix was tested against ${fix.restore_version}). Nothing was published.` };
      if (now.versionId !== fix.draft_version) return { ok: false, message: `The draft has been edited since it was tested (it is ${now.versionId}, the tested draft was ${fix.draft_version}). Nothing was published.` };
      await mcp.callTool('publish_workflow', { workflowId: fix.workflow_id, versionId: fix.draft_version });
      const after = await workflowState(fix.workflow_id);
      if (after.activeVersionId !== fix.draft_version) return { ok: false, message: `n8n accepted the publish but reports live version ${after.activeVersionId}, not ${fix.draft_version}. Check the workflow's history.` };
      let signature = null;
      try {
        signature = failureSignature(await n8n.execution(executionId, { includeData: true }), failedNode);
      } catch {
        /* the watch still runs; without a signature any failure of the node counts */
      }
      const watch = { repair_id: repairId, fix, since_ms: Date.now(), until: new Date(Date.now() + verifyWindowMs()).toISOString(), signature, execution_id: executionId };
      await persist(watch);
      watchWorkflow(watch);
      return { ok: true, state: 'applied', message: `Published version ${fix.draft_version}. The healer is now watching real runs: if one fails the same way, the old version ${fix.restore_version} goes back automatically.` };
    }

    // An agent.
    const now = await agentState(fix.agent_id);
    if (now.activeVersionId !== fix.restore_version) return { ok: false, message: `The live agent has been republished since the fix was prepared. Nothing was published.` };
    if (now.draftHash !== fix.draft_version) return { ok: false, message: 'The agent draft has been edited since the fix was prepared. Nothing was published.' };
    const baseline = await latestEvalBaseline(fix.agent_key);
    await mcp.callTool('publish_agent', { agentId: fix.agent_id });
    const after = await agentState(fix.agent_id);
    const watch = { repair_id: repairId, fix: { ...fix, published_version: after.activeVersionId }, since_ms: Date.now(), baseline };
    await persist(watch);
    void proveAgent(watch);
    return { ok: true, state: 'applied', message: `Published the ${fix.agent_key.replace('_', ' ')} agent draft as ${after.activeVersionId}. The eval set is running now: any case that passed before and fails now puts the old version ${fix.restore_version} back automatically.` };
  } catch (e) {
    return { ok: false, message: `Nothing was confirmed published: ${errText(e)}` };
  }
}

export async function discard({ fix }) {
  if (!mcp.configured()) return { ok: false, message: 'N8N_MCP_URL and N8N_MCP_TOKEN are not set on the bridge.' };
  const r = await discardDraft(fix);
  return r.ok ? { ok: true, state: 'discarded', message: 'The prepared draft was thrown away; the draft now matches the live version.' } : { ok: false, message: `The draft could not be discarded: ${r.error}` };
}

async function persist(watch) {
  await mkdir(appliedDir(), { recursive: true });
  await writeFile(appliedFile(watch.repair_id), JSON.stringify(watch));
}

async function forget(id) {
  await rm(appliedFile(id), { force: true }).catch(() => {});
}

/** At boot: every applied fix still being proved picks up where it was. */
export async function resumeApplied() {
  let names = [];
  try {
    names = await readdir(appliedDir());
  } catch {
    return 0;
  }
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try {
      const w = JSON.parse(await readFile(path.join(appliedDir(), n), 'utf8'));
      if (w.fix?.kind === 'agent') void proveAgent(w);
      else watchWorkflow(w);
    } catch (e) {
      logError(null, 'prepared.resume.unreadable', { file: n, error: errText(e) });
    }
  }
  return names.length;
}

export function watchWorkflow(watch, { pollMs = verifyPollMs() } = {}) {
  const deadline = Date.parse(watch.until);
  const tick = async () => {
    let later;
    try {
      later = await laterRuns({ workflowId: watch.fix.workflow_id, sinceMs: watch.since_ms, signature: watch.signature, excludeIds: [watch.execution_id] });
    } catch (e) {
      later = { passed: [], failedSame: null, unread: errText(e) };
    }
    if (later.failedSame) {
      let back = 'and the old version was put back';
      try {
        await mcp.callTool('publish_workflow', { workflowId: watch.fix.workflow_id, versionId: watch.fix.restore_version });
      } catch (e) {
        back = `and the old version could NOT be put back automatically (${errText(e)}): republish ${watch.fix.restore_version} by hand`;
      }
      await postOutcome(watch.repair_id, { state: 'reverted', message: `Real run ${later.failedSame.execution_id} failed the same way after the fix was applied, ${back}.`, evidence: { failed_again: later.failedSame } });
      return forget(watch.repair_id);
    }
    if (later.passed?.length) {
      await postOutcome(watch.repair_id, { state: 'held', message: `Proved by ${later.passed.length === 1 ? 'a real run' : `${later.passed.length} real runs`} after the fix was applied: ${named(later.passed)}.`, evidence: { verified_by: later.passed } });
      return forget(watch.repair_id);
    }
    if (Date.now() >= deadline) {
      await postOutcome(watch.repair_id, { state: 'unproven', message: 'The fix is live, but no real run happened inside the watch window, so it is not proved either way.' });
      return forget(watch.repair_id);
    }
    const t = setTimeout(tick, Math.min(pollMs, Math.max(1000, deadline - Date.now())));
    t.unref?.();
  };
  const t = setTimeout(tick, Math.min(pollMs, Math.max(1000, deadline - Date.now())));
  t.unref?.();
}

/* ------------------------------------------------------------------ evals */

async function evalRows(query) {
  const base = env('DASHBOARD_URL');
  const key = env('DASHBOARD_INBOUND_KEY');
  const r = await fetch(`${base.replace(/\/+$/, '')}/api/engine/eval-runs?limit=1000${query}`, { headers: { 'x-dashboard-key': key }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`the dashboard answered ${r.status} for eval runs`);
  const body = await r.json();
  return (body.rows ?? body.records ?? []).map((x) => x.fields ?? {});
}

/** Per case, whether every repeat passed, for one agent in one run. */
export function passByCase(rows, agentKey) {
  const out = {};
  for (const f of rows) {
    if (f.Agent !== agentKey) continue;
    const k = f['Case ID'];
    out[k] = (out[k] ?? true) && f.Passed === true;
  }
  return out;
}

export function regressions(before, after) {
  return Object.keys(before).filter((k) => before[k] === true && after[k] === false);
}

async function latestEvalBaseline(agentKey) {
  try {
    const rows = await evalRows('');
    const runs = [...new Set(rows.filter((f) => f.Agent === agentKey).map((f) => f['Run ID']))].sort();
    const run = runs[runs.length - 1];
    return run ? { run_id: run, cases: passByCase(rows.filter((f) => f['Run ID'] === run), agentKey) } : null;
  } catch (e) {
    return { error: errText(e) };
  }
}

async function proveAgent(watch) {
  const id = watch.repair_id;
  try {
    const started = await mcp.callTool('execute_workflow', { workflowId: EVALS_WORKFLOW_ID, executionMode: 'manual' });
    const execId = String(started?.executionId ?? '');
    if (!execId) throw new Error('the eval runner did not start');
    log(id, 'prepared.evals.started', { execution_id: execId });
    const waited = await n8n.waitForExecution(execId, { timeoutMs: 45 * 60 * 1000, pollMs: 20_000 });
    const exec = await n8n.execution(execId, { includeData: true });
    const summary = exec?.data?.resultData?.runData?.['Summarise Run']?.[0]?.data?.main?.[0]?.[0]?.json ?? null;
    if (!summary?.run_id) {
      await postOutcome(id, { state: 'unproven', message: `The fix is live, but the eval run (execution ${execId}, ${waited.status}) did not finish with a summary, so it is not proved. Run the evals by hand.` });
      return forget(id);
    }
    const now = passByCase(await evalRows(`&f.Run%20ID=${encodeURIComponent(summary.run_id)}`), watch.fix.agent_key);
    const before = watch.baseline?.cases ?? {};
    const broke = regressions(before, now);
    if (broke.length) {
      let back = 'the old version was put back';
      try {
        await mcp.callTool('publish_agent', { agentId: watch.fix.agent_id, versionId: watch.fix.restore_version });
      } catch (e) {
        back = `the old version could NOT be put back automatically (${errText(e)}): republish ${watch.fix.restore_version} by hand`;
      }
      await postOutcome(id, { state: 'reverted', message: `Eval run ${summary.run_id} broke ${broke.length} case(s) that passed in ${watch.baseline?.run_id}: ${broke.join(', ')}. ${back}.`, evidence: { eval_run: summary.run_id, baseline: watch.baseline?.run_id, regressions: broke } });
    } else {
      const passed = Object.values(now).filter(Boolean).length;
      await postOutcome(id, { state: 'held', message: `Eval run ${summary.run_id}: ${passed} of ${Object.keys(now).length} ${watch.fix.agent_key.replace('_', ' ')} cases pass, and nothing that passed in ${watch.baseline?.run_id ?? 'the last run'} fails now.`, evidence: { eval_run: summary.run_id, baseline: watch.baseline?.run_id ?? null } });
    }
  } catch (e) {
    logError(id, 'prepared.evals.failed', errText(e));
    await postOutcome(id, { state: 'unproven', message: `The fix is live, but the eval run could not be completed (${errText(e)}). Run the evals by hand.` });
  }
  return forget(id);
}
