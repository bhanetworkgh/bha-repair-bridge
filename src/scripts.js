/**
 * The two scripts Claude Code is given instead of the n8n API.
 *
 * Written after the first live repairs (21 Sep 2026): the first one saved, the
 * second got a 401 from n8n on the same key, because the model wrote its own
 * curl and got the authentication wrong. The key was never the problem — the
 * hand-rolled call was.
 *
 * So the model does not build n8n calls any more. It gets two scripts that
 * already know the URL, the workflow id and the header, and the prompt tells it
 * these are the only way to reach n8n. The key is not in the prompt and is not
 * in any command the model writes: the scripts read it from their own
 * environment and send it themselves.
 *
 * Both scripts append one line per call to a log this service reads afterwards.
 * That log is why a failed write cannot end as a quiet "repaired": the bridge
 * sees the status n8n actually returned, whatever the model says about it.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const GET_SCRIPT = 'n8n-get-workflow.sh';
export const PUT_SCRIPT = 'n8n-put-workflow.sh';
export const CALL_LOG = '.n8n-calls.log';

/** POSIX single-quoting, so a workflow id can never break out of the script. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The shared head of both scripts: the environment they need and where they log. */
function preamble(workflowId) {
  return `#!/bin/sh
# Written by bha-repair-bridge for this repair. Do not edit.
#
# The n8n API key is read from the environment here and sent by this script.
# Never write your own curl and never put the key in a command: the last repair
# that did failed with a 401.
set -eu

if [ -z "\${N8N_BASE_URL:-}" ]; then echo "N8N_BASE_URL is not set in this environment." >&2; exit 3; fi
if [ -z "\${N8N_API_KEY:-}" ]; then echo "N8N_API_KEY is not set in this environment." >&2; exit 3; fi

WORKFLOW_ID=${shellQuote(encodeURIComponent(workflowId))}
URL="\${N8N_BASE_URL%/}/api/v1/workflows/\$WORKFLOW_ID"
LOG=\${N8N_CALL_LOG:-"\$(dirname "\$0")/${CALL_LOG}"}

note() {
  # one line per call: when, method, status, and the first of the answer
  printf '%s\\t%s\\t%s\\t%s\\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\$1" "\$2" "\$(tr '\\n\\t' '  ' < "\$3" | cut -c1-1000)" >> "\$LOG" 2>/dev/null || true
}
`;
}

/** `./n8n-get-workflow.sh` — the workflow, as JSON, on stdout. */
export function getScriptSource(workflowId) {
  return `${preamble(workflowId)}
body=$(mktemp)
status=$(curl -sS -o "$body" -w '%{http_code}' \\
  -H "X-N8N-API-KEY: $N8N_API_KEY" \\
  -H 'accept: application/json' \\
  "$URL" || echo 000)

note GET "$status" "$body"

if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
  cat "$body"
  rm -f "$body"
  exit 0
fi

echo "HTTP $status" >&2
cat "$body" >&2
echo >&2
rm -f "$body"
exit 1
`;
}

/**
 * `./n8n-put-workflow.sh <file.json>` — sends the workflow back.
 *
 * Only `name`, `nodes`, `connections` and `settings` are sent: n8n refuses a
 * PUT carrying the read-only fields it hands out (id, versionId, active,
 * createdAt, tags), and the model should not have to remember which those are.
 * `active` is not sent for a second reason — a write that switched a live
 * workflow on or off would be a change nobody asked for.
 */
export function putScriptSource(workflowId) {
  return `${preamble(workflowId)}
file=\${1:-}
if [ -z "$file" ]; then echo "usage: ./${PUT_SCRIPT} <file.json>" >&2; exit 2; fi
if [ ! -f "$file" ]; then echo "no such file: $file" >&2; exit 2; fi

# Keep only the four keys n8n accepts. Anything else it refuses outright.
payload=$(mktemp)
if ! node -e '
const fs = require("fs");
let w;
try {
  w = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
} catch (e) {
  console.error("that file is not valid JSON: " + e.message);
  process.exit(2);
}
for (const k of ["name", "nodes", "connections"]) {
  if (!(k in w)) {
    console.error("the file has no " + k + ". Send the whole workflow with your fix applied, not a fragment.");
    process.exit(2);
  }
}
const out = { name: w.name, nodes: w.nodes, connections: w.connections };
if (w.settings && typeof w.settings === "object") out.settings = w.settings;
process.stdout.write(JSON.stringify(out));
' "$file" > "$payload"; then
  rm -f "$payload"
  exit 2
fi

resp=$(mktemp)
status=$(curl -sS -o "$resp" -w '%{http_code}' -X PUT \\
  -H "X-N8N-API-KEY: $N8N_API_KEY" \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json' \\
  --data-binary @"$payload" \\
  "$URL" || echo 000)

note PUT "$status" "$resp"

echo "HTTP $status"
cat "$resp"
echo
rm -f "$payload" "$resp"

if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then exit 0; fi
exit 1
`;
}

/** Writes both scripts into a repair's working directory, executable. */
export async function writeHelperScripts({ dir, workflowId }) {
  const get = path.join(dir, GET_SCRIPT);
  const put = path.join(dir, PUT_SCRIPT);
  await writeFile(get, getScriptSource(workflowId));
  await writeFile(put, putScriptSource(workflowId));
  await chmod(get, 0o755);
  await chmod(put, 0o755);
  return { get, put, log: path.join(dir, CALL_LOG), names: [GET_SCRIPT, PUT_SCRIPT] };
}

/** One line of the call log, parsed. Anything unreadable is left out rather than guessed at. */
export function parseCallLog(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3)
    .map(([at, method, status, body = '']) => ({ at, method, status: Number(status), body: body.trim() }))
    .filter((e) => e.method && Number.isFinite(e.status));
}

export async function readCallLog(file) {
  try {
    return parseCallLog(await readFile(file, 'utf8'));
  } catch {
    // No log means no call was made through the scripts, which is itself an answer.
    return [];
  }
}

const ok = (status) => status >= 200 && status < 300;

/** Whether a write actually landed — n8n's own status, not the model's account of it. */
export function wroteSuccessfully(entries) {
  return entries.some((e) => e.method === 'PUT' && ok(e.status));
}

/** The last write that n8n refused, where the repair ended without a successful one. */
export function lastFailedWrite(entries) {
  const puts = entries.filter((e) => e.method === 'PUT');
  if (puts.length === 0 || wroteSuccessfully(puts)) return null;
  return puts[puts.length - 1];
}

/** The sentence a person needs when a write was refused: the status, and what n8n said. */
export function failedWriteNote(entry) {
  if (!entry) return null;
  const status = entry.status === 0 ? 'no answer at all' : `HTTP ${entry.status}`;
  const body = entry.body ? ` n8n said: ${entry.body.slice(0, 600)}` : ' n8n returned no body.';
  return `The write to n8n was refused (${status}), so the workflow was not changed.${body}`;
}
