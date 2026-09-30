/**
 * The automatic revert and the protected workflows (28 Sep 2026, Agent Upgrade
 * Plan step 4.4), end to end against stubs.
 *
 * The stub n8n keeps a real version history rather than counting reads: the
 * workflow starts at v1, the repair's write moves it to v2, a restore moves it
 * to v3 with the v1 content, and an `editedBy` option moves it to v9 behind the
 * repair's back — so each guard is tested against the state it actually reads.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NODES = [
  { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
  { name: 'Map fields', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'x', value: '={{ $json.missing }}' }] } } },
];

function stubN8n({ id, name, retryStatus = 'error', editedBy = false }) {
  const seen = { puts: [], retries: 0, activates: 0 };
  let version = 'v1';
  let nodes = NODES;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://n8n');
    let raw = '';
    req.on('data', (d) => (raw += d));
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-n8n-api-key'] !== 'n8n-key') return send(401, { message: 'no key' });
    const wfPath = `/api/v1/workflows/${id}`;

    if (url.pathname === wfPath && req.method === 'PUT') {
      return req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.puts.push(body);
        nodes = body.nodes;
        // The repair's own write takes v1 to v2; any later write is a restore, v3.
        version = version === 'v1' ? 'v2' : 'v3';
        if (editedBy && version === 'v2') version = 'v2';
        send(200, { id, versionId: version });
      });
    }
    if (url.pathname === wfPath) {
      // Somebody edits the workflow by hand once the repair has saved: from then on it reads v9.
      if (editedBy && version === 'v2' && seen.retries > 0) version = 'v9';
      return send(200, { id, name, versionId: version, active: true, nodes, connections: { Webhook: { main: [[{ node: 'Map fields', type: 'main', index: 0 }]] } }, settings: { executionOrder: 'v1' } });
    }
    if (url.pathname === `${wfPath}/activate` || url.pathname === `${wfPath}/deactivate`) {
      seen.activates++;
      return send(200, {});
    }
    if (url.pathname === '/api/v1/executions/99') {
      return send(200, { id: '99', workflowId: id, status: 'error', mode: 'webhook', data: { resultData: { lastNodeExecuted: 'Map fields', runData: { 'Map fields': [{ error: { message: 'boom' } }] } } } });
    }
    if (url.pathname === '/api/v1/executions/99/retry') {
      seen.retries++;
      return send(200, { id: '100' });
    }
    if (url.pathname === '/api/v1/executions/100') return send(200, { id: '100', workflowId: id, status: retryStatus });
    if (url.pathname === '/api/v1/executions') return send(200, { data: [] });
    return send(404, { message: `no stub for ${req.method} ${url.pathname}` });
  });
  return { server, seen };
}

function collector() {
  const bodies = [];
  const waiters = [];
  const server = createServer((req, res) => {
    // The repair-history read (30 Sep 2026) is a GET; only the reports are recorded.
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"repairs":[]}'); return; }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const record = { body: JSON.parse(raw || '{}') };
      bodies.push(record);
      waiters.splice(0).forEach((w) => w(record));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const next = () => (bodies.length ? Promise.resolve(bodies[bodies.length - 1]) : new Promise((r) => waiters.push(r)));
  return { server, next };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

async function fakeClaude(answer, shellBody = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: answer, modelUsage: { 'anthropic/claude-sonnet-5': {} } });
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\n${shellBody}\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`);
  await chmod(bin, 0o755);
  return bin;
}

/** The model's write goes through the real helper script, as a live repair's does. */
const WRITES = ['./n8n-get-workflow.sh > fixed.json 2>/dev/null || cp workflow.json fixed.json', './n8n-put-workflow.sh fixed.json > put-output.txt 2>&1 || true'].join('\n');

const ANSWER = JSON.stringify({ outcome: 'repaired', root_cause: 'The Set node read $json.missing.', change_summary: 'Pointed the expression at $json.body.id.', nodes_changed: ['Map fields'], human_action: '' });

async function runOnce({ id = 'wf1', name = 'Bays — Slack Router', retryStatus = 'error', editedBy = false, shellBody = WRITES }) {
  const n8n = stubN8n({ id, name, retryStatus, editedBy });
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
    SLACK_REPORT_CHANNEL: '#bha-pipeline-errors',
    CLAUDE_BIN: await fakeClaude(ANSWER, shellBody),
    DRY_RUN: 'false',
    RETRY_WAIT_MS: '5000',
    STATE_DIR: await mkdtemp(path.join(tmpdir(), 'repair-state-')),
    REPAIR_TIMEOUT_MS: '20000',
  });
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = { lane: 'bays', workflow: { id, name }, execution: { id: '99', lastNodeExecuted: 'Map fields' }, error: { class: 'expression_error', message: 'boom', failed_node: 'Map fields' } };
  const res = await fetch(`${base}/fix-workflow`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'bridge-key' }, body: JSON.stringify(request) });
  assert.equal(res.status, 202);
  const [d, w] = await Promise.all([dashboard.next(), webhook.next()]);
  for (let i = 0; i < 100; i++) {
    if ((await (await fetch(`${base}/health`)).json()).busy === 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => server.close(r));
  for (const s of [n8n.server, dashboard.server, webhook.server]) await new Promise((r) => s.close(r));
  return { dashboard: d.body, webhook: w.body, n8n: n8n.seen };
}

test('a change that did not fix the failure is put back to the snapshot, and both reports say so', async () => {
  const r = await runOnce({ retryStatus: 'error' });
  assert.equal(r.dashboard.outcome, 'not_repaired');
  assert.equal(r.n8n.puts.length, 2, 'the repair wrote once and the revert wrote once');
  assert.deepEqual(r.n8n.puts[1].nodes, NODES, 'the revert wrote the snapshot taken before the repair');
  assert.equal(r.n8n.puts[1].active, undefined, 'active is never sent on a restore');
  assert.equal(r.dashboard.auto_reverted, true);
  assert.equal(r.dashboard.reverted_to_version, 'v3');
  assert.ok(Date.parse(r.dashboard.reverted_at), 'reverted_at is a real instant');
  assert.equal(r.dashboard.auto_revert_error, null);
  assert.match(r.dashboard.change_summary, /Reverted automatically/);
  assert.equal(r.webhook.auto_reverted, true, 'the webhook carries the same fact');
});

test('a workflow edited after the repair is never restored over, and the row says why', async () => {
  const r = await runOnce({ retryStatus: 'error', editedBy: true });
  assert.equal(r.dashboard.outcome, 'not_repaired');
  assert.equal(r.n8n.puts.length, 1, 'only the repair wrote; nothing restored over the edit');
  assert.equal(r.dashboard.auto_reverted, false);
  assert.match(r.dashboard.auto_revert_error, /edited since this repair/);
  assert.match(r.dashboard.change_summary, /NOT REVERTED/);
  assert.match(r.dashboard.human_action, /still live and did not fix the failure/);
});

test('a protected agent-facing workflow is diagnosed, never written, and handed to a person', async () => {
  const r = await runOnce({ id: '5AFqtZQaeKFFiGqe', name: 'Bays — Agent Delivery', retryStatus: 'success' });
  assert.equal(r.dashboard.outcome, 'needs_human');
  assert.equal(r.dashboard.protected_workflow, true);
  assert.equal(r.n8n.puts.length, 0, 'nothing was written to a protected workflow');
  assert.equal(r.n8n.retries, 0, 'nothing was retried');
  assert.match(r.dashboard.change_summary, /^PROPOSED ONLY \(protected agent-facing workflow/);
  assert.match(r.dashboard.human_action, /six agent-facing workflows/);
  assert.equal(r.dashboard.auto_reverted, false);
});

test('a repair whose retry passed is never reverted', async () => {
  const r = await runOnce({ retryStatus: 'success' });
  assert.equal(r.dashboard.outcome, 'repaired');
  assert.equal(r.n8n.puts.length, 1);
  assert.equal(r.dashboard.auto_reverted, false);
  assert.equal(r.dashboard.auto_revert_error, null);
});
