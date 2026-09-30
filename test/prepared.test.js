/**
 * Prepared fixes for protected workflows (30 Sep 2026): drafted, tested, checked by
 * the bridge, applied only on a person's Apply, proved, and put back when wrong.
 *
 * Stubs for n8n's REST API, n8n's MCP server, the dashboard and the webhook, and a
 * fake `claude` that stands in for a run by changing the stub's draft.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentFingerprint, passByCase, regressions } from '../src/prepared.js';

const FRONT_DOOR = '134ezjaO6gYqYjez'; // Bays — Front Door, one of the six
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

function stubs() {
  const st = {
    versionId: 'v1',
    active: 'v1',
    testStatus: 'success',
    later: [],
    calls: [],
    agentDraft: 'same',
  };
  const now = () => new Date().toISOString();

  const n8n = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-n8n-api-key'] !== 'n8n-key') return send(401, {});
    const wf = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
    if (wf) return send(200, { id: wf[1], name: 'Bays — Front Door', versionId: st.versionId, active: true, nodes: [{ name: 'Parse', type: 'n8n-nodes-base.code', parameters: { jsCode: 'x' } }], connections: {} });
    const ex = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
    if (ex) {
      const id = ex[1];
      if (id.startsWith('test-')) return send(200, { id, workflowId: FRONT_DOOR, status: st.testStatus, startedAt: now(), mode: 'manual' });
      const l = st.later.find((e) => e.id === id);
      if (l) return send(200, { ...l, data: { resultData: l.status === 'success' ? { runData: {} } : { lastNodeExecuted: 'Parse', error: { message: 'boom' }, runData: {} } } });
      return send(200, { id, workflowId: FRONT_DOOR, status: 'error', mode: 'webhook', data: { resultData: { lastNodeExecuted: 'Parse', error: { message: 'boom' }, runData: { Parse: [{ error: { message: 'boom' }, data: { main: [[]] } }] } } } });
    }
    if (url.pathname === '/api/v1/executions') return send(200, { data: st.later, nextCursor: null });
    return send(404, {});
  });

  const mcpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (body, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      if (url.pathname === '/flip') { st.versionId = 'draft-2'; return send({ ok: true }); }
      if (url.pathname === '/flip-agent') { st.agentDraft = 'changed'; return send({ ok: true }); }
      if (url.pathname === '/flip-live') { st.active = 'sneaky'; st.versionId = 'sneaky'; return send({ ok: true }); }
      if (req.headers.authorization !== 'Bearer mcp-token') { res.writeHead(401); return res.end(); }
      const m = JSON.parse(raw || '{}');
      if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }, { 'mcp-session-id': 's1' });
      if (!m.id) { res.writeHead(202); return res.end(); }
      const { name, arguments: a } = m.params;
      st.calls.push({ name, args: a });
      const ok = (v) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(v) }] } });
      if (name === 'get_workflow_details') return ok({ workflow: { id: a.workflowId, versionId: st.versionId, activeVersionId: st.active, active: true } });
      if (name === 'publish_workflow') { st.active = a.versionId ?? st.versionId; return ok({ success: true, activeVersionId: st.active }); }
      if (name === 'restore_workflow_version') { st.versionId = `restored-${a.versionId}`; return ok({ ok: true }); }
      if (name === 'get_agent') return ok(a.versionId ? { agent: { activeVersionId: 'AV1' }, config: { i: 'live' }, skills: {}, tasks: [], customTools: [] } : { agent: { activeVersionId: 'AV1' }, config: { i: st.agentDraft === 'same' ? 'live' : st.agentDraft }, skills: {}, tasks: [], customTools: [] });
      if (name === 'validate_agent') return ok({ valid: true });
      if (name === 'revert_agent' || name === 'publish_agent') return ok({ ok: true });
      return send({ jsonrpc: '2.0', id: m.id, error: { message: `no stub for ${name}` } });
    });
  });

  const collector = () => {
    const bodies = [];
    const outcomes = [];
    const server = createServer((req, res) => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"repairs":[]}'); }
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        (req.url.includes('prepared-outcome') ? outcomes : bodies).push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const waitFor = async (list, n, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (list.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return list;
    };
    return { server, bodies, outcomes, waitFor };
  };

  return { st, n8n, mcpServer, dashboard: collector(), webhook: collector() };
}

async function fakeClaude(answer, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const envelope = JSON.stringify({ type: 'result', subtype: 'success', result: answer, modelUsage: { 'claude-opus-5-5': {} } });
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\n${body}\ncat <<'ENVELOPE'\n${envelope}\nENVELOPE\n`);
  await chmod(bin, 0o755);
  return bin;
}

const ANSWER = JSON.stringify({ outcome: 'needs_human', root_cause: 'Parse read the wrong field.', change_summary: 'Parse now reads body.event.', nodes_changed: ['Parse'], human_action: '', test_execution_ids: ['test-1'] });

async function boot({ flip = 'flip', testStatus = 'success' } = {}) {
  const s = stubs();
  s.st.testStatus = testStatus;
  const [n8nUrl, mcpUrl, dashUrl, hookUrl] = await Promise.all([listen(s.n8n), listen(s.mcpServer), listen(s.dashboard.server), listen(s.webhook.server)]);
  Object.assign(process.env, {
    BRIDGE_KEY: 'bridge-key', N8N_BASE_URL: n8nUrl, N8N_API_KEY: 'n8n-key', DASHBOARD_URL: dashUrl, DASHBOARD_INBOUND_KEY: 'dash-key',
    REPORT_WEBHOOK_URL: hookUrl, DRY_RUN: 'false', REPAIR_TIMEOUT_MS: '20000', N8N_MCP_URL: `${mcpUrl}/mcp`, N8N_MCP_TOKEN: 'mcp-token',
    VERIFY_POLL_MS: '200', VERIFY_WINDOW_MS: '5000',
    STATE_DIR: await mkdtemp(path.join(tmpdir(), 'prep-state-')),
    CLAUDE_BIN: await fakeClaude(ANSWER, flip ? `curl -s -X POST ${mcpUrl}/${flip} > /dev/null` : ''),
  });
  (await import('../src/mcp.js')).resetForTests();
  const { idle } = await import('../src/queue.js');
  await idle(30_000);
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const close = async () => { for (const x of [server, s.n8n, s.mcpServer, s.dashboard.server, s.webhook.server]) await new Promise((r) => x.close(r)); };
  return { ...s, base, post, close };
}

const request = (executionId) => ({ lane: 'bays', workflow: { id: FRONT_DOOR, name: 'Bays — Front Door' }, execution: { id: executionId, lastNodeExecuted: 'Parse' }, error: { class: 'unknown', message: 'boom', failed_node: 'Parse' } });

test('a protected workflow gets a drafted, tested fix offered for Apply, and nothing is published', async () => {
  const b = await boot();
  try {
    await b.post('/fix-workflow', request('900'), { 'x-api-key': 'bridge-key' });
    const [report] = await b.dashboard.waitFor(b.dashboard.bodies, 1);
    assert.equal(report.outcome, 'needs_human');
    assert.deepEqual({ ...report.prepared_fix, summary: undefined }, { kind: 'workflow', workflow_id: FRONT_DOOR, draft_version: 'draft-2', restore_version: 'v1', tests: ['test-1'], summary: undefined });
    assert.equal(report.prepared_state, 'pending');
    assert.match(report.change_summary, /^PREPARED AND TESTED, NOT LIVE/);
    assert.match(report.human_action, /Press Apply/);
    assert.equal(b.st.calls.filter((c) => c.name.startsWith('publish')).length, 0, 'nothing was published');
    assert.equal(b.st.active, 'v1');
  } finally {
    await b.close();
  }
});

test('a fault in the agent\'s own settings gets a validated agent draft offered for Apply', async () => {
  const b = await boot({ flip: 'flip-agent' });
  try {
    await b.post('/fix-workflow', request('906'), { 'x-api-key': 'bridge-key' });
    const [report] = await b.dashboard.waitFor(b.dashboard.bodies, 1);
    assert.equal(report.prepared_fix?.kind, 'agent');
    assert.equal(report.prepared_fix.agent_id, 'Nw5igXu4WWrjUMWB');
    assert.equal(report.prepared_fix.restore_version, 'AV1');
    assert.match(report.human_action, /runs the eval set/);
    assert.equal(b.st.calls.filter((c) => c.name.startsWith('publish')).length, 0);
  } finally {
    await b.close();
  }
});

test('a draft whose test did not pass is thrown away and nothing is offered', async () => {
  const b = await boot({ testStatus: 'error' });
  try {
    await b.post('/fix-workflow', request('901'), { 'x-api-key': 'bridge-key' });
    const [report] = await b.dashboard.waitFor(b.dashboard.bodies, 1);
    assert.equal(report.prepared_fix, undefined);
    assert.match(report.change_summary, /no pinned test of it passed/);
    assert.ok(b.st.calls.some((c) => c.name === 'restore_workflow_version' && c.args.versionId === 'v1'), 'the draft was discarded');
  } finally {
    await b.close();
  }
});

test('a run that changed the live version has it put straight back and offers nothing', async () => {
  const b = await boot({ flip: 'flip-live' });
  try {
    await b.post('/fix-workflow', request('902'), { 'x-api-key': 'bridge-key' });
    const [report] = await b.dashboard.waitFor(b.dashboard.bodies, 1);
    assert.equal(report.prepared_fix, undefined);
    assert.match(report.change_summary, /live workflow changed during the run/);
    assert.ok(b.st.calls.some((c) => c.name === 'publish_workflow' && c.args.versionId === 'v1'), 'live put back');
  } finally {
    await b.close();
  }
});

test('Apply publishes exactly the tested draft, a later real run proves it, and the row is told', async () => {
  const b = await boot();
  try {
    b.st.versionId = 'draft-2';
    const fix = { kind: 'workflow', workflow_id: FRONT_DOOR, draft_version: 'draft-2', restore_version: 'v1', tests: ['test-1'] };
    const denied = await b.post('/prepared/REP-x-900/apply', { prepared_fix: fix }, { 'x-dashboard-key': 'wrong' });
    assert.equal(denied.status, 401);
    const r = await b.post('/prepared/REP-x-900/apply', { prepared_fix: fix, execution_id: '900', failed_node: 'Parse' }, { 'x-dashboard-key': 'dash-key' });
    assert.equal(r.body.ok, true, r.body.message);
    assert.equal(b.st.active, 'draft-2');
    b.st.later.push({ id: 'real-1', workflowId: FRONT_DOOR, status: 'success', mode: 'webhook', startedAt: new Date(Date.now() + 1000).toISOString() });
    const [outcome] = await b.dashboard.waitFor(b.dashboard.outcomes, 1);
    assert.equal(outcome.state, 'held');
    assert.match(outcome.message, /real-1/);
  } finally {
    await b.close();
  }
});

test('Apply on a fix whose next real run fails the same way puts the old version back', async () => {
  const b = await boot();
  try {
    b.st.versionId = 'draft-2';
    const fix = { kind: 'workflow', workflow_id: FRONT_DOOR, draft_version: 'draft-2', restore_version: 'v1' };
    const r = await b.post('/prepared/REP-x-903/apply', { prepared_fix: fix, execution_id: '903', failed_node: 'Parse' }, { 'x-dashboard-key': 'dash-key' });
    assert.equal(r.body.ok, true);
    b.st.later.push({ id: 'real-2', workflowId: FRONT_DOOR, status: 'error', mode: 'webhook', startedAt: new Date(Date.now() + 1000).toISOString() });
    const [outcome] = await b.dashboard.waitFor(b.dashboard.outcomes, 1);
    assert.equal(outcome.state, 'reverted');
    assert.equal(b.st.active, 'v1', 'the old version is live again');
  } finally {
    await b.close();
  }
});

test('Apply refuses when the draft or the live version moved since it was tested', async () => {
  const b = await boot();
  try {
    b.st.versionId = 'someone-else';
    const fix = { kind: 'workflow', workflow_id: FRONT_DOOR, draft_version: 'draft-2', restore_version: 'v1' };
    const r = await b.post('/prepared/REP-x-904/apply', { prepared_fix: fix }, { 'x-dashboard-key': 'dash-key' });
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /edited since it was tested/);
    b.st.versionId = 'draft-2';
    b.st.active = 'v9';
    const r2 = await b.post('/prepared/REP-x-904/apply', { prepared_fix: fix }, { 'x-dashboard-key': 'dash-key' });
    assert.match(r2.body.message, /live workflow has changed/);
    assert.equal(b.st.calls.filter((c) => c.name === 'publish_workflow').length, 0);
  } finally {
    await b.close();
  }
});

test('Discard throws the draft away', async () => {
  const b = await boot();
  try {
    const r = await b.post('/prepared/REP-x-905/discard', { prepared_fix: { kind: 'workflow', workflow_id: FRONT_DOOR, draft_version: 'draft-2', restore_version: 'v1' } }, { 'x-dashboard-key': 'dash-key' });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.state, 'discarded');
    assert.ok(b.st.calls.some((c) => c.name === 'restore_workflow_version'));
  } finally {
    await b.close();
  }
});

test('eval comparison: a case that passed before and fails now is a regression; repeats all must pass', () => {
  const before = passByCase([{ Agent: 'bays', 'Case ID': 'A', Passed: true }, { Agent: 'bays', 'Case ID': 'B', Passed: false }, { Agent: 'north_star', 'Case ID': 'N', Passed: true }], 'bays');
  const after = passByCase([{ Agent: 'bays', 'Case ID': 'A', Passed: true }, { Agent: 'bays', 'Case ID': 'A', Passed: false }, { Agent: 'bays', 'Case ID': 'B', Passed: true }], 'bays');
  assert.deepEqual(before, { A: true, B: false });
  assert.deepEqual(regressions(before, after), ['A']);
});

test('an agent fingerprint ignores task order and timestamps, not content', () => {
  const a = { config: { i: 1 }, skills: {}, customTools: [], tasks: [{ id: 't2', name: 'b', createdAt: 'x' }, { id: 't1', name: 'a' }] };
  const b = { config: { i: 1 }, skills: {}, customTools: [], tasks: [{ id: 't1', name: 'a', updatedAt: 'y' }, { id: 't2', name: 'b' }] };
  assert.equal(agentFingerprint(a), agentFingerprint(b));
  assert.notEqual(agentFingerprint(a), agentFingerprint({ ...b, config: { i: 2 } }));
});
