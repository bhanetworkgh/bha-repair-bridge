/**
 * The HTTP surface on its own: what answers before any secret exists, what the
 * key does, and what a malformed request gets told.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let base;
let server;

before(async () => {
  for (const name of ['BRIDGE_KEY', 'N8N_BASE_URL', 'N8N_API_KEY', 'DASHBOARD_URL', 'DASHBOARD_INBOUND_KEY', 'REPORT_WEBHOOK_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    delete process.env[name];
  }
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const get = async (p) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
};

const post = async (p, body, headers = {}) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('/health answers before a single secret is set, and names the ones that are missing', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.busy, 0);
  assert.equal(r.body.running, 0);
  assert.equal(r.body.queued, 0);
  assert.equal(r.body.dry_run, false);
  assert.deepEqual(r.body.env_missing, ['BRIDGE_KEY', 'N8N_BASE_URL', 'N8N_API_KEY', 'DASHBOARD_URL', 'DASHBOARD_INBOUND_KEY', 'REPORT_WEBHOOK_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
});

test('without BRIDGE_KEY nothing is accepted, and the answer says why', async () => {
  const r = await post('/fix-workflow', { workflow: { id: 'a' }, execution: { id: 'b' } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /BRIDGE_KEY is not set/);
});

test('the wrong key is 401 and the right one is 202', async () => {
  process.env.BRIDGE_KEY = 'secret';

  assert.equal((await post('/fix-workflow', { workflow: { id: 'a' }, execution: { id: 'b' } })).status, 401);
  assert.equal((await post('/fix-workflow', { workflow: { id: 'a' }, execution: { id: 'b' } }, { 'x-api-key': 'wrong' })).status, 401);

  // Refused by name, so this one accepts and skips without reaching n8n.
  const ok = await post('/fix-workflow', { workflow: { id: 'a', name: 'BHA — Self Healer' }, execution: { id: 'b' } }, { 'x-api-key': 'secret' });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.accepted, true);
  assert.equal(ok.body.repair_id, 'REP-a-b');

  delete process.env.BRIDGE_KEY;
});

test('a request that names no workflow or execution is refused with the reason', async () => {
  process.env.BRIDGE_KEY = 'secret';
  const r = await post('/fix-workflow', { workflow: {}, execution: {} }, { 'x-api-key': 'secret' });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /workflow\.id and execution\.id/);
  delete process.env.BRIDGE_KEY;
});

test('a body that is not JSON is the caller’s mistake, not a 500', async () => {
  process.env.BRIDGE_KEY = 'secret';
  const r = await post('/fix-workflow', 'not json', { 'x-api-key': 'secret' });
  assert.equal(r.status, 400);
  delete process.env.BRIDGE_KEY;
});

test('an unknown route says what this service does have', async () => {
  const r = await get('/repair');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /\/health and \/fix-workflow/);
});

test('?deep=1 runs Claude Code and reports what it answered', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify({ type: 'result', result: 'OK', modelUsage: { 'anthropic/claude-sonnet-4.5': {} } })}'\n`);
  await chmod(bin, 0o755);
  process.env.CLAUDE_BIN = bin;

  const r = await get('/health?deep=1');
  assert.equal(r.body.claude_reachable, true);
  assert.equal(r.body.model, 'anthropic/claude-sonnet-4.5');
  assert.equal(r.body.error, null);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.env_missing.includes('BRIDGE_KEY'), true, 'the shallow fields are still there');

  delete process.env.CLAUDE_BIN;
});

test('a deep check that cannot reach the model says so rather than passing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  await writeFile(bin, '#!/bin/sh\ncat > /dev/null\necho "Invalid API key" >&2\nexit 1\n');
  await chmod(bin, 0o755);
  process.env.CLAUDE_BIN = bin;

  const r = await get('/health?deep=1');
  assert.equal(r.body.ok, false);
  assert.equal(r.body.claude_reachable, false);
  assert.match(r.body.error, /Invalid API key/);

  delete process.env.CLAUDE_BIN;
});
