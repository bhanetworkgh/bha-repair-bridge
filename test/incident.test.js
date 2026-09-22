/**
 * The four things the 22 September 08:00 incident asked for, end to end.
 *
 * What happened: three repairs were accepted within seconds of each other,
 * three Claude Code runs started together on a starter instance, the service
 * ran out of memory and was restarted at 08:02:49, and the three North Star
 * workflows came out of it switched off with no edit saved and nothing
 * reported.
 *
 * So: one run at a time, the active state put back, crashes and
 * out-of-memory failures refused before a run starts, and a restart that
 * reports rather than swallows what it killed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workflowOf = (id, name, active = true) => ({
  id,
  name,
  versionId: 'v1',
  active,
  nodes: [{ name: 'Map fields', type: 'n8n-nodes-base.set', parameters: {} }],
  connections: { Webhook: { main: [[{ node: 'Map fields' }]] } },
  settings: { executionOrder: 'v1' },
});

/** A stub n8n that holds several workflows and can be switched on and off. */
function stubN8n({ executionStatus = 'error', executionError = null, retryStatus = 'success' } = {}) {
  const workflows = new Map([
    ['ns1', workflowOf('ns1', 'North Star — Digest')],
    ['ns2', workflowOf('ns2', 'North Star — Ask Router')],
    ['ns3', workflowOf('ns3', 'North Star — Weekly Roll-up')],
  ]);
  const seen = { activations: [], puts: [], reads: [] };

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

      const activate = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/(activate|deactivate)$/);
      if (activate) {
        const [, id, verb] = activate;
        const wf = workflows.get(id);
        if (!wf) return send(404, { message: 'no such workflow' });
        wf.active = verb === 'activate';
        seen.activations.push({ id, active: wf.active });
        return send(200, wf);
      }

      const one = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
      if (one) {
        const wf = workflows.get(one[1]);
        if (!wf) return send(404, { message: 'no such workflow' });
        if (req.method === 'PUT') {
          const body = JSON.parse(raw || '{}');
          seen.puts.push({ id: one[1], keys: Object.keys(body).sort() });
          wf.versionId = 'v2';
          return send(200, wf);
        }
        seen.reads.push(one[1]);
        return send(200, wf);
      }

      const exec = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
      if (exec) {
        const id = exec[1];
        if (id.startsWith('retry-')) return send(200, { id, status: retryStatus });
        return send(200, {
          id,
          workflowId: 'ns1',
          status: executionStatus,
          data: {
            resultData: {
              lastNodeExecuted: 'Map fields',
              ...(executionError ? { error: executionError } : {}),
              runData: { 'Map fields': [{ error: { message: 'Cannot read properties of undefined' }, data: { main: [[]] } }] },
            },
          },
        });
      }

      const retry = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)\/retry$/);
      if (retry) return send(200, { id: `retry-${retry[1]}` });

      return send(404, { message: `no stub for ${url.pathname}` });
    });
  });

  return { server, seen, workflows };
}

/** Collects the bodies posted to the dashboard and to the webhook. */
function collector() {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const waitFor = async (n, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (bodies.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return bodies;
  };
  return { server, bodies, waitFor };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

/**
 * A fake CLI. `body` is shell run before it answers — that is how a test makes
 * a run take time, or makes it switch a workflow off the way a real one might.
 */
async function fakeClaude({ answer, body = '', marker = null }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: answer, modelUsage: { 'claude-sonnet-5': {} } });
  const concurrency = marker
    ? `echo "start $$ $(date +%s%N)" >> ${marker}\nsleep 0.4\necho "end $$ $(date +%s%N)" >> ${marker}\n`
    : '';
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\n${concurrency}${body}\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`);
  await chmod(bin, 0o755);
  return bin;
}

/** What a run that actually fixes something does: read, edit, write it back. */
const WRITES_A_FIX = [
  './n8n-get-workflow.sh > fixed.json 2>/dev/null || cp workflow.json fixed.json',
  './n8n-put-workflow.sh fixed.json > /dev/null 2>&1 || true',
].join('\n');

const REPAIRED = JSON.stringify({
  outcome: 'repaired',
  root_cause: 'The Set node read a field the webhook never sends.',
  change_summary: 'Pointed the expression at $json.body.id.',
  nodes_changed: ['Map fields'],
  human_action: '',
});

const requestFor = (workflowId, name, executionId, extra = {}) => ({
  lane: 'north_star',
  workflow: { id: workflowId, name },
  execution: { id: executionId, lastNodeExecuted: 'Map fields' },
  error: { class: 'expression_error', message: 'Cannot read properties of undefined', failed_node: 'Map fields', severity: 'high', subsystem: 'north_star' },
  incident: { id: `INC-${executionId}`, summary: 'North Star failed', retryable: true },
  alert_permalink: 'https://slack.example/p1',
  report_channel: '#bha-pipeline-errors',
  ...extra,
});

/** Boots the bridge against the stubs. Returns the app, the stubs and a poster. */
async function boot({ claudeBin, stub = {}, dry = false } = {}) {
  const n8n = stubN8n(stub);
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
  process.env.DRY_RUN = dry ? 'true' : 'false';
  process.env.RETRY_WAIT_MS = '4000';
  process.env.REPAIR_TIMEOUT_MS = '20000';
  process.env.STATE_DIR = await mkdtemp(path.join(tmpdir(), 'repair-state-'));
  if (claudeBin) process.env.CLAUDE_BIN = claudeBin;

  // The queue is module state shared by every test in this file, so a new
  // bridge waits for the last one to finish rather than inheriting its work.
  const { idle: queueIdle } = await import('../src/queue.js');
  await queueIdle(30_000);

  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = (body) =>
    fetch(`${base}/fix-workflow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'bridge-key' },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const health = () => fetch(`${base}/health`).then((r) => r.json());

  const close = async () => {
    await new Promise((r) => server.close(r));
    for (const s of [n8n.server, dashboard.server, webhook.server]) await new Promise((r) => s.close(r));
  };

  return { base, post, health, n8n, dashboard, webhook, close, stateDir: process.env.STATE_DIR };
}

const idle = async (health, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const h = await health();
    if (h.busy === 0) return h;
    if (Date.now() > deadline) throw new Error(`still busy after ${ms}ms: ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/* ------------------------------------------------------------------- one */

test('1. three repairs at once run one at a time, and all three report', async () => {
  const marker = path.join(await mkdtemp(path.join(tmpdir(), 'marker-')), 'runs.log');
  const bin = await fakeClaude({ answer: REPAIRED, marker, body: WRITES_A_FIX });
  const bridge = await boot({ claudeBin: bin });

  // The 22 Sep shape: three North Star failures inside the same second.
  const accepted = await Promise.all([
    bridge.post(requestFor('ns1', 'North Star — Digest', '501')),
    bridge.post(requestFor('ns2', 'North Star — Ask Router', '502')),
    bridge.post(requestFor('ns3', 'North Star — Weekly Roll-up', '503')),
  ]);

  assert.deepEqual(accepted.map((a) => a.status), [202, 202, 202], 'none is refused for being second');
  assert.deepEqual(accepted.map((a) => a.body.repair_id), ['REP-ns1-501', 'REP-ns2-502', 'REP-ns3-503']);
  assert.deepEqual(accepted.map((a) => a.body.queue_position), [0, 1, 2], 'the second and third wait their turn');

  const busy = await bridge.health();
  assert.equal(busy.busy, 3);
  assert.equal(busy.running, 1, 'one Claude Code run, whatever the arrival rate');
  assert.equal(busy.queued, 2);

  const dashboard = await bridge.dashboard.waitFor(3);
  await idle(bridge.health);

  // The proof, from the runs themselves: no two overlapped.
  const events = (await readFile(marker, 'utf8')).trim().split('\n').map((l) => l.split(' ')[0]);
  let depth = 0;
  let peak = 0;
  for (const e of events) {
    depth += e === 'start' ? 1 : -1;
    peak = Math.max(peak, depth);
  }
  assert.equal(events.filter((e) => e === 'start').length, 3, 'all three ran');
  assert.equal(peak, 1, 'never two Claude Code runs at the same time');

  assert.deepEqual(
    dashboard.map((d) => d.repair_id),
    ['REP-ns1-501', 'REP-ns2-502', 'REP-ns3-503'],
    'reported in the order they were reported to us',
  );
  assert.deepEqual([...new Set(dashboard.map((d) => d.outcome))], ['repaired']);
  assert.equal((await bridge.webhook.waitFor(3)).length, 3, 'and Slack heard about all three');

  await bridge.close();
});

/* ------------------------------------------------------------------- two */

test('2. a workflow switched off during a repair is switched back on, and the report says so', async () => {
  // A run that goes around the helper scripts and deactivates the workflow —
  // which is what left three North Star workflows off on 22 Sep.
  const bin = await fakeClaude({
    answer: REPAIRED,
    body: 'curl -sS -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_BASE_URL/api/v1/workflows/ns1/deactivate" > /dev/null 2>&1 || true',
  });
  const bridge = await boot({ claudeBin: bin });

  await bridge.post(requestFor('ns1', 'North Star — Digest', '601'));
  const [report] = await bridge.dashboard.waitFor(1);
  await idle(bridge.health);

  assert.equal(bridge.n8n.workflows.get('ns1').active, true, 'the workflow is running again');
  assert.deepEqual(
    bridge.n8n.seen.activations.map((a) => `${a.id}:${a.active}`),
    ['ns1:false', 'ns1:true'],
    'it was switched off by the run and switched back by the bridge',
  );

  assert.equal(report.active_before, true);
  assert.equal(report.active_restored, true);
  assert.equal(report.active_now, true);
  assert.match(report.change_summary, /Active state restored/);

  const [slack] = await bridge.webhook.waitFor(1);
  assert.equal(slack.active_restored, true, 'Slack is told too');

  await bridge.close();
});

test('2b. a repair that changed nothing about the active state says nothing about it', async () => {
  const bridge = await boot({ claudeBin: await fakeClaude({ answer: REPAIRED, body: WRITES_A_FIX }) });

  await bridge.post(requestFor('ns2', 'North Star — Ask Router', '602'));
  const [report] = await bridge.dashboard.waitFor(1);
  await idle(bridge.health);

  assert.equal(report.active_restored, false);
  assert.equal(bridge.n8n.seen.activations.length, 0, 'nothing was switched, so nothing was set back');
  assert.equal(/Active state/.test(report.change_summary), false);

  await bridge.close();
});

/* ----------------------------------------------------------------- three */

test('3. a crashed execution is skipped as infrastructure, without starting Claude Code', async () => {
  const marker = path.join(await mkdtemp(path.join(tmpdir(), 'marker-')), 'runs.log');
  const bin = await fakeClaude({ answer: REPAIRED, marker });
  const bridge = await boot({ claudeBin: bin, stub: { executionStatus: 'crashed' } });

  const accepted = await bridge.post(requestFor('ns1', 'North Star — Digest', '701'));
  assert.equal(accepted.status, 202);

  const [report] = await bridge.dashboard.waitFor(1);
  await idle(bridge.health);

  assert.equal(report.outcome, 'skipped');
  assert.match(report.root_cause, /crashed/);
  assert.match(report.root_cause, /infrastructure, not a workflow fault/);
  assert.match(report.change_summary, /infrastructure, not a workflow fault/);
  assert.match(report.human_action, /instance rather than the workflow/);

  await assert.rejects(readFile(marker, 'utf8'), 'Claude Code was never started');
  assert.equal(bridge.n8n.seen.puts.length, 0, 'and nothing was written to n8n');

  await bridge.close();
});

test('3b. an out-of-memory error is skipped before n8n is even read', async () => {
  const bridge = await boot({ claudeBin: await fakeClaude({ answer: REPAIRED }) });

  for (const [i, message] of [
    'Execution stopped at this node. n8n may have run out of memory while executing it — possible out-of-memory',
    'WorkflowCrashedError: the workflow execution crashed',
  ].entries()) {
    await bridge.post(requestFor('ns1', 'North Star — Digest', `80${i}`, { error: { class: 'unknown', message, failed_node: 'Map fields', severity: 'critical' } }));
  }

  const reports = await bridge.dashboard.waitFor(2);
  await idle(bridge.health);

  for (const report of reports) {
    assert.equal(report.outcome, 'skipped');
    assert.match(report.root_cause, /infrastructure, not a workflow fault/);
  }
  assert.match(reports[0].root_cause, /possible out-of-memory/);
  assert.match(reports[1].root_cause, /WorkflowCrashedError/);
  assert.equal(bridge.n8n.seen.reads.length, 0, 'the workflow was never even fetched');

  await bridge.close();
});

/* ------------------------------------------------------------------ four */

test('4. a repair killed by a restart is reported at boot, and its workflow switched back on', async () => {
  const bridge = await boot({ claudeBin: await fakeClaude({ answer: REPAIRED }) });
  const { markRunning, inFlight } = await import('../src/state.js');
  const { recover } = await import('../src/repair.js');

  // What the last process left behind: a repair in flight on a workflow that
  // was active before it started — and is now switched off, as on 22 Sep.
  await markRunning({
    repair_id: 'REP-ns3-901',
    workflow_id: 'ns3',
    workflow_name: 'North Star — Weekly Roll-up',
    execution_id: '901',
    active_before: true,
    version_before: 'v1',
    started_at: '2026-09-22T08:00:11.000Z',
    request: requestFor('ns3', 'North Star — Weekly Roll-up', '901'),
  });
  bridge.n8n.workflows.get('ns3').active = false;

  const result = await recover();
  assert.equal(result.recovered, 1);

  const [report] = await bridge.dashboard.waitFor(1);
  const [slack] = await bridge.webhook.waitFor(1);

  assert.equal(report.repair_id, 'REP-ns3-901');
  assert.equal(report.outcome, 'error', 'the bridge failed; nothing is claimed about the workflow');
  assert.match(report.root_cause, /Interrupted by a restart/);
  assert.match(report.change_summary, /Interrupted by a restart/);
  assert.equal(report.interrupted_by_restart, true);

  assert.equal(bridge.n8n.workflows.get('ns3').active, true, 'the workflow is running again');
  assert.equal(report.active_restored, true);
  assert.match(report.change_summary, /Active state restored/);

  assert.equal(slack.incident.id, 'INC-901', 'the ledger incident can be closed: the original request was kept');
  assert.equal(slack.lane, 'north_star');

  assert.deepEqual(await inFlight(), [], 'the record is cleared, so a second restart does not report it twice');

  await bridge.close();
});

test('4b. a repair that reported leaves nothing for the next boot to find', async () => {
  const bridge = await boot({ claudeBin: await fakeClaude({ answer: REPAIRED }) });
  const { inFlight } = await import('../src/state.js');
  const { recover } = await import('../src/repair.js');

  await bridge.post(requestFor('ns1', 'North Star — Digest', '910'));
  await bridge.dashboard.waitFor(1);
  await idle(bridge.health);

  assert.deepEqual(await inFlight(), []);
  assert.deepEqual(await recover(), { recovered: 0, repairs: [] });
  assert.equal(bridge.dashboard.bodies.length, 1, 'boot has nothing to report, so it reports nothing');

  await bridge.close();
});

test('4c. an in-flight record that cannot be read is still reported', async () => {
  const bridge = await boot({ claudeBin: await fakeClaude({ answer: REPAIRED }) });
  const { recover } = await import('../src/repair.js');

  await writeFile(path.join(bridge.stateDir, 'REP-ns1-999.json'), '{ truncated half-writ');

  const result = await recover();
  assert.equal(result.recovered, 1);

  const [report] = await bridge.dashboard.waitFor(1);
  assert.equal(report.repair_id, 'REP-ns1-999');
  assert.equal(report.outcome, 'error');
  assert.match(report.root_cause, /could not be read/);

  await bridge.close();
});
