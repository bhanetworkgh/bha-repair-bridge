/**
 * The whole repair, end to end, against stubs.
 *
 * A stub n8n, a stub dashboard, a stub report webhook and a fake `claude` on
 * disk, so the four things that decide an outcome — the version moving, the
 * retry passing, the result parsing, and both reports going out — are exercised
 * together rather than argued about separately.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const WORKFLOW = {
  id: 'wf1',
  name: 'Bays — Slack Router',
  versionId: 'v1',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
    { name: 'Map fields', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'x', value: '={{ $json.missing }}' }] } } },
  ],
  connections: { Webhook: { main: [[{ node: 'Map fields', type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1' },
};

const EXECUTION = {
  id: '99',
  workflowId: 'wf1',
  status: 'error',
  data: {
    resultData: {
      lastNodeExecuted: 'Map fields',
      runData: {
        Webhook: [{ data: { main: [[{ json: { body: { id: 7 } } }]] } }],
        'Map fields': [{ error: { message: 'Cannot read properties of undefined (reading "missing")' }, data: { main: [[]] } }],
      },
    },
  },
};

/** A minimal n8n. `changes` decides whether the workflow's version moves after the run. */
function stubN8n({ changes, retryStatus = 'success', retryAnswer = { id: '100' }, putStatus = 200 }) {
  const seen = { workflowReads: 0, retries: 0, puts: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://n8n');
    let raw = '';
    req.on('data', (d) => (raw += d));
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-n8n-api-key'] !== 'n8n-key') return send(401, { message: 'no key' });

    if (url.pathname === '/api/v1/workflows/wf1' && req.method === 'PUT') {
      return req.on('end', () => {
        seen.puts.push(JSON.parse(raw || '{}'));
        send(putStatus, putStatus < 300 ? { id: 'wf1', versionId: 'v2' } : { message: 'unauthorized' });
      });
    }

    if (url.pathname === '/api/v1/workflows/wf1') {
      seen.workflowReads++;
      const version = changes && seen.workflowReads > 1 ? 'v2' : 'v1';
      return send(200, { ...WORKFLOW, versionId: version });
    }
    if (url.pathname === '/api/v1/executions/99') return send(200, EXECUTION);
    if (url.pathname === '/api/v1/executions/99/retry') {
      seen.retries++;
      return send(200, retryAnswer);
    }
    if (url.pathname === '/api/v1/executions/100') return send(200, { id: '100', workflowId: 'wf1', status: retryStatus });
    if (url.pathname === '/api/v1/executions') return send(200, { data: [{ id: '100', startedAt: new Date().toISOString() }] });
    return send(404, { message: `no stub for ${url.pathname}` });
  });
  return { server, seen };
}

/** A stub that records one POSTed body and hands it over when it arrives. */
function collector({ status = 200 } = {}) {
  const bodies = [];
  const waiters = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const record = { headers: req.headers, body: JSON.parse(raw || '{}') };
      bodies.push(record);
      waiters.splice(0).forEach((w) => w(record));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  const next = () => (bodies.length ? Promise.resolve(bodies[bodies.length - 1]) : new Promise((r) => waiters.push(r)));
  return { server, bodies, next };
}

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

/** A `claude` that prints what we want it to have said, in the CLI's own envelope. */
async function fakeClaude(answer, shellBody = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: answer, modelUsage: { 'anthropic/claude-sonnet-4.5': {} } });
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\n${shellBody}\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`);
  await chmod(bin, 0o755);
  return bin;
}

/** What a run that uses the helper scripts does, as a fake CLI would do it. */
const USES_THE_SCRIPTS = [
  './n8n-get-workflow.sh > read-back.json 2>/dev/null || true',
  'cp read-back.json fixed.json 2>/dev/null || cp workflow.json fixed.json',
  './n8n-put-workflow.sh fixed.json > put-output.txt 2>&1 || true',
].join('\n');

const REQUEST = {
  lane: 'bays',
  workflow: { id: 'wf1', name: 'Bays — Slack Router' },
  execution: { id: '99', lastNodeExecuted: 'Map fields' },
  error: { class: 'expression_error', message: 'Cannot read properties of undefined', failed_node: 'Map fields', severity: 'high', subsystem: 'bays' },
  incident: { id: 'INC-7', summary: 'Slack router failed', retryable: true },
  alert_permalink: 'https://slack.example/p1',
  timestamp: '2026-09-21T10:00:00.000Z',
  report_channel: '#bha-pipeline-errors',
};

/** Boots the bridge with the stubs wired in, runs one request, and returns both reports. */
async function runOnce({ answer, changes = true, retryStatus = 'success', dry = false, retryAnswer, putStatus = 200, shellBody = '', request = REQUEST, apiKey = 'bridge-key', extraPost = null }) {
  const n8n = stubN8n({ changes, retryStatus, retryAnswer, putStatus });
  const dashboard = collector();
  const webhook = collector();
  const [n8nUrl, dashboardUrl, webhookUrl] = await Promise.all([listen(n8n.server), listen(dashboard.server), listen(webhook.server)]);

  process.env.BRIDGE_KEY = 'bridge-key';
  process.env.N8N_BASE_URL = n8nUrl;
  process.env.N8N_API_KEY = 'n8n-key';
  process.env.DASHBOARD_URL = dashboardUrl;
  process.env.DASHBOARD_INBOUND_KEY = 'dash-key';
  process.env.REPORT_WEBHOOK_URL = webhookUrl;
  process.env.SLACK_REPORT_CHANNEL = '#bha-pipeline-errors';
  process.env.CLAUDE_BIN = await fakeClaude(answer, shellBody);
  process.env.DRY_RUN = dry ? 'true' : 'false';
  process.env.RETRY_WAIT_MS = '5000';
  process.env.REPAIR_TIMEOUT_MS = '20000';

  const { createApp } = await import('../src/server.js');
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body, key = apiKey) =>
    fetch(`${base}/fix-workflow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'x-api-key': key }) },
      body: JSON.stringify(body),
    });

  const res = await post(request);
  const accepted = await res.json();

  // A second request while the first is still running, where a case asks for one.
  const second = extraPost ? await post(request).then(async (r) => ({ status: r.status, body: await r.json() })) : null;

  const [reportedToDashboard, reportedToWebhook] = await Promise.all([dashboard.next(), webhook.next()]);

  // The reports go out inside the job, so wait for the job itself to let go of
  // the workflow before the next case asks to repair the same one.
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(`${base}/health`)).json();
    if (health.busy === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }

  await new Promise((r) => server.close(r));
  for (const s of [n8n.server, dashboard.server, webhook.server]) await new Promise((r) => s.close(r));

  return { status: res.status, accepted, second, dashboard: reportedToDashboard, webhook: reportedToWebhook, all: { dashboard: dashboard.bodies, webhook: webhook.bodies }, n8n: n8n.seen, base };
}

const REPAIRED = JSON.stringify({
  outcome: 'repaired',
  root_cause: 'The Set node read $json.missing, which the webhook never sends.',
  change_summary: 'Pointed the expression at $json.body.id.',
  nodes_changed: ['Map fields'],
  human_action: '',
});

test('a repair that moved the version and passed its retry is reported as repaired, twice', async () => {
  const r = await runOnce({ answer: `Here is what I did.\n${REPAIRED}` });

  assert.equal(r.status, 202);
  assert.deepEqual(r.accepted, { accepted: true, repair_id: 'REP-wf1-99' });

  const body = r.dashboard.body;
  assert.equal(r.dashboard.headers['x-dashboard-key'], 'dash-key');
  assert.equal(body.outcome, 'repaired');
  assert.equal(body.repair_id, 'REP-wf1-99');
  assert.deepEqual(body.workflow, { id: 'wf1', name: 'Bays — Slack Router' });
  assert.equal(body.failed_node, 'Map fields');
  assert.equal(body.error_class, 'expression_error');
  assert.equal(body.version_before, 'v1');
  assert.equal(body.version_after, 'v2');
  assert.deepEqual(body.nodes_changed, ['Map fields']);
  assert.equal(body.report_channel, '#bha-pipeline-errors');
  assert.ok(body.duration_ms >= 0);
  assert.equal(body.payload.incident.id, 'INC-7', 'the original request is carried whole');
  assert.ok(body.workflow_before.nodes.length === 2, 'the snapshot a revert restores from is sent');
  assert.equal(r.n8n.retries, 1);

  // The webhook gets the same body and the four fields n8n needs to close the ledger.
  const hook = r.webhook.body;
  assert.equal(hook.outcome, 'repaired');
  assert.equal(hook.lane, 'bays');
  assert.equal(hook.incident.id, 'INC-7');
  assert.equal(hook.alert_permalink, 'https://slack.example/p1');
  assert.equal(hook.retry_execution_id, '100');
});

test('a retry that failed is not_repaired, however sure the model was', async () => {
  const r = await runOnce({ answer: REPAIRED, retryStatus: 'error' });
  assert.equal(r.dashboard.body.outcome, 'not_repaired');
  assert.equal(r.dashboard.body.version_after, 'v2');
  assert.match(r.dashboard.body.change_summary, /ended as error/);
});

test('a claimed repair the workflow does not show is needs_human', async () => {
  const r = await runOnce({ answer: REPAIRED, changes: false });
  assert.equal(r.dashboard.body.outcome, 'needs_human');
  assert.equal(r.dashboard.body.version_after, null);
  assert.equal(r.n8n.retries, 0, 'nothing is retried when nothing changed');
  assert.match(r.dashboard.body.change_summary, /version did not move/);
});

test('an unparseable run is needs_human and says nothing was learned', async () => {
  const r = await runOnce({ answer: 'I had a look and it seems fine now.' });
  assert.equal(r.dashboard.body.outcome, 'needs_human');
  assert.match(r.dashboard.body.root_cause, /without a parseable result/);
  assert.ok(r.dashboard.body.human_action);
});

test('DRY_RUN diagnoses, writes nothing and prefixes the change', async () => {
  const r = await runOnce({ answer: REPAIRED, dry: true });
  assert.equal(r.dashboard.body.outcome, 'not_repaired');
  assert.match(r.dashboard.body.change_summary, /^DRY RUN: /);
  assert.equal(r.dashboard.body.version_after, null);
  assert.equal(r.n8n.retries, 0);
  assert.equal(r.dashboard.body.dry_run, true);
});

test('a retry n8n would not accept leaves the repair unproven rather than claimed', async () => {
  const r = await runOnce({ answer: REPAIRED, retryAnswer: true });
  assert.equal(r.dashboard.body.outcome, 'repaired', 'the fallback finds the execution the retry started');
  assert.equal(r.webhook.body.retry_execution_id, '100');
});

test('a refused workflow is skipped, and the skip is reported like any other outcome', async () => {
  const r = await runOnce({
    answer: REPAIRED,
    request: { ...REQUEST, workflow: { id: 'wf1', name: 'BHA — Self Healer' } },
  });

  assert.equal(r.status, 202, 'a refusal is still accepted: the caller gets an id and the answer comes by report');
  assert.equal(r.dashboard.body.outcome, 'skipped');
  assert.match(r.dashboard.body.root_cause, /refuse list/);
  assert.equal(r.dashboard.body.version_before, null);
  assert.equal(r.n8n.workflowReads, 0, 'a refused workflow is never even read');
  assert.equal(r.webhook.body.outcome, 'skipped');
});

test('a second request for a workflow already being repaired is skipped and says which repair holds it', async () => {
  const r = await runOnce({ answer: REPAIRED, extraPost: true });

  assert.equal(r.second.status, 202);
  assert.equal(r.second.body.repair_id, 'REP-wf1-99');

  const skipped = r.all.dashboard.map((x) => x.body).find((b) => b.outcome === 'skipped');
  assert.ok(skipped, 'the skip was reported');
  assert.match(skipped.root_cause, /already running \(REP-wf1-99\)/);
});

test('a write n8n refused is on the row, with its status, whatever the model claimed', async () => {
  const r = await runOnce({ answer: REPAIRED, shellBody: USES_THE_SCRIPTS, putStatus: 401, changes: false });

  assert.equal(r.dashboard.body.outcome, 'needs_human', 'a refused write is never a repair');
  assert.equal(r.dashboard.body.version_after, null);
  assert.match(r.dashboard.body.human_action, /HTTP 401/);
  assert.match(r.dashboard.body.human_action, /refused/i);
  assert.match(r.dashboard.body.change_summary, /refused \(HTTP 401\)/);
  assert.equal(r.n8n.retries, 0, 'nothing is retried when nothing was written');
});

test('a write that landed goes through the scripts, carrying only the four keys', async () => {
  const r = await runOnce({ answer: REPAIRED, shellBody: USES_THE_SCRIPTS });

  assert.equal(r.dashboard.body.outcome, 'repaired');
  assert.equal(r.n8n.puts.length, 1, 'the put script was used, not a hand-rolled call');
  assert.deepEqual(Object.keys(r.n8n.puts[0]).sort(), ['connections', 'name', 'nodes', 'settings']);
  assert.equal('active' in r.n8n.puts[0], false);
  assert.equal(r.dashboard.body.version_after, 'v2');
});

test('a run that wrote but said nothing readable is needs_human, with the version change recorded', async () => {
  const r = await runOnce({ answer: 'I had a look and made a change.', shellBody: USES_THE_SCRIPTS });

  assert.equal(r.dashboard.body.outcome, 'needs_human');
  assert.equal(r.n8n.puts.length, 1);
  assert.equal(r.dashboard.body.version_after, 'v2', 'the write is recorded even though the account of it is not');
  assert.match(r.dashboard.body.root_cause, /without a parseable result/);
});

test('DRY_RUN gives the model the scripts but the prompt forbids the write', async () => {
  const r = await runOnce({ answer: REPAIRED, dry: true, shellBody: './n8n-get-workflow.sh > /dev/null 2>&1 || true' });
  assert.equal(r.dashboard.body.outcome, 'not_repaired');
  assert.equal(r.n8n.puts.length, 0);
});
