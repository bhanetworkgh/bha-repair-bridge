/** What a retry can prove, and which failures are alarms rather than faults (30 Sep 2026). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedNodeNames, downstreamOf, retryCanProve, isDeliberateAlarm } from '../src/proof.js';

const conns = { Build: { main: [[{ node: 'Post' }]] }, Post: { main: [[{ node: 'Assert' }]] }, Assert: { main: [[{ node: 'Record' }]] } };
const wf = (build = 'a', assert_ = 'a') => ({
  nodes: [
    { name: 'Build', type: 'n8n-nodes-base.code', parameters: { jsCode: build } },
    { name: 'Post', type: 'n8n-nodes-base.httpRequest', parameters: {} },
    { name: 'Assert', type: 'n8n-nodes-base.code', parameters: { jsCode: assert_ } },
    { name: 'Record', type: 'n8n-nodes-base.httpRequest', parameters: {} },
  ],
  connections: conns,
});

test('changedNodeNames finds edits, additions and removals', () => {
  assert.deepEqual(changedNodeNames(wf(), wf('b')), ['Build']);
  assert.deepEqual(changedNodeNames(wf(), wf()), []);
  const added = wf(); added.nodes.push({ name: 'New', type: 'n8n-nodes-base.set', parameters: {} });
  assert.deepEqual(changedNodeNames(wf(), added), ['New']);
  assert.deepEqual(changedNodeNames(added, wf()), ['New']);
});

test('downstreamOf includes the start and everything after it', () => {
  assert.deepEqual([...downstreamOf(conns, 'Post')].sort(), ['Assert', 'Post', 'Record']);
});

test('a fix upstream of the failed node cannot be proved by a retry (the Builder Chasers case)', () => {
  const r = retryCanProve({ failedNode: 'Assert', before: wf(), after: wf('fixed') });
  assert.equal(r.ok, false);
  assert.deepEqual(r.upstream, ['Build']);
});

test('a fix in the failed node or after it can be proved by a retry', () => {
  assert.equal(retryCanProve({ failedNode: 'Assert', before: wf(), after: wf('a', 'fixed') }).ok, true);
});

test('with no failed node, or nothing changed, a retry is not trusted', () => {
  assert.equal(retryCanProve({ failedNode: null, before: wf(), after: wf('b') }).ok, false);
  assert.equal(retryCanProve({ failedNode: 'Assert', before: wf(), after: wf() }).ok, false);
});

test('a Raise node is a deliberate alarm, an Assert node is not', () => {
  const w = { nodes: [{ name: 'Raise Refused Click', type: 'n8n-nodes-base.code' }, { name: 'Assert Chaser Delivered', type: 'n8n-nodes-base.code' }, { name: 'Raise Thing', type: 'n8n-nodes-base.httpRequest' }] };
  assert.equal(isDeliberateAlarm(w, 'Raise Refused Click'), true);
  assert.equal(isDeliberateAlarm(w, 'Assert Chaser Delivered'), false);
  assert.equal(isDeliberateAlarm(w, 'Raise Thing'), false);
  assert.equal(isDeliberateAlarm(w, 'Missing'), false);
  assert.equal(isDeliberateAlarm(w, null), false);
});
