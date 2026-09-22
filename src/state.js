/**
 * What a repair leaves on disk, so a restart cannot erase it.
 *
 * On 22 Sep 2026 the service ran out of memory and was restarted mid-repair.
 * Three repairs vanished with the process: nothing was reported, and three
 * workflows were left switched off with no edit saved. From the dashboard's
 * side those repairs simply never happened, which is the one thing this service
 * is not allowed to do.
 *
 * So a repair writes a small file when it starts and deletes it when it has
 * reported. A file still there at boot is therefore a repair that was killed,
 * and boot does what the repair itself could not: puts the workflow's active
 * state back and reports the interruption to both places.
 *
 * The file holds only what recovery needs — the ids, the names, the active
 * state as it was before the run, and the original request so the report can
 * carry it. It is written once, at the start, because a file rewritten through
 * a repair is a file that can be half-written when the process dies.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Where the files live.
 *
 * `STATE_DIR` on Render if a disk is ever attached; otherwise the instance's
 * own tmp, which survives a process restart — which is exactly the failure this
 * exists for. A redeploy starts a fresh container and takes the directory with
 * it, and that is fine: a deploy is not a crash, and a repair killed by one was
 * killed by somebody who knows they did it.
 */
export function stateDir() {
  return process.env.STATE_DIR?.trim() || path.join(tmpdir(), 'bha-repair-bridge');
}

const fileFor = (repairId) => path.join(stateDir(), `${encodeURIComponent(repairId)}.json`);

/** Records a repair as in flight. Called before Claude Code starts, never after. */
export async function markRunning(record) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await writeFile(fileFor(record.repair_id), JSON.stringify({ ...record, written_at: new Date().toISOString() }, null, 2));
}

/** Clears a repair that has reported. A repair that reported is not interrupted. */
export async function clear(repairId) {
  await rm(fileFor(repairId), { force: true });
}

/**
 * Every repair that was in flight when the process died.
 *
 * A file that cannot be read or parsed is reported as such rather than skipped:
 * a record we cannot read is still evidence that something was running, and
 * dropping it silently would be the same failure in a smaller form.
 */
export async function inFlight() {
  let names;
  try {
    names = await readdir(stateDir());
  } catch {
    return [];
  }

  const records = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(stateDir(), name);
    try {
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record && typeof record === 'object' && record.repair_id) records.push(record);
      else records.push({ repair_id: decodeURIComponent(name.replace(/\.json$/, '')), unreadable: true });
    } catch {
      records.push({ repair_id: decodeURIComponent(name.replace(/\.json$/, '')), unreadable: true });
    }
  }
  return records;
}
