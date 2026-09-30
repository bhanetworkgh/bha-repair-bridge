/**
 * The workflow's own repair history, read from the dashboard (30 Sep 2026).
 *
 * Builder Chasers was diagnosed nine times and each run started from nothing,
 * so each one tried a fix an earlier run had already seen fail. The model now
 * reads what was tried before on this workflow, what it concluded and whether
 * the change was put back. A read that fails is said plainly in the prompt and
 * never stops a repair.
 */
import { env } from './config.js';

export async function pastRepairs(workflowId, { limit = 6 } = {}) {
  const base = env('DASHBOARD_URL');
  const key = env('DASHBOARD_INBOUND_KEY');
  if (!base || !key || !workflowId) return { ok: false, repairs: [], error: 'the dashboard is not configured on this service' };
  const url = `${base.replace(/\/+$/, '')}/api/engine/repairs?workflow_id=${encodeURIComponent(workflowId)}&limit=${limit}`;
  try {
    const res = await fetch(url, { headers: { 'x-dashboard-key': key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, repairs: [], error: `the dashboard answered ${res.status}` };
    const body = await res.json();
    const rows = Array.isArray(body?.repairs) ? body.repairs : [];
    return {
      ok: true,
      repairs: rows.map((r) => ({
        repair_id: r.repair_id,
        at: r.finished_at ?? r.started_at ?? null,
        outcome: r.outcome,
        failed_node: r.failed_node,
        root_cause: String(r.root_cause ?? '').slice(0, 600),
        change_summary: String(r.change_summary ?? '').slice(0, 600),
        nodes_changed: r.nodes_changed ?? [],
        reverted: Boolean(r.reverted_at),
      })),
    };
  } catch (e) {
    return { ok: false, repairs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The prompt's section on it. */
export function historyText(h) {
  if (!h?.ok) return `  (could not be read: ${h?.error ?? 'unknown'}; treat this as a first repair)`;
  if (!h.repairs.length) return '  None. This is the first repair of this workflow on record.';
  return h.repairs
    .map((r) => `  - ${r.at ?? '?'} ${r.repair_id}: ${r.outcome}${r.reverted ? ' (the change was PUT BACK)' : ''}, failed node "${r.failed_node ?? '?'}"\n    cause: ${r.root_cause || '(none recorded)'}\n    change: ${r.change_summary || '(none)'}`)
    .join('\n');
}
