/**
 * The 26 September Post Loop Digest case, end to end.
 *
 * What happened: the Bays agent called `Bays — Post Loop Digest` with an empty
 * input (18124, mode "integrated", parentAgentRun set); it threw. Nine seconds
 * later, in the same agent run, it called it again with real inputs and it
 * passed (18129). The repair made the right fix — then retried 18124, which
 * replayed the empty input and failed (18135), and the row said not_repaired
 * while four real runs passed.
 *
 * These pin the new behaviour against a stub n8n that holds exactly that
 * history: no retry of an agent-called execution, the proof taken from later
 * real runs, `repaired_pending` settled by a second report, the agent's own
 * recovery named, and a person asked only for what the runs cannot show.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WF = 'LG7iIPSIAkah6mKN';
const NAME = 'Bays — Post Loop Digest';
const RUN = 'run_da60d46c-9900-4f58-8a95-7612b22918b6';
const MESSAGE = 'Loop digest needs channel_id, builder_id and at least one real LOOP- id. [line 19]';

const WORKFLOW = {
  id: WF,
  name: NAME,
  active: true,
  nodes: [
    { name: 'From Bays Agent', type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: {} },
    { name: 'Render Digest Blocks', type: 'n8n-nodes-base.code', parameters: { jsCode: '// …' } },
  ],
  connections: { 'From Bays Agent': { main: [[{ node: 'Render Digest Blocks', type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1' },
};

const iso = (ms) => new Date(ms).toISOString();

/** An execution as n8n's public API returns it, with the fields the bridge reads. */
function execution({ id, status, startedAt, mode = 'integrated', runId = RUN, input = {}, error = null, output = null }) {
  const lastNode = error ? 'Render Digest Blocks' : 'Return Result';
  return {
    id,
    workflowId: WF,
    mode,
    status,
    startedAt,
    stoppedAt: startedAt,
    data: {
      ...(runId ? { parentAgentRun: { agentId: 'Nw5igXu4WWrjUMWB', runId, integrationType: 'task' } } : {}),
      resultData: {
        lastNodeExecuted: lastNode,
        ...(error ? { error: { message: error } } : {}),
        runData: {
          'From Bays Agent': [{ data: { main: [[{ json: input }]] } }],
          [lastNode]: [error ? { error: { message: error }, data: { main: [[]] } } : { data: { main: [[{ json: output ?? { ok: true, posted: true } }]] } }],
        },
      },
    },
  };
}

/**
 * A stub n8n holding the 26 Sep history. `failedId` keeps each case's repair id
 * its own. `afterPublish` is called when the fix lands, with a function that
 * adds an execution — which is how a case says what real traffic did next.
 */
function stubN8n({ failedId, recovery = true, afterPublish = () => {} }) {
  const t0 = Date.now() - 60_000;
  const executions = new Map();
  const add = (e) => executions.set(String(e.id), e);
  add(execution({ id: failedId, status: 'error', startedAt: iso(t0), error: MESSAGE }));
  if (recovery) add(execution({ id: `${failedId}-ok`, status: 'success', startedAt: iso(t0 + 9_000), input: { channel_id: 'C1', builder_id: 'U1', loops_json: '[]' } }));
  // A different agent run's success, before the fix: never "the same run".
  add(execution({ id: `${failedId}-other`, status: 'success', startedAt: iso(t0 + 5_000), runId: 'run_somebody_else' }));

  const seen = { retries: 0, puts: 0, version: 'v1' };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://n8n');
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-n8n-api-key'] !== 'n8n-key') return send(401, { message: 'no key' });

      if (url.pathname === `/api/v1/workflows/${WF}` && req.method === 'PUT') {
        seen.puts++;
        seen.version = 'v2';
        // The fix is live from now; say what real traffic does next.
        afterPublish(add);
        return send(200, { id: WF, versionId: 'v2' });
      }
      if (url.pathname === `/api/v1/workflows/${WF}`) return send(200, { ...WORKFLOW, versionId: seen.version });

      const retry = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)\/retry$/);
      if (retry) {
        // What happened on 26 Sep: the retry replays the empty input and fails.
        seen.retries++;
        add(execution({ id: '18135', status: 'error', startedAt: iso(Date.now()), mode: 'retry', error: MESSAGE }));
        return send(200, { id: '18135' });
      }
      const one = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
      if (one) {
        const e = executions.get(decodeURIComponent(one[1]));
        return e ? send(200, e) : send(404, { message: 'not found' });
      }
      if (url.pathname === '/api/v1/executions') {
        const list = [...executions.values()]
          .filter((e) => e.workflowId === url.searchParams.get('workflowId'))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
          .map(({ data, ...meta }) => meta);
        return send(200, { data: list, nextCursor: null });
      }
      return send(404, { message: `no stub for ${url.pathname}` });
    });
  });
  return { server, seen, add };
}

/** Records every POSTed body; `until` waits for one matching a test. */
function collector() {
  const bodies = [];
  const waiters = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      waiters.splice(0).forEach((w) => w());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const until = async (match, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = bodies.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no report matched within ${ms}ms; got ${JSON.stringify(bodies.map((b) => b.outcome))}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  };
  return { server, bodies, until };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

/** What the 18124 repair's model said: the right cause, a real fix, and a request the runs would answer. */
const ANSWER = JSON.stringify({
  outcome: 'repaired',
  root_cause: 'The "From Bays Agent" trigger declared no inputs, so the agent had no schema to fill and could call the tool empty.',
  change_summary: 'Declared the five inputs on the trigger: channel_id, builder_id, kind, loops_json, total.',
  nodes_changed: ['From Bays Agent'],
  human_action: "Confirm the Bays agent's tool-call prompt actually populates channel_id, builder_id, kind, loops_json and total.",
});

/** A `claude` that saves the workflow through the helper script, as a real repair does. */
async function fakeClaude() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: ANSWER, modelUsage: { 'anthropic/claude-sonnet-5': {} } });
  await writeFile(
    bin,
    `#!/bin/sh\ncat > /dev/null\ncp workflow.json fixed.json\n./n8n-put-workflow.sh fixed.json > put-output.txt 2>&1 || true\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`,
  );
  await chmod(bin, 0o755);
  return bin;
}

async function runCase({ failedId, recovery = true, afterPublish, windowMs = 20_000, request = {} }) {
  const n8n = stubN8n({ failedId, recovery, afterPublish });
  const dashboard = collector();
  const webhook = collector();
  const [n8nUrl, dashboardUrl, webhookUrl] = await Promise.all([listen(n8n.server), listen(dashboard.server), listen(webhook.server)]);

  Object.assign(process.env, {
    BRIDGE_KEY: 'bridge-key',
    N8N_BASE_URL: n8nUrl,
    N8N_API_KEY: 'n8n-key',
    DASHBOARD_URL: dashboardUrl,
    DASHBOARD_INBOUND_KEY: 'dash-key',
    REPORT_WEBHOOK_URL: webhookUrl,
    CLAUDE_BIN: await fakeClaude(),
    DRY_RUN: 'false',
    RETRY_WAIT_MS: '3000',
    REPAIR_TIMEOUT_MS: '20000',
    VERIFY_POLL_MS: '300',
    VERIFY_WINDOW_MS: String(windowMs),
    STATE_DIR: await mkdtemp(path.join(tmpdir(), 'repair-state-')),
  });

  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/fix-workflow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'bridge-key' },
    body: JSON.stringify({
      lane: 'bays',
      workflow: { id: WF, name: NAME },
      execution: { id: failedId, lastNodeExecuted: 'Render Digest Blocks' },
      error: { class: 'code_error', message: MESSAGE, failed_node: 'Render Digest Blocks', severity: 'high', subsystem: 'bays' },
      incident: { summary: 'Bays — Post Loop Digest / Render Digest Blocks failing', retryable: false },
      ...request,
    }),
  });
  assert.equal(res.status, 202);

  const close = async () => {
    await new Promise((r) => server.close(r));
    for (const s of [n8n.server, dashboard.server, webhook.server]) await new Promise((r) => s.close(r));
  };
  return { n8n, dashboard, webhook, base, close };
}

test('18124: an agent-called failure is never retried; a later real run makes it repaired, in a second report', async () => {
  const c = await runCase({
    failedId: '18124',
    afterPublish: (add) => setTimeout(() => add(execution({ id: '18142', status: 'success', startedAt: iso(Date.now()), input: { channel_id: 'C1', builder_id: 'U1' } })), 1_500),
  });
  try {
    const first = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-18124`);
    assert.equal(first.outcome, 'repaired_pending', 'no real run yet: pending, not not_repaired');
    assert.equal(first.verification, 'later_runs');
    assert.equal(first.version_after, 'v2');
    assert.equal(first.human_action, null, 'nothing for a person to do while the runs decide it');
    assert.match(first.model_suggestion, /Confirm the Bays agent/, 'the model’s request is kept, not put to a person');
    assert.ok(first.published_at && first.verify_until);
    assert.match(first.change_summary, /was not retried/);
    assert.match(first.change_summary, /second report/);

    // The agent recovered on its own nine seconds later, in the same run — and
    // the other agent run's success is not mistaken for it.
    assert.equal(first.agent_recovered.execution_id, '18124-ok');
    assert.equal(first.agent_recovered.after_seconds, 9);
    assert.match(first.change_summary, /The agent recovered on its own after 9s: execution 18124-ok/);

    const second = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-18124` && b.follow_up === true);
    assert.equal(second.outcome, 'repaired');
    assert.deepEqual(second.verified_by.map((r) => r.execution_id), ['18142']);
    assert.match(second.change_summary, /Verified by a later real run .*execution 18142 at /);
    assert.equal(second.human_action, null);
    assert.equal(second.duration_ms, first.duration_ms, 'the watch does not count as repair time');

    const hook = await c.webhook.until((b) => b.follow_up === true);
    assert.equal(hook.outcome, 'repaired', 'the webhook gets the second report too');
    assert.equal(hook.lane, 'bays');

    assert.equal(c.n8n.seen.retries, 0, 'the failed execution was never retried');
    assert.equal(c.dashboard.bodies.some((b) => b.outcome === 'not_repaired'), false, 'the 26 Sep verdict does not come back');

    const active = await (await fetch(`${c.base}/repairs/active`)).json();
    assert.deepEqual(active.verifying, [], 'the watch is finished once it has reported');
  } finally {
    await c.close();
  }
});

test('a real run that already passed by report time makes it repaired straight away, with no pending step', async () => {
  const c = await runCase({
    failedId: '28124',
    // In the list before the bridge looks, and started after the publish second.
    afterPublish: (add) => add(execution({ id: '28142', status: 'success', startedAt: iso(Date.now() + 1_500) })),
  });
  try {
    const first = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-28124`);
    assert.equal(first.outcome, 'repaired');
    assert.equal(first.follow_up, false);
    assert.deepEqual(first.verified_by.map((r) => r.execution_id), ['28142']);
    assert.equal(first.human_action, null);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(c.dashboard.bodies.filter((b) => b.repair_id === `REP-${WF}-28124`).length, 1, 'settled at once: no second report');
    assert.equal(c.n8n.seen.retries, 0);
  } finally {
    await c.close();
  }
});

test('a later real run that fails the same way downgrades it to not_repaired, naming that run', async () => {
  const c = await runCase({
    failedId: '38124',
    afterPublish: (add) => setTimeout(() => add(execution({ id: '38150', status: 'error', startedAt: iso(Date.now()), error: MESSAGE })), 1_500),
  });
  try {
    const first = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-38124`);
    assert.equal(first.outcome, 'repaired_pending');
    const second = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-38124` && b.follow_up);
    assert.equal(second.outcome, 'not_repaired');
    assert.equal(second.failed_again.execution_id, '38150');
    assert.match(second.human_action, /Execution 38150 .* failed the same way after the fix/);
    assert.equal((await c.webhook.until((b) => b.repair_id === `REP-${WF}-38124` && b.follow_up)).outcome, 'not_repaired');
    assert.equal(c.n8n.seen.retries, 0);
  } finally {
    await c.close();
  }
});

test('a run that only refused its input is not proof; a day with no real run asks a person exactly what is unverified', async () => {
  const c = await runCase({
    failedId: '48124',
    recovery: false,
    windowMs: 4_000,
    afterPublish: (add) => add(execution({ id: '48150', status: 'success', startedAt: iso(Date.now() + 1_500), output: { ok: false, error: 'missing channel_id' } })),
  });
  try {
    const first = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-48124`);
    assert.equal(first.outcome, 'repaired_pending');
    assert.equal(first.agent_recovered, null, 'no later success in the same run, so nothing is claimed');

    const second = await c.dashboard.until((b) => b.repair_id === `REP-${WF}-48124` && b.follow_up);
    assert.equal(second.outcome, 'needs_human');
    assert.deepEqual(second.verified_by, []);
    assert.match(second.change_summary, /only 1 that refused its input: 48150/);
    assert.match(second.human_action, /^Unverified: whether the fix published at .* holds for a real call/);
    await c.webhook.until((b) => b.repair_id === `REP-${WF}-48124` && b.follow_up);
    assert.equal(c.n8n.seen.retries, 0);
  } finally {
    await c.close();
  }
});

test('a pending verification survives a restart: boot resumes the watch and the second report still comes', async () => {
  const n8n = stubN8n({ failedId: '58124' });
  const since = Date.now() - 5_000;
  n8n.add(execution({ id: '58142', status: 'success', startedAt: iso(since + 2_000) }));
  const dashboard = collector();
  const webhook = collector();
  const [n8nUrl, dashboardUrl, webhookUrl] = await Promise.all([listen(n8n.server), listen(dashboard.server), listen(webhook.server)]);
  Object.assign(process.env, {
    N8N_BASE_URL: n8nUrl,
    N8N_API_KEY: 'n8n-key',
    DASHBOARD_URL: dashboardUrl,
    DASHBOARD_INBOUND_KEY: 'dash-key',
    REPORT_WEBHOOK_URL: webhookUrl,
    VERIFY_POLL_MS: '300',
    STATE_DIR: await mkdtemp(path.join(tmpdir(), 'repair-state-')),
  });

  const state = await import('../src/state.js');
  const { recover } = await import('../src/repair.js');
  await state.markPending({
    repair_id: `REP-${WF}-58124`,
    workflow_id: WF,
    execution_id: '58124',
    since_ms: since,
    until: iso(Date.now() + 60_000),
    signature: { node: 'Render Digest Blocks', message: MESSAGE.replace(/ \[line 19\]$/, '') },
    report: { request: { lane: 'bays', workflow: { id: WF, name: NAME }, execution: { id: '58124' } }, startedAt: iso(since - 60_000), durationMs: 1234, rootCause: 'x', saidChange: 'Declared the inputs.', nodesChanged: ['From Bays Agent'], workflowName: NAME, versionBefore: 'v1', versionAfter: 'v2', publishedAt: iso(since), caller: { agentRunId: RUN } },
  });

  try {
    await recover();
    const second = await dashboard.until((b) => b.repair_id === `REP-${WF}-58124`);
    assert.equal(second.outcome, 'repaired');
    assert.equal(second.follow_up, true);
    assert.deepEqual(second.verified_by.map((r) => r.execution_id), ['58142']);
    assert.equal(second.duration_ms, 1234);
    await webhook.until((b) => b.repair_id === `REP-${WF}-58124`);
    // Cleared just after both reports return; give it the moment that takes.
    for (let i = 0; i < 40 && (await state.pendingWatches()).length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await state.pendingWatches(), [], 'the record is cleared once it has reported');
  } finally {
    for (const s of [n8n.server, dashboard.server, webhook.server]) await new Promise((r) => s.close(r));
  }
});
