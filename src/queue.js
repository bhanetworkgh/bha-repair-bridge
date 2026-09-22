/**
 * One repair at a time, across every workflow.
 *
 * Written after the 08:00 incident on 22 Sep 2026: three repairs were accepted
 * within seconds of each other, three Claude Code runs started together on a
 * starter instance, the service ran out of memory and was restarted at
 * 08:02:49, and the three North Star workflows came out of it switched off with
 * nothing saved. The old lock was per workflow, so three different workflows
 * were three permitted concurrent runs. That was the bug.
 *
 * So the lock is global now. A repair either runs or waits, and the queue is
 * FIFO: the failure reported first is repaired first.
 *
 * What has not changed is the deduplication. A workflow already running or
 * already waiting is skipped rather than queued twice — two runs editing one
 * workflow would overwrite each other whether they are concurrent or merely
 * consecutive, and a queue of near-identical repairs is how a five-minute
 * outage becomes an hour of them.
 */

/** The one running repair, or null. */
let running = null;

/** Waiting repairs, oldest first. */
const waiting = [];

/** What is running and what is waiting, for /health and the active list. */
export function snapshot() {
  return {
    running: running ? { ...running.entry } : null,
    queued: waiting.map((w) => ({ ...w.entry })),
  };
}

export function busy() {
  return (running ? 1 : 0) + waiting.length;
}

export function runningCount() {
  return running ? 1 : 0;
}

export function queuedCount() {
  return waiting.length;
}

/** Whether this workflow already has a repair running or waiting, and which. */
export function heldBy(workflowId) {
  if (running && running.entry.workflow_id === workflowId) return { repair_id: running.entry.repair_id, state: 'running' };
  const queuedFor = waiting.find((w) => w.entry.workflow_id === workflowId);
  return queuedFor ? { repair_id: queuedFor.entry.repair_id, state: 'queued' } : null;
}

/**
 * Puts a repair in the queue and returns where it landed.
 *
 * `job` is run when its turn comes; the promise it returns is awaited before
 * the next one starts. A job that throws does not stop the queue — the next
 * repair still gets its turn, because one bad repair must not stop the others
 * from ever being reported.
 */
export function enqueue({ repairId, workflowId, job, onStart = () => {} }) {
  const entry = { repair_id: repairId, workflow_id: workflowId, queued_at: new Date().toISOString(), position: waiting.length + (running ? 1 : 0) };
  waiting.push({ entry, job, onStart });
  const position = entry.position;
  void pump();
  return { position, waiting_for: running ? running.entry.repair_id : null };
}

async function pump() {
  if (running) return;
  const next = waiting.shift();
  if (!next) return;

  running = next;
  next.entry.started_at = new Date().toISOString();
  try {
    next.onStart(next.entry);
    await next.job();
  } catch {
    // The job reports its own failures; the queue's only duty is to keep going.
  } finally {
    running = null;
    // Positions are only meaningful while a repair waits, so they are recomputed
    // rather than left saying what was true when it was accepted.
    waiting.forEach((w, i) => {
      w.entry.position = i + 1;
    });
    void pump();
  }
}

/** Waits until nothing is running or waiting. For shutdown and for tests. */
export async function idle(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (busy() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return busy() === 0;
}

/** Empties the queue. Only for tests — a dropped repair is a repair nobody reports. */
export function reset() {
  waiting.length = 0;
  running = null;
}
