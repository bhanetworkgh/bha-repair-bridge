/**
 * What counts as a later run that proves a fix (20 Oct 2026, INC-BAYS.CODEX-035).
 *
 * The Submit Actions repair changed "Build Layer 2 Payload". Ahad's log
 * (execution 43198) then succeeded, but it stopped at "Filter - Layer 0 Failed"
 * and never ran the changed step, and the watch settled the repair as
 * `repaired` on it. These pin the rule against a stub n8n: a run proves the fix
 * only if it ran a changed node; one that did not goes to `notReached`.
 *
 * Calls `laterRuns` directly, so it needs no express and no Claude binary.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';

const WF = 'YTpezWSOIN6TNYcX';
const iso = (ms) => new Date(ms).toISOString();

function run({ id, status = 'success', startedAt, ran, last = ran[ran.length - 1] }) {
  return {
    id,
    workflowId: WF,
    mode: 'integrated',
    status,
    startedAt,
    stoppedAt: startedAt,
    data: { resultData: { lastNodeExecuted: last, runData: Object.fromEntries(ran.map((n) => [n, [{ data: { main: [[{ json: { ok: true } }]] } }]])) } },
  };
}

async function stub(executions) {
  const byId = new Map(executions.map((e) => [String(e.id), e]));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://n8n');
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const one = url.pathname.match(/^\/api\/v1\/executions\/([^/]+)$/);
    if (one) {
      const e = byId.get(decodeURIComponent(one[1]));
      return e ? send(200, e) : send(404, { message: 'not found' });
    }
    if (url.pathname === '/api/v1/executions') {
      const list = [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map(({ data, ...meta }) => meta);
      return send(200, { data: list, nextCursor: null });
    }
    return send(404, { message: `no stub for ${url.pathname}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { N8N_BASE_URL: `http://127.0.0.1:${server.address().port}`, N8N_API_KEY: 'n8n-key' });
  return server;
}

const since = Date.now() - 60_000;
const LAYER1_ONLY = ['Webhook', 'Layer 1 — BHA Log Review', 'Filter - Layer 0 Failed'];
const LAYER2 = ['Webhook', 'Layer 1 — BHA Log Review', 'Build Layer 2 Payload', 'Check Logstream Posted'];

test('CODEX-035: a success that never ran the changed step is not proof', async () => {
  const server = await stub([run({ id: '43198', startedAt: iso(since + 5_000), ran: LAYER1_ONLY })]);
  try {
    const { laterRuns } = await import('../src/verify.js');
    const later = await laterRuns({ workflowId: WF, sinceMs: since, signature: null, reachNodes: ['Build Layer 2 Payload'] });
    assert.deepEqual(later.passed, []);
    assert.equal(later.notReached.length, 1);
    assert.equal(later.notReached[0].execution_id, '43198');
    assert.match(later.notReached[0].reason, /stopped at Filter - Layer 0 Failed and never ran Build Layer 2 Payload/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a success that ran the changed step is proof, and names the step it ran', async () => {
  const server = await stub([
    run({ id: '43198', startedAt: iso(since + 5_000), ran: LAYER1_ONLY }),
    run({ id: '43300', startedAt: iso(since + 9_000), ran: LAYER2 }),
  ]);
  try {
    const { laterRuns } = await import('../src/verify.js');
    const later = await laterRuns({ workflowId: WF, sinceMs: since, signature: null, reachNodes: ['Build Layer 2 Payload', 'Check Logstream Posted'] });
    assert.deepEqual(later.passed.map((r) => r.execution_id), ['43300']);
    assert.deepEqual(later.passed[0].reached, ['Build Layer 2 Payload', 'Check Logstream Posted']);
    assert.deepEqual(later.notReached.map((r) => r.execution_id), ['43198']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('with no changed nodes named, the old rule stands: any later success counts', async () => {
  const server = await stub([run({ id: '43198', startedAt: iso(since + 5_000), ran: LAYER1_ONLY })]);
  try {
    const { laterRuns } = await import('../src/verify.js');
    const later = await laterRuns({ workflowId: WF, sinceMs: since, signature: null });
    assert.deepEqual(later.passed.map((r) => r.execution_id), ['43198']);
    assert.deepEqual(later.notReached, []);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a run whose data cannot be read is never counted as proof', async () => {
  const e = run({ id: '43400', startedAt: iso(since + 5_000), ran: LAYER2 });
  delete e.data.resultData.runData;
  const server = await stub([e]);
  try {
    const { laterRuns } = await import('../src/verify.js');
    const later = await laterRuns({ workflowId: WF, sinceMs: since, signature: null, reachNodes: ['Build Layer 2 Payload'] });
    assert.deepEqual(later.passed, []);
    assert.match(later.notReached[0].reason, /could not be read/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
