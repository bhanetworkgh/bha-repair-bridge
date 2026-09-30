/** What the model is shown beyond the failed node (30 Sep 2026). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFailure, prompt } from '../src/prompt.js';
import { historyText } from '../src/history.js';
import { nodeSizes, noteCrash } from '../src/crashes.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const wf = {
  nodes: [
    { name: 'Fetch', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'x' } },
    { name: 'Build Cards', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return [{json:{blocks:1}}]' } },
    { name: 'Post', type: 'n8n-nodes-base.httpRequest', parameters: {} },
    { name: 'Assert Delivered', type: 'n8n-nodes-base.code', parameters: { jsCode: 'throw' } },
  ],
  connections: { Fetch: { main: [[{ node: 'Build Cards' }]] }, 'Build Cards': { main: [[{ node: 'Post' }]] }, Post: { main: [[{ node: 'Assert Delivered' }]] } },
};
const exec = { data: { resultData: { runData: { Fetch: [{ data: { main: [[{ json: { a: 1 } }]] } }], 'Build Cards': [{ data: { main: [[{ json: { blocks: 60 } }]] } }], Post: [{ data: { main: [[{ json: { ok: false } }]] } }] } } } };

test('the path to an Assert failure reaches the node that built the message, nearest first', () => {
  const p = pathToFailure({ workflow: wf, execution: exec, nodeName: 'Assert Delivered' });
  assert.deepEqual(p.map((n) => n.name), ['Post', 'Build Cards', 'Fetch']);
  assert.equal(p[1].config, 'return [{json:{blocks:1}}]');
  assert.deepEqual(p[1].first_output, [{ blocks: 60 }]);
});

test('the prompt carries the path, the earlier repairs and the patterns step', () => {
  const text = prompt({ repairId: 'R', request: { workflow: { id: 'w', name: 'W' }, execution: { id: '1' }, error: {} }, workflow: wf, ctx: { nodeName: 'Assert Delivered', node: null, input: {}, output: [], upstream: ['Post'] }, files: [], dryRun: false, path: pathToFailure({ workflow: wf, execution: exec, nodeName: 'Assert Delivered' }), history: historyText({ ok: true, repairs: [{ repair_id: 'REP-w-9', outcome: 'not_repaired', reverted: true, failed_node: 'Assert Delivered', root_cause: 'too long', change_summary: 'split' }] }) });
  assert.match(text, /THE PATH THAT LED HERE/);
  assert.match(text, /"Build Cards"/);
  assert.match(text, /REP-w-9: not_repaired \(the change was PUT BACK\)/);
  assert.match(text, /Read repair-patterns.md first/);
  assert.match(text, /follow the\s+path above upstream/);
});

test('a history that could not be read says so rather than inventing none', () => {
  assert.match(historyText({ ok: false, error: 'the dashboard answered 500' }), /could not be read: the dashboard answered 500/);
  assert.match(historyText({ ok: true, repairs: [] }), /first repair/);
});

test('crashes are counted per workflow inside 24 hours', async () => {
  process.env.STATE_DIR = await mkdtemp(path.join(tmpdir(), 'crash-'));
  const t = Date.now();
  assert.equal(noteCrash('A', t), 1);
  assert.equal(noteCrash('A', t + 1000), 2);
  assert.equal(noteCrash('B', t + 1000), 1);
  assert.equal(noteCrash('A', t + 26 * 3600 * 1000), 1, 'older than a day no longer counts');
});

test('node sizes put the largest producer first', () => {
  assert.equal(nodeSizes(exec)[0].node, 'Build Cards');
});
