/**
 * The same diagnosis twice is a person's call, not a third attempt (30 Sep 2026).
 *
 * Builder Chasers was diagnosed the same way nine times over a day and each attempt was
 * reverted, and every report said a person might want to look. Nobody was handed
 * anything to apply. From the second matching diagnosis that did not end in a repair, the
 * report now leads with a ready-to-apply patch: the exact node changes the repair made
 * (or its proposed fix where it made none), so the person's job is to read it and paste
 * it, not to redo the diagnosis.
 *
 * "The same" is deliberately loose: same workflow, same failed node, and a root cause
 * whose words overlap by half. Numbers and ids are dropped first so an execution id cannot
 * make two identical diagnoses look different. The record lives on disk beside the
 * in-flight repairs so a restart does not forget it. A repair that succeeds clears it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './state.js';

const WINDOW_MS = 48 * 60 * 60 * 1000;
const KEEP = 20;
const file = () => path.join(stateDir(), 'repeat-diagnoses.json');

export function words(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[0-9a-f]{8,}|\d+/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3),
  );
}

export function similar(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.5;
}

async function read() {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function write(all) {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(file(), JSON.stringify(all));
}

const keyOf = (workflowId, failedNode) => `${workflowId ?? 'unknown'}::${failedNode ?? 'unknown'}`;

/**
 * Notes one diagnosis that did not end in a repair and says how many recent ones agree.
 * `count` includes this one; 2 or more is the escalation. Never throws: a note that cannot
 * be kept must not cost the report.
 */
export async function noteDiagnosis({ workflowId, failedNode, rootCause, repairId, now = Date.now() }) {
  try {
    const all = await read();
    const key = keyOf(workflowId, failedNode);
    const kept = (all[key] ?? []).filter((e) => now - e.at < WINDOW_MS);
    const agreeing = kept.filter((e) => similar(e.root_cause, rootCause) && e.repair_id !== repairId);
    kept.push({ at: now, repair_id: repairId, root_cause: String(rootCause ?? '').slice(0, 600) });
    all[key] = kept.slice(-KEEP);
    await write(all);
    return { count: agreeing.length + 1, since: agreeing[0] ? new Date(agreeing[0].at).toISOString() : null, repair_ids: agreeing.map((e) => e.repair_id) };
  } catch {
    return { count: 1, since: null, repair_ids: [] };
  }
}

/** A repair that worked ends the run of failures for that workflow and node. */
export async function clearDiagnoses({ workflowId, failedNode }) {
  try {
    const all = await read();
    delete all[keyOf(workflowId, failedNode)];
    await write(all);
  } catch {
    /* nothing to forget */
  }
}
