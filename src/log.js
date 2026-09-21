/**
 * One log line per step, and every line carries its repair_id.
 *
 * A repair is an async job nobody watches while it runs, so the log is the only
 * account of it. JSON lines, because Render's log search is a text box and
 * `repair_id` is the thing anybody will paste into it.
 */

function emit(stream, repairId, step, detail) {
  const line = {
    at: new Date().toISOString(),
    repair_id: repairId || '-',
    step,
    ...(detail === undefined ? {} : { detail }),
  };
  stream(JSON.stringify(line));
}

export function log(repairId, step, detail) {
  emit(console.log, repairId, step, detail);
}

/** Loud, for the things that must never pass unnoticed — chiefly a report that would not send. */
export function logError(repairId, step, detail) {
  emit(console.error, repairId, step, detail);
}

/** What is safe to log of an error: its message, never its stack of headers. */
export function errText(e) {
  if (!e) return 'unknown error';
  if (e instanceof Error) return e.message;
  return String(e);
}
