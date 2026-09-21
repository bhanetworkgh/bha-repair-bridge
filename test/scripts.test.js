/**
 * The two helper scripts, run for real against a stub n8n.
 *
 * These exist because the model hand-rolled a curl and got a 401 on a key that
 * worked. The scripts are the fix, so they are tested as scripts — executed,
 * not read — and the things that matter are: the header goes out, only the four
 * keys n8n accepts are sent, a refused write says so and fails, and every call
 * lands in the log this service reads afterwards.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CALL_LOG, GET_SCRIPT, PUT_SCRIPT, failedWriteNote, lastFailedWrite, parseCallLog, readCallLog, wroteSuccessfully, writeHelperScripts } from '../src/scripts.js';

const run = promisify(execFile);

const WORKFLOW = {
  id: 'wf1',
  name: 'Bays — Slack Router',
  versionId: 'v1',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  tags: [{ id: 't1', name: 'bays' }],
  nodes: [{ name: 'Map fields', type: 'n8n-nodes-base.set', parameters: {} }],
  connections: { Webhook: { main: [[{ node: 'Map fields' }]] } },
  settings: { executionOrder: 'v1' },
};

/** A stub n8n that records what it was sent and answers how the test tells it to. */
function stub({ putStatus = 200, putBody = { id: 'wf1', versionId: 'v2' }, requireKey = 'n8n-key' } = {}) {
  const seen = { get: 0, put: 0, keys: [], headers: [], body: null };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.headers.push(req.headers);
      const send = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (requireKey && req.headers['x-n8n-api-key'] !== requireKey) {
        return send(401, { message: 'unauthorized' });
      }
      if (req.method === 'GET') {
        seen.get++;
        return send(200, WORKFLOW);
      }
      seen.put++;
      seen.body = JSON.parse(raw || '{}');
      seen.keys = Object.keys(seen.body).sort();
      return send(putStatus, putBody);
    });
  });
  return { server, seen };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

async function setup(options = {}) {
  const s = stub(options);
  const base = await listen(s.server);
  const dir = await mkdtemp(path.join(tmpdir(), 'scripts-'));
  await writeHelperScripts({ dir, workflowId: 'wf1' });
  const env = { PATH: process.env.PATH, HOME: dir, N8N_BASE_URL: base, N8N_API_KEY: options.key ?? 'n8n-key' };
  const call = (script, args = []) => run(path.join(dir, script), args, { cwd: dir, env });
  return { dir, env, call, seen: s.seen, close: () => new Promise((r) => s.server.close(r)) };
}

test('the get script prints the workflow and sends the key itself', async () => {
  const { call, seen, dir, close } = await setup();
  const { stdout } = await call(GET_SCRIPT);
  const workflow = JSON.parse(stdout);

  assert.equal(workflow.id, 'wf1');
  assert.equal(seen.get, 1);
  assert.equal(seen.headers[0]['x-n8n-api-key'], 'n8n-key');

  const log = await readCallLog(path.join(dir, CALL_LOG));
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].method, log[0].status], ['GET', 200]);
  await close();
});

test('the put script sends only name, nodes, connections and settings', async () => {
  const { call, seen, dir, close } = await setup();
  await writeFile(path.join(dir, 'fixed.json'), JSON.stringify({ ...WORKFLOW, name: 'Bays — Slack Router', nodes: [{ name: 'Map fields', parameters: { fixed: true } }] }));

  const { stdout } = await call(PUT_SCRIPT, ['fixed.json']);

  assert.match(stdout, /^HTTP 200/);
  assert.deepEqual(seen.keys, ['connections', 'name', 'nodes', 'settings']);
  assert.equal(seen.body.nodes[0].parameters.fixed, true);
  assert.equal(seen.body.settings.executionOrder, 'v1');
  assert.equal('active' in seen.body, false, 'active is never sent');
  assert.equal('versionId' in seen.body, false);
  assert.equal('id' in seen.body, false);
  assert.equal('tags' in seen.body, false);

  const log = await readCallLog(path.join(dir, CALL_LOG));
  assert.equal(wroteSuccessfully(log), true);
  assert.equal(lastFailedWrite(log), null);
  await close();
});

test('a refused write prints the status and the body, and fails', async () => {
  const { call, dir, close } = await setup({ putStatus: 400, putBody: { message: 'request/body must NOT have additional properties' } });
  await writeFile(path.join(dir, 'fixed.json'), JSON.stringify(WORKFLOW));

  const failed = await call(PUT_SCRIPT, ['fixed.json']).then(
    () => null,
    (e) => e,
  );

  assert.ok(failed, 'a non-2xx write must exit non-zero');
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /HTTP 400/);
  assert.match(failed.stdout, /additional properties/);

  const log = await readCallLog(path.join(dir, CALL_LOG));
  const bad = lastFailedWrite(log);
  assert.equal(bad.status, 400);
  assert.match(failedWriteNote(bad), /refused \(HTTP 400\).*additional properties/s);
  await close();
});

test('a 401 from n8n is reported as a refused write, not swallowed', async () => {
  const { call, dir, close } = await setup({ key: 'the-wrong-key' });
  await writeFile(path.join(dir, 'fixed.json'), JSON.stringify(WORKFLOW));

  const failed = await call(PUT_SCRIPT, ['fixed.json']).then(() => null, (e) => e);
  assert.match(failed.stdout, /HTTP 401/);

  const log = await readCallLog(path.join(dir, CALL_LOG));
  assert.equal(lastFailedWrite(log).status, 401);
  await close();
});

test('the put script refuses a fragment rather than sending one', async () => {
  const { call, dir, close } = await setup();
  await writeFile(path.join(dir, 'partial.json'), JSON.stringify({ nodes: [] }));

  const failed = await call(PUT_SCRIPT, ['partial.json']).then(() => null, (e) => e);
  assert.equal(failed.code, 2);
  assert.match(failed.stderr, /has no name/);

  await writeFile(path.join(dir, 'broken.json'), '{not json');
  const broken = await call(PUT_SCRIPT, ['broken.json']).then(() => null, (e) => e);
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /not valid JSON/);
  await close();
});

test('the put script says how to call it when called wrong', async () => {
  const { call, close } = await setup();
  const noArgs = await call(PUT_SCRIPT).then(() => null, (e) => e);
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stderr, /usage: \.\/n8n-put-workflow\.sh <file\.json>/);

  const missing = await call(PUT_SCRIPT, ['nope.json']).then(() => null, (e) => e);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no such file/);
  await close();
});

test('a script with no credentials in its environment says so and does nothing', async () => {
  const { dir, close } = await setup();
  const failed = await run(path.join(dir, GET_SCRIPT), [], { cwd: dir, env: { PATH: process.env.PATH } }).then(() => null, (e) => e);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /N8N_BASE_URL is not set/);
  await close();
});

test('the call log ignores a line it cannot read rather than inventing one', () => {
  const log = parseCallLog(['2026-09-21T10:00:00Z\tGET\t200\t{"id":"wf1"}', 'rubbish', '', '2026-09-21T10:00:05Z\tPUT\t401\tunauthorized'].join('\n'));
  assert.equal(log.length, 2);
  assert.equal(log[1].status, 401);
});

test('the last write is what is reported, not any failure along the way', () => {
  const refusedThenFixed = parseCallLog(['a\tPUT\t400\tbad body', 'b\tPUT\t200\t{"versionId":"v2"}'].join('\n'));
  assert.equal(lastFailedWrite(refusedThenFixed), null, 'a write that was fixed and landed has nothing left to report');
  assert.equal(wroteSuccessfully(refusedThenFixed), true);

  const landedThenRefused = parseCallLog(['a\tPUT\t200\t{"versionId":"v2"}', 'b\tPUT\t401\tunauthorized'].join('\n'));
  assert.equal(lastFailedWrite(landedThenRefused).status, 401, 'a later refusal is still a change that did not land');
  assert.equal(wroteSuccessfully(landedThenRefused), true, 'and the earlier write did happen');
});
