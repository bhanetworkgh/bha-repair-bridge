# bha-repair-bridge

The other half of the BHA engine's self-healing layer.

n8n's **BHA — Self Healer** classifies a failure, refuses the classes no code
change can fix, and posts what is left here. This service runs **Claude Code
headless** against the failing workflow, verifies what actually changed, and
reports the result twice — to the dashboard, where a person reads it and can put
it back, and to a webhook, where n8n announces it in Slack and closes the ledger
incident.

```
n8n  BHA — Self Healer
        │  POST /fix-workflow            (202 immediately; the work is async)
        ▼
  bha-repair-bridge ──► n8n REST API     read the workflow + the failed execution
        │                                claude -p diagnoses and edits, via curl
        │                                re-read the workflow, retry the execution
        ├──► POST DASHBOARD_URL/api/engine/repair   → engine_repairs, the Repairs tab
        └──► POST REPORT_WEBHOOK_URL                → Slack, and the incident closed
```

**The rule the whole service exists to keep: nothing heals invisibly.** Every
request ends in a reported outcome. Silence is the one forbidden result.

---

## After the 22 September incident

At 08:00 three North Star failures arrived within seconds of each other. The
lock was per workflow, so three different workflows meant three permitted
concurrent Claude Code runs; the starter instance ran out of memory and was
restarted at 08:02:49. The three repairs died with the process — nothing was
reported — and the three workflows were left **switched off** with no edit
saved. Four things changed:

1. **One Claude Code run at a time, across every workflow.** The per-workflow
   lock became one global FIFO queue (`src/queue.js`). A repair is never refused
   for being second: it waits, and `queue_position` on the 202 says where. A
   workflow already running *or already waiting* is still skipped — two runs
   editing one workflow overwrite each other whether they are concurrent or
   merely consecutive.
2. **A workflow's active state is never a repair's to change.** It is read
   before the run and checked after: if it differs, the bridge sets it back
   through n8n's own `activate`/`deactivate` endpoints, reads it back to confirm,
   and the report says **"Active state restored"** — as a sentence in
   `change_summary` and as `active_restored: true` on the payload. A restore that
   *fails* goes to the top of `human_action`, because a workflow switched off is
   not failing, it is not running at all.
3. **Crashes and out-of-memory failures are refused.** An execution whose status
   is `crashed`, or an error naming `possible out-of-memory` or
   `WorkflowCrashedError`, is `skipped` as **infrastructure, not a workflow
   fault** — before Claude Code starts, and (when the request itself says so)
   before n8n is even read. There is no workflow bug there for a repair to find,
   and ten minutes looking for one is ten minutes inviting an edit to a workflow
   that was working.
4. **A restart cannot swallow a repair.** Every repair writes a small record to
   disk before it starts and deletes it once it has reported. A record still
   there at boot is a repair the process did not survive: the bridge puts that
   workflow's active state back, reports it to **both** places as `error` with
   `root_cause` "Interrupted by a restart" and `interrupted_by_restart: true`,
   and clears the record so a second restart does not report it twice. A record
   too corrupt to read is still reported — knowing a repair was running is
   reason enough to tell somebody.

### What one run costs, and what the instance needs

Measured on this build, with `ps` sampling the whole process tree every 500 ms:

| | |
|---|---|
| The bridge, idle | **65 MB** |
| One Claude Code run, peak | **231 MB** |
| Three runs at once, plus the bridge | **750 MB** |

A starter instance is 512 MB, which is why 22 September ended the way it did:
three concurrent runs need more memory than the instance has, and the kernel
took the whole service rather than one run. With the queue, the working set is
one run plus the bridge — **about 300 MB**.

**That 231 MB is a floor, not a typical run.** These processes never reached a
model: the measurement covers the CLI's own footprint (node, its bundle, agent
startup) without a conversation, tool output or a large workflow JSON growing in
memory. A real ten-minute repair should be read as **250–400 MB**, which puts a
single run plus the bridge at **315–465 MB against a 512 MB limit** — it fits,
with no room for a large workflow or a second process.

**So the instance should move up from starter.** Standard (2 GB) leaves a real
run four to six times the headroom it needs and makes the memory question
uninteresting, which is the right state for a service whose whole job is to be
reliable when something else has already broken.

## After the 26 September Post Loop Digest repair

`Bays — Post Loop Digest` is a tool the Bays agent calls. The agent called it
once with an empty input (execution 18124, mode `integrated`) and it threw;
nine seconds later, in the same agent run, it called it again properly and it
passed (18129). The repair found the real cause and made a good fix — then
"verified" it by retrying 18124. **A retry replays the same empty input**, so it
failed again (18135), the row said `not_repaired`, and a person was asked to
check something four later real runs had already shown.

So, for an execution another agent or workflow called (mode `integrated`, or a
`parentAgentRun` / `parentExecution` on it):

- **It is never retried.** The proof is a later real run: a successful
  execution of the workflow that started after the fixed version was
  published (retries and manual runs do not count, and nor does a run that
  answered `ok: false` — a refusal did no work).
- **The queue is not held for it.** If no such run exists yet, the repair is
  reported at once as **`repaired_pending`**, and a background watch looks
  every 10 minutes for up to 24 hours. It sends a **second report** with the
  same `repair_id`: `repaired`, naming the executions that proved it, or
  `not_repaired` if a later real run failed the same way (same node, same
  message), naming that run. A day with no real run at all is the one thing
  the evidence cannot settle, and only then is it `needs_human`, saying
  exactly that. The watch is written to disk and resumed after a restart.
- **Before diagnosing, the bridge looks for the agent's own recovery**: a
  success of the same workflow later in the same agent run (`parentAgentRun.runId`).
  If there is one, the report says so — "the agent recovered on its own after
  9s: execution 18129" — and the model is told. The diagnosis and the fix still
  run: 18124 had a real cause.
- **`human_action` asks only for what the evidence cannot settle.** On
  `repaired` and `repaired_pending` the model's own request is kept on the
  payload as `model_suggestion`, not put to a person.

Workflows started by their own trigger are verified exactly as before, by
retrying the failed execution: their input is the event that fired them.

## The four rules that decide an outcome

1. **`repaired` is evidence, not a claim.** It is recorded only where n8n's own
   `versionId` moved *and* the fix was proved: the retried execution passed,
   or — for a workflow an agent or another workflow called — a later real run
   passed. Claude Code saying it repaired something is not a repair, and
   anything short of both is `repaired_pending`, `not_repaired` or
   `needs_human`.
2. **An unparseable run is `needs_human`.** A run that finished without a
   readable result has told us nothing, and nothing is assumed from nothing.
3. **Both reports always go out**, whatever happened — including a skip, and
   including a crash inside the bridge. Each is tried three times with backoff,
   and a report that still will not send is logged at error level *with its
   whole body*, so it can be replayed by hand rather than lost.
4. **Six workflows are refused by name.** The three error handlers, the healer
   that calls this service, the retry workflow and the reports workflow: a
   machine editing the machinery that decides when machines edit things.

## Endpoints

| | |
|---|---|
| `GET /health` | `{ ok, busy, running, queued, dry_run, env_missing }`. `running` is 0 or 1 — one repair at a time. Answers before a single secret is set, which is how anybody finds out which ones are still missing |
| `GET /health?deep=1` | Runs `claude -p "reply with the single word OK"` with no tools and a 60s limit, and returns `{ ok, claude_reachable, model, model_pinned, model_fallback, error }`. **This is the proof that Claude Code reaches OpenRouter on this key**, and it is the thing to run before trusting a repair. `model` is what actually served the request — check it against `model_pinned` |
| `POST /fix-workflow` | One repair request. `x-api-key` must equal `BRIDGE_KEY`, else 401. Answers `202 { accepted: true, repair_id, queue_position }` and does the work afterwards. `queue_position` is 0 when it starts now, higher when it is waiting its turn |
| `GET /repairs/active` | What is running and what is waiting, in order, and `verifying`: the `repaired_pending` fixes being watched. For when a repair seems stuck |

`/fix-workflow` answers before it works because a repair takes up to ten
minutes: n8n's HTTP node would have given up long before, and a result that only
exists while a socket is open is one a dropped connection can erase. The result
comes back by the two reports, never on that response.

### The request

From **BHA — Self Healer**:

```jsonc
{
  "lane": "bays",
  "workflow":  { "id": "wf1", "name": "Bays — Slack Router" },
  "execution": { "id": "99", "lastNodeExecuted": "Map fields" },
  "error":     { "class": "expression_error", "message": "…",
                 "failed_node": "Map fields", "severity": "high", "subsystem": "bays" },
  "incident":  { "id": "INC-7", "summary": "…", "retryable": true },
  "alert_permalink": "https://bha.slack.com/archives/…",
  "timestamp": "2026-09-21T10:00:00.000Z",
  "report_channel": "#bha-pipeline-errors"
}
```

`workflow.id` and `execution.id` are the only required fields: together they are
the repair id, and a repair that cannot be named cannot be reported or read
back. A request missing either is refused with a 422 that says so.

**`repair_id` is `REP-<workflow.id>-<execution.id>`** — deterministic, so the
same failure reported twice updates one dashboard row rather than adding a
second.

## What a repair does

1. **Refuse or queue.** A refused workflow, an infrastructure failure, or a
   second request for a workflow already running or waiting is `skipped` — and
   reported like any other outcome. All three are decided before the 202 goes
   out, because the third is a lock and a lock taken after the answer is a race.
   Everything else joins the queue.
2. **Read.** `GET /workflows/{id}` — `version_before` is its `versionId`,
   `active_before` is its `active` — and `GET /executions/{id}?includeData=true`.
   The in-flight record is written here, and the crash check runs again against
   the execution's own status.
3. **Diagnose.** Claude Code runs in a scratch directory holding `workflow.json`,
   `execution.json`, `failed-node.json`, `error.json`, `request.json` and the
   **two helper scripts below**, with a prompt carrying the error, the failed
   node's configuration, and what reached it and what it produced. It is told to
   find the root cause, make the **smallest** fix, and never rename or delete a
   node, never touch credentials, never activate or deactivate a workflow. Ten
   minutes, hard.
4. **Verify.** If it changed something: re-read the workflow for
   `version_after`. For a triggered workflow, `POST /executions/{id}/retry
   {loadWorkflow:true}` and wait for the retry's final status: success →
   `repaired`, anything else → `not_repaired`, with the reason on the row. For
   an agent- or workflow-called one, look for a real run after the publish:
   passed → `repaired`, failed the same way → `not_repaired`, none yet →
   `repaired_pending` and a background watch (above).
5. **Put the active state back** if the run changed it, and say so.
6. **Report**, twice.

### The model does not write n8n calls

**Added 21 September 2026, after the first live repairs.** The first one saved
fine; the second came back `401` from n8n *on the same key that had just
worked* — the model had written its own `curl` and got the authentication
wrong. The key was never the problem; the hand-rolled call was.

So there are no n8n calls left to get wrong. Two scripts are written into every
repair's working directory, and the prompt says they are the only way to reach
n8n:

| | |
|---|---|
| `./n8n-get-workflow.sh` | `GET /api/v1/workflows/{id}` — prints the workflow as JSON. No arguments: the id is baked in |
| `./n8n-put-workflow.sh <file.json>` | `PUT /api/v1/workflows/{id}` — prints `HTTP <status>` and n8n's body, and exits non-zero on anything but 2xx |

- **The key is never in the prompt** — not its value, not even the name of the
  variable. There is no URL to call and no `curl` to copy. The scripts read
  `N8N_BASE_URL` and `N8N_API_KEY` from their own environment and send
  `X-N8N-API-KEY` themselves.
- **The PUT sends only `name`, `nodes`, `connections` and `settings`.** n8n
  rejects a body carrying the read-only fields it hands out (`id`, `versionId`,
  `active`, `createdAt`, `tags`), so the script drops them — the model saves the
  whole workflow with its fix applied and passes that file. `active` is never
  sent for the second reason too: a write that switched a live workflow on or
  off would be a change nobody asked for.
- **A fragment is refused, not sent.** A file missing `name`, `nodes` or
  `connections`, or one that is not valid JSON, exits 2 and says which.
- **Every call is logged, and the bridge reads that log.** A write n8n refused
  goes onto `human_action` with its status and body *whether or not the model
  mentioned it* — and the outcome downgrades accordingly. This is the guard the
  401 taught us to want: what n8n answered is a fact this service holds, not a
  claim the model makes about itself.

### Permissions and the model

Claude Code is given its tools by name — `Bash`, `Read`, `Write`, `Edit`,
`Glob`, `Grep` — under `--permission-mode acceptEdits`, **not**
`bypassPermissions`: the CLI refuses that mode outright when the process is
root, and a container that runs as root would fail every repair in its first
second with an error about a flag. A run that is refused for that reason falls
back to `acceptEdits` on its own rather than being reported as a repair that
could not start.

The child process gets a **deliberately small environment**: the model
credentials and the n8n credentials, nothing else. `BRIDGE_KEY`,
`DASHBOARD_INBOUND_KEY` and the report webhook never reach it.

### The six outcomes

| | |
|---|---|
| `repaired` | The workflow's version moved and the fix was proved — the retried execution passed, or, for a called workflow, a later real run did. Both, or it is not this |
| `repaired_pending` | A called workflow's version moved and no real run has happened since. Not a verdict: a second report with the same `repair_id` follows within 24 hours |
| `not_repaired` | Something was changed and the failure is still there — or the change could not be proved, and the row says which |
| `needs_human` | No root cause, no parseable result, or a repair claimed that n8n does not show. `human_action` says what to do |
| `skipped` | A refused workflow, one already running or waiting, or an infrastructure failure (a crashed execution, an out-of-memory error) |
| `error` | The bridge itself failed — n8n unreachable, Claude Code would not start, **or a restart killed the repair**. Never a verdict about the workflow |

The dashboard refuses a name it does not know with a 422 rather than filing it under one of
these. The vocabulary is what the two services share.

## The reports

**To the dashboard** — `POST DASHBOARD_URL/api/engine/repair`, header
`x-dashboard-key: DASHBOARD_INBOUND_KEY`:

```jsonc
{
  "repair_id", "outcome",
  "workflow": { "id", "name" },
  "failed_node", "error_class", "error_message", "execution_id",
  "root_cause", "change_summary", "nodes_changed", "human_action",
  "version_before", "version_after", "duration_ms", "report_channel",
  "started_at", "finished_at",
  "payload": { /* the original request, whole */ },
  "workflow_before": { /* the workflow as it stood before anything changed */ },
  "active_before", "active_restored", "active_now",
  "interrupted_by_restart",   // only on a repair a restart killed
  "dry_run": false,
  // 26 Sep 2026 — how the fix was proved
  "verification",      // "retry" | "later_runs" | null (nothing was changed)
  "verified_by",       // [{ execution_id, started_at }] later real runs that passed
  "failed_again",      // { execution_id, started_at, status } a later run that failed the same way, or null
  "published_at",      // when the fixed version went live; runs after it count
  "verify_until",      // on repaired_pending: when the watch gives up
  "agent_recovered",   // { execution_id, started_at, after_seconds, agent_run_id } or null
  "model_suggestion",  // the model's human_action, where the evidence already answers it
  "follow_up"          // true on the second report of a repaired_pending repair
}
```

**To the webhook** — `POST REPORT_WEBHOOK_URL`: the same body plus `incident`,
`lane`, `alert_permalink` and `retry_execution_id`.

**`workflow_before` is not in the brief's field list and is sent anyway.** The
dashboard's Revert restores a workflow from a snapshot, because n8n's public API
offers no way to fetch a historical version by id — a `version_before` with no
snapshot beside it names a restore point without containing it. The dashboard
already reads this field where it is present (`server/src/repairs.ts`,
`snapshotOf`), so sending it is what makes Revert work at all.

## DRY_RUN

`DRY_RUN=true` does steps 1–4 and never writes to n8n: Claude Code is told it
may only read, no retry is run, and the outcome is `not_repaired` with
`change_summary` prefixed **`DRY RUN:`** describing the fix it would have made.

## Running it

```sh
npm ci
npm start          # PORT, or 10000
npm test           # the outcome rules, the helper scripts, the HTTP surface, and the whole flow against stubs
```

On Render (service `bha-repair-bridge`):

- **Build**: `npm ci && npm install -g @anthropic-ai/claude-code`
- **Start**: `npm start`

`@anthropic-ai/claude-code` is **also a dependency in `package.json`**, and the
bridge runs `node_modules/.bin/claude` when it is there, `claude` on `PATH`
otherwise. It works whether or not the global install is on `PATH` at runtime.

## Environment

| | |
|---|---|
| `BRIDGE_KEY` | What `/fix-workflow` checks `x-api-key` against. Unset, every request is refused with a 503 that says so — this service does not run with authentication off |
| `N8N_BASE_URL` | The instance, without `/api/v1` |
| `N8N_API_KEY` | An n8n instance API key, sent as `X-N8N-API-KEY`. **Needs workflow read, write and activate**: a repair edits a workflow, and the bridge puts the active state back through `activate`/`deactivate` |
| `DASHBOARD_URL` | The engine dashboard. `/api/engine/repair` is appended |
| `DASHBOARD_INBOUND_KEY` | The dashboard's inbound key, sent as `x-dashboard-key` |
| `REPORT_WEBHOOK_URL` | The n8n webhook that posts to Slack and closes the incident |
| `SLACK_REPORT_CHANNEL` | Where a report goes when the request did not name a `report_channel` |
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` |
| `ANTHROPIC_AUTH_TOKEN` | The OpenRouter key Claude Code runs on |
| `ANTHROPIC_API_KEY` | **Deliberately empty.** Set, Claude Code would use it instead of the auth token. There is no cached Anthropic login in the container and none should be added |
| `DRY_RUN` | Optional, default false |
| `ANTHROPIC_MODEL` | The model Claude Code runs on. Defaults to **`claude-sonnet-5`** — the CLI's own default resolved to `claude-sonnet-4-20250514` (a Sonnet from May 2025) on this account. Set it on Render to move the pin without a release; if OpenRouter does not know the name, the run falls back to the CLI's default and `/health?deep=1` reports both |
| `CLAUDE_MODEL` | Optional. Passed as `--model`, and wins over `ANTHROPIC_MODEL` when set |
| `CLAUDE_PERMISSION_MODE` | Optional, default `acceptEdits`. `bypassPermissions` only where the service does not run as root — the CLI refuses it there |
| `CLAUDE_ALLOWED_TOOLS` | Optional, default `Bash,Read,Write,Edit,Glob,Grep` |
| `CLAUDE_BIN` | Optional. Overrides where the CLI is found |
| `REPAIR_TIMEOUT_MS`, `RETRY_WAIT_MS`, `DEEP_HEALTH_TIMEOUT_MS`, `N8N_TIMEOUT_MS` | Optional. The defaults are 10 min, 5 min, 60 s, 30 s |
| `VERIFY_POLL_MS`, `VERIFY_WINDOW_MS` | Optional. How often a `repaired_pending` fix is checked for a later real run, and for how long: 10 min and 24 h |
| `STATE_DIR` | Where in-flight repair records are written. Defaults to the instance's tmp, which survives a process restart — the failure they exist for. A redeploy starts a fresh container and takes them with it, which is fine: a deploy is not a crash |

Everything except `SLACK_REPORT_CHANNEL`, `ANTHROPIC_API_KEY` and the optional
ones is reported by name in `/health`'s `env_missing` while it is unset.

**Model and billing.** Claude Code runs on OpenRouter through
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, with no proxy. OpenRouter only
guarantees Claude Code with the Anthropic first-party provider, so no other
provider is configured here and none should be.

## The log

One JSON line per step, and **every line carries its `repair_id`** — that is
what to paste into Render's log search:

```
{"at":"…","repair_id":"REP-wf1-99","step":"n8n.workflow.read","detail":{"version_before":"v1","nodes":14}}
{"at":"…","repair_id":"REP-wf1-99","step":"claude.finished","detail":{"ok":true,"ms":184213,"model":"…"}}
{"at":"…","repair_id":"REP-wf1-99","step":"retry.finished","detail":{"retry_execution_id":"100","status":"success"}}
{"at":"…","repair_id":"REP-wf1-99","step":"outcome","detail":{"outcome":"repaired","duration_ms":201044,…}}
```

A report that would not send is `report.undelivered`, at error level, carrying
the body it could not deliver.

## The files

| | |
|---|---|
| `src/server.js` | The three routes, and a shutdown that lets a running repair finish |
| `src/repair.js` | Accept, refuse, verify, decide, restore the active state, recover from a restart |
| `src/queue.js` | One repair at a time, FIFO, across every workflow |
| `src/refusals.js` | The six workflows, and what counts as an infrastructure failure |
| `src/state.js` | The on-disk record that makes a killed repair visible at the next boot |
| `src/n8n.js` | The n8n API: read a workflow, read an execution, retry one, wait for it, list the runs since a time |
| `src/verify.js` | Who called an execution, whether the agent recovered on its own, and what the real runs after a fix say |
| `src/claude.js` | Running the CLI headless, and reading its envelope |
| `src/prompt.js` | What Claude Code is told and what it is given to read |
| `src/scripts.js` | The two n8n helper scripts, their call log, and what a refused write means |
| `src/report.js` | Both reports, with retries, and the loud log when one will not send |
| `src/config.js` | Every environment variable, read through functions so `/health` is current |
