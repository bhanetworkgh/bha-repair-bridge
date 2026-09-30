# What BHA has learned about n8n failures

Read before changing anything. Each line was learned from a real failure in this engine.

## How n8n runs and retries
- A retry replays from the node that failed, with the stored output of every node before it. A fix made to an earlier node is never run by a retry.
- A node that emits zero items stops everything after it without an error. A search that matches nothing needs a parallel node that emits one placeholder item, merged in, or the flow dies silently.
- Disabling a node does not stop data: disabled nodes pass their input through. To stop a node firing, route around it with an If node.
- `$('Node').isExecuted ? $('Node').first().json.x : fallback` is the safe way to read a node that may not have run. Optional chaining does not help.
- After a Merge, prefer `.first()` to `.item`; paired-item tracing breaks across a merge whose branches have different shapes.
- Code nodes that reference another node by name break when that node is renamed. Never rename a node.

## HTTP nodes and errors
- n8n's HTTP Request node replaces `error.message` with a generic line ("The service was not able to process your request", "Forbidden - perhaps check your credentials?"). The real status and body are in `error.messages` and `error.httpCode`. Read those before deciding the cause.
- 404 from a service is a wrong id or path (a data problem), never a credential problem. 401/403 are credentials, except Airtable, which returns the same 403 for a deleted table.
- 429 or "rate limit" is back-off, not billing, even if the body says "quota".

## Slack
- Slack answers HTTP 200 with `{ "ok": false, "error": "..." }` when it refuses a message. BHA workflows follow the Slack post with an `Assert ... Delivered` Code node that throws on `ok: false`. When an Assert node fails, the fault is almost always UPSTREAM: in the node that built the message.
- Block Kit hard limits: 3,000 characters in one section's text, 50 blocks in one message, 150 characters in a header. `invalid_blocks` usually means one of these was passed. Split long text across sections at sentence ends; never cut it silently.
- `not_in_channel`: the bot is not a member. That is a person's job (invite the bot), not a code fix.
- Never inject raw multi-line model text straight into Block Kit JSON; build the blocks in a Code node and `JSON.stringify` them.

## BHA conventions
- A node named `Raise ...` throws on purpose so the error handler tells a person. It is an alarm, not a defect.
- Every workflow has exactly one sticky note and its nodes sit in groups. Do not add sticky notes or move nodes.
- Credentials are never changed by a repair. BHA uses named, BHA-prefixed credentials; a credential fault is a person's job.
- The BHARAG incident ledger (`incidents.v0`) is strict: a status patch with any field it does not list is refused with `LEDGER_PAYLOAD_SCHEMA_MISMATCH`.
- The dashboard's engine routes need the `x-dashboard-key` header from `$vars.DASHBOARD_INBOUND_KEY`.
- BHARAG `content_type` must be one of: code, transcript, doc, decision, narration, chat.

## Drafts and publishing (n8n MCP)
- Editing a workflow or an agent through n8n's MCP saves a DRAFT. Nothing is live until it is published.
- Publishing a workflow that already had someone else's unpublished draft ships their draft too. Never edit a workflow or agent whose draft already differs from its live version.
- After every edit, re-read the workflow and confirm what landed.
