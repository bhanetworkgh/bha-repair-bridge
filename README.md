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

## The four rules that decide an outcome

1. **`repaired` is evidence, not a claim.** It is recorded only where n8n's own
   `versionId` moved *and* the retried execution passed. Claude Code saying it
   repaired something is not a repair; the bridge re-reads the workflow and
   retries the original execution, and anything short of both is
   `not_repaired` or `needs_human`.
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
| `GET /health` | `{ ok, busy, dry_run, env_missing }`. Answers before a single secret is set — that is how anybody finds out which ones are still missing |
| `GET /health?deep=1` | Runs `claude -p "reply with the single word OK"` with no tools and a 60s limit, and returns `{ ok, claude_reachable, model, error }`. **This is the proof that Claude Code reaches OpenRouter on this key**, and it is the thing to run before trusting a repair |
| `POST /fix-workflow` | One repair request. `x-api-key` must equal `BRIDGE_KEY`, else 401. Answers `202 { accepted: true, repair_id }` and does the work afterwards |
| `GET /repairs/active` | What is running right now, by repair id. For when a repair seems stuck |

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

1. **Refuse or reserve.** A refused workflow, or a second request for a workflow
   already being repaired, is `skipped` — and reported like any other outcome.
   Both decisions are made before the 202 goes out, because the second one is a
   lock and a lock taken after the answer is a race.
2. **Read.** `GET /workflows/{id}` — `version_before` is its `versionId` — and
   `GET /executions/{id}?includeData=true`.
3. **Diagnose.** Claude Code runs in a scratch directory holding `workflow.json`,
   `execution.json`, `failed-node.json`, `error.json` and `request.json`, with a
   prompt carrying the error, the failed node's configuration, and what reached
   it and what it produced. It is told to find the root cause, make the
   **smallest** fix, and never rename or delete a node, never touch credentials,
   never activate or deactivate a workflow. Ten minutes, hard.
4. **Verify.** If it changed something: re-read the workflow for
   `version_after`, then `POST /executions/{id}/retry {loadWorkflow:true}` and
   wait for the retry's final status. Success → `repaired`. Anything else →
   `not_repaired`, with the reason on the row.
5. **Report**, twice.

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

### The five outcomes

| | |
|---|---|
| `repaired` | The workflow's version moved and the retried execution passed. Both, or it is not this |
| `not_repaired` | Something was changed and the failure is still there — or the change could not be proved, and the row says which |
| `needs_human` | No root cause, no parseable result, or a repair claimed that n8n does not show. `human_action` says what to do |
| `skipped` | A refused workflow, or one already being repaired |
| `error` | The bridge itself failed — n8n unreachable, Claude Code would not start. Never a verdict about the workflow |

The dashboard refuses a sixth name with a 422 rather than filing it under one of
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
  "dry_run": false
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
npm test           # the outcome rules, the HTTP surface, and the whole flow against stubs
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
| `N8N_API_KEY` | An n8n instance API key, sent as `X-N8N-API-KEY`. **Needs workflow read and write**: a repair edits a workflow |
| `DASHBOARD_URL` | The engine dashboard. `/api/engine/repair` is appended |
| `DASHBOARD_INBOUND_KEY` | The dashboard's inbound key, sent as `x-dashboard-key` |
| `REPORT_WEBHOOK_URL` | The n8n webhook that posts to Slack and closes the incident |
| `SLACK_REPORT_CHANNEL` | Where a report goes when the request did not name a `report_channel` |
| `ANTHROPIC_BASE_URL` | `https://openrouter.ai/api` |
| `ANTHROPIC_AUTH_TOKEN` | The OpenRouter key Claude Code runs on |
| `ANTHROPIC_API_KEY` | **Deliberately empty.** Set, Claude Code would use it instead of the auth token. There is no cached Anthropic login in the container and none should be added |
| `DRY_RUN` | Optional, default false |
| `CLAUDE_MODEL` | Optional. Unset, Claude Code picks its own default |
| `CLAUDE_PERMISSION_MODE` | Optional, default `acceptEdits`. `bypassPermissions` only where the service does not run as root — the CLI refuses it there |
| `CLAUDE_ALLOWED_TOOLS` | Optional, default `Bash,Read,Write,Edit,Glob,Grep` |
| `CLAUDE_BIN` | Optional. Overrides where the CLI is found |
| `REPAIR_TIMEOUT_MS`, `RETRY_WAIT_MS`, `DEEP_HEALTH_TIMEOUT_MS`, `N8N_TIMEOUT_MS` | Optional. The defaults are 10 min, 5 min, 60 s, 30 s |

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
| `src/repair.js` | Accept, refuse, verify, decide — the outcome rules live here |
| `src/n8n.js` | The n8n API: read a workflow, read an execution, retry one, wait for it |
| `src/claude.js` | Running the CLI headless, and reading its envelope |
| `src/prompt.js` | What Claude Code is told and what it is given to read |
| `src/report.js` | Both reports, with retries, and the loud log when one will not send |
| `src/config.js` | Every environment variable, read through functions so `/health` is current |
