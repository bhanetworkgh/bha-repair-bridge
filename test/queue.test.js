/**
 * The queue on its own: one at a time, in order, and nothing lost when a job
 * throws.
 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import * as queue from '../src/queue.js';

beforeEach(() => queue.reset());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('two repairs never run at the same time, however they arrive', async () => {
  let concurrent = 0;
  let peak = 0;
  const order = [];

  const job = (id, ms) => async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    order.push(id);
    await wait(ms);
    concurrent--;
  };

  // Three failures reported within the same tick — the 22 Sep shape exactly.
  queue.enqueue({ repairId: 'REP-a-1', workflowId: 'a', job: job('a', 40) });
  queue.enqueue({ repairId: 'REP-b-1', workflowId: 'b', job: job('b', 10) });
  queue.enqueue({ repairId: 'REP-c-1', workflowId: 'c', job: job('c', 10) });

  assert.equal(queue.busy(), 3, 'all three are accepted; none is dropped');
  assert.ok(await queue.idle(5000));

  assert.equal(peak, 1, 'one Claude Code run at a time');
  assert.deepEqual(order, ['a', 'b', 'c'], 'the failure reported first is repaired first');
});

test('the second and third wait rather than being refused', async () => {
  const first = queue.enqueue({ repairId: 'REP-a-1', workflowId: 'a', job: () => wait(30) });
  const second = queue.enqueue({ repairId: 'REP-b-1', workflowId: 'b', job: () => wait(5) });
  const third = queue.enqueue({ repairId: 'REP-c-1', workflowId: 'c', job: () => wait(5) });

  assert.equal(first.position, 0);
  assert.equal(second.position, 1);
  assert.equal(third.position, 2);
  assert.equal(second.waiting_for, 'REP-a-1', 'a waiting repair is told which one it is behind');
  assert.equal(third.waiting_for, 'REP-a-1');

  const snapshot = queue.snapshot();
  assert.equal(snapshot.queued.length + (snapshot.running ? 1 : 0), 3);

  assert.ok(await queue.idle(5000));
  assert.equal(queue.busy(), 0);
});

test('a workflow already running or already waiting is known to be held', async () => {
  queue.enqueue({ repairId: 'REP-a-1', workflowId: 'a', job: () => wait(40) });
  queue.enqueue({ repairId: 'REP-b-1', workflowId: 'b', job: () => wait(40) });

  await wait(5);
  assert.deepEqual(queue.heldBy('a'), { repair_id: 'REP-a-1', state: 'running' });
  assert.deepEqual(queue.heldBy('b'), { repair_id: 'REP-b-1', state: 'queued' });
  assert.equal(queue.heldBy('c'), null);

  assert.ok(await queue.idle(5000));
  assert.equal(queue.heldBy('a'), null, 'a finished repair holds nothing');
});

test('a job that throws does not stop the queue', async () => {
  const ran = [];
  queue.enqueue({ repairId: 'REP-a-1', workflowId: 'a', job: async () => { ran.push('a'); throw new Error('the repair blew up'); } });
  queue.enqueue({ repairId: 'REP-b-1', workflowId: 'b', job: async () => { ran.push('b'); } });

  assert.ok(await queue.idle(5000));
  assert.deepEqual(ran, ['a', 'b'], 'one bad repair must not cost every repair behind it');
});

test('queue positions are renumbered as the queue drains', async () => {
  queue.enqueue({ repairId: 'REP-a-1', workflowId: 'a', job: () => wait(40) });
  queue.enqueue({ repairId: 'REP-b-1', workflowId: 'b', job: () => wait(40) });
  queue.enqueue({ repairId: 'REP-c-1', workflowId: 'c', job: () => wait(5) });

  await wait(60);
  const queued = queue.snapshot().queued;
  assert.ok(queued.every((q) => q.position >= 1), 'a waiting repair says where it is now, not where it was accepted');

  assert.ok(await queue.idle(5000));
});
