/**
 * Crashes: one retry, then a diagnosis (30 Sep 2026).
 *
 * A crashed or out-of-memory execution was refused outright: no workflow bug to
 * find. Most crashes are one-offs (the instance was busy), so the first crash of
 * a workflow in 24 hours is now retried once after a pause. A second crash of the
 * same workflow inside 24 hours is not a one-off: it gets a diagnosis run aimed at
 * memory (which node holds the most data, what would shrink it), proposed to a
 * person and never written, because it changes how the workflow runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateDir } from './state.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const file = () => path.join(stateDir(), 'crashes', 'crashes.json');

function load() {
  try {
    const o = JSON.parse(readFileSync(file(), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** Records a crash and says how many this workflow has had in the last 24 hours, this one included. */
export function noteCrash(workflowId, now = Date.now()) {
  const all = load();
  const recent = (all[workflowId] ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  all[workflowId] = recent.slice(-10);
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(all));
  } catch {
    /* best effort: a lost count means one more retry, never a silence */
  }
  return recent.length;
}

export function crashRetryDelayMs() {
  const n = Number(process.env.CRASH_RETRY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

/** How much data each node produced in the crashed run, largest first: where memory went. */
export function nodeSizes(execution) {
  const runData = execution?.data?.resultData?.runData ?? {};
  return Object.entries(runData)
    .map(([name, runs]) => {
      let items = 0;
      let bytes = 0;
      for (const r of Array.isArray(runs) ? runs : []) {
        for (const branch of r?.data?.main ?? []) {
          if (!Array.isArray(branch)) continue;
          items += branch.length;
          try { bytes += JSON.stringify(branch).length; } catch { /* circular: skip */ }
        }
      }
      return { node: name, items, bytes };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
}
