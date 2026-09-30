/** The second identical diagnosis without a repair hands over a patch (30 Sep 2026). */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { noteDiagnosis, clearDiagnoses, similar } from '../src/repeats.js';
import { patchText } from '../src/proof.js';

test('ids and numbers do not make identical diagnoses look different', () => {
  assert.equal(similar('Slack refused the chaser: invalid_blocks, section text over 3000 characters (execution 22467)', 'Slack refused the chaser: invalid_blocks, section text over 3000 characters (execution 22458)'), true);
  assert.equal(similar('Slack refused the chaser section text over the limit', 'Airtable table id was empty and returned not found'), false);
});

test('first diagnosis counts 1, the matching second counts 2, a different cause resets to 1', async () => {
  process.env.STATE_DIR = await mkdtemp(path.join(tmpdir(), 'repeats-'));
  const cause = 'Slack refused the returned log chaser because a section text passed 3000 characters';
  const a = await noteDiagnosis({ workflowId: 'W', failedNode: 'Assert', rootCause: cause, repairId: 'R1' });
  assert.equal(a.count, 1);
  const b = await noteDiagnosis({ workflowId: 'W', failedNode: 'Assert', rootCause: cause + ' (again)', repairId: 'R2' });
  assert.equal(b.count, 2);
  assert.deepEqual(b.repair_ids, ['R1']);
  const c = await noteDiagnosis({ workflowId: 'W', failedNode: 'Assert', rootCause: 'Airtable returned not found for an empty table identifier', repairId: 'R3' });
  assert.equal(c.count, 1);
  const otherNode = await noteDiagnosis({ workflowId: 'W', failedNode: 'Other', rootCause: cause, repairId: 'R4' });
  assert.equal(otherNode.count, 1);
});

test('a repair that worked ends the run', async () => {
  process.env.STATE_DIR = await mkdtemp(path.join(tmpdir(), 'repeats-'));
  const cause = 'the section text passed the slack limit of three thousand characters';
  await noteDiagnosis({ workflowId: 'W', failedNode: 'A', rootCause: cause, repairId: 'R1' });
  await clearDiagnoses({ workflowId: 'W', failedNode: 'A' });
  assert.equal((await noteDiagnosis({ workflowId: 'W', failedNode: 'A', rootCause: cause, repairId: 'R2' })).count, 1);
});

test('the patch names each changed node with its new code', () => {
  const before = { nodes: [{ name: 'Build', parameters: { jsCode: 'old' } }] };
  const after = { nodes: [{ name: 'Build', parameters: { jsCode: 'new code here' } }, { name: 'Added', parameters: { a: 1 } }] };
  const t = patchText(before, after, ['Build', 'Added']);
  assert.match(t, /Node "Build": replace its code with:\nnew code here/);
  assert.match(t, /Node "Added" \(new\): set its parameters to:/);
  assert.ok(patchText(before, { nodes: [{ name: 'Build', parameters: { jsCode: 'x'.repeat(5000) } }] }, ['Build'], { limit: 100 }).length < 400);
});
