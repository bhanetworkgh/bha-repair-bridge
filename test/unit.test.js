/**
 * The decisions that must not drift: what is refused, what counts as a repair,
 * and how a result is read out of whatever Claude Code printed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideOutcome, extractResult, isRefusedWorkflow, normalizeName, repairIdFor, REFUSED_WORKFLOWS } from '../src/repair.js';
import { readEnvelope } from '../src/claude.js';
import { upstreamOf, context, snapshotOf } from '../src/prompt.js';

test('the repair id is the workflow and the execution', () => {
  assert.equal(repairIdFor({ workflow: { id: 'abc' }, execution: { id: '42' } }), 'REP-abc-42');
});

test('every refused workflow is refused, whichever dash it is written with', () => {
  for (const name of REFUSED_WORKFLOWS) {
    assert.equal(isRefusedWorkflow(name), true, name);
    assert.equal(isRefusedWorkflow(name.replace(/—/g, '-')), true, `${name} with a hyphen`);
    assert.equal(isRefusedWorkflow(name.toUpperCase()), true, `${name} shouted`);
    assert.equal(isRefusedWorkflow(`  ${name}  `), true, `${name} padded`);
  }
});

test('a workflow that is not on the list is not refused', () => {
  assert.equal(isRefusedWorkflow('Bays — Slack Router'), false);
  assert.equal(isRefusedWorkflow('North Star — Digest'), false);
  assert.equal(isRefusedWorkflow(''), false);
  assert.equal(isRefusedWorkflow(undefined), false);
});

test('normalizeName flattens the dashes n8n and a payload disagree about', () => {
  assert.equal(normalizeName('BHA — Self Healer'), normalizeName('BHA - Self Healer'));
  assert.equal(normalizeName('Engine — Self-Healing Retry'), 'engine - self-healing retry');
});

test('repaired needs both a version change and a passing retry', () => {
  const base = { claimed: 'repaired', versionChanged: true, retryRan: true, retryPassed: true, isDryRun: false };
  assert.equal(decideOutcome(base), 'repaired');
  assert.equal(decideOutcome({ ...base, retryPassed: false }), 'not_repaired');
  assert.equal(decideOutcome({ ...base, retryRan: false, retryPassed: false }), 'not_repaired');
  assert.equal(decideOutcome({ ...base, versionChanged: false }), 'needs_human');
});

test('a run with no parseable result is needs_human, never a repair', () => {
  assert.equal(decideOutcome({ claimed: null, versionChanged: true, retryRan: true, retryPassed: true, isDryRun: false }), 'needs_human');
  assert.equal(decideOutcome({ claimed: null, versionChanged: false, retryRan: false, retryPassed: false, isDryRun: false }), 'needs_human');
});

test('a dry run never reports a repair, whatever the model claimed', () => {
  assert.equal(decideOutcome({ claimed: 'repaired', versionChanged: true, retryRan: true, retryPassed: true, isDryRun: true }), 'not_repaired');
});

test('the model’s own not_repaired, needs_human and error are kept', () => {
  assert.equal(decideOutcome({ claimed: 'needs_human', versionChanged: false, isDryRun: false }), 'needs_human');
  assert.equal(decideOutcome({ claimed: 'not_repaired', versionChanged: false, isDryRun: false }), 'not_repaired');
  assert.equal(decideOutcome({ claimed: 'error', versionChanged: true, retryRan: true, retryPassed: true, isDryRun: false }), 'error');
});

test('the result is the last JSON object carrying an outcome', () => {
  const text = `I looked at the node.
Here is a thing that is not the result: {"nodes_changed": ["Fetch"]}
\`\`\`json
{"outcome":"needs_human","root_cause":"first pass","change_summary":"none","nodes_changed":[],"human_action":"look"}
\`\`\`
Actually, on reflection:
{"outcome":"repaired","root_cause":"the field was renamed upstream","change_summary":"pointed the expression at data.items","nodes_changed":["Map fields"],"human_action":""}`;
  const r = extractResult(text);
  assert.equal(r.outcome, 'repaired');
  assert.deepEqual(r.nodes_changed, ['Map fields']);
});

test('braces inside strings do not confuse the reader', () => {
  const r = extractResult('{"outcome":"not_repaired","root_cause":"the expression {{ $json.x }} is wrong","change_summary":"none","nodes_changed":[],"human_action":""}');
  assert.equal(r.outcome, 'not_repaired');
  assert.match(r.root_cause, /\{\{ \$json\.x \}\}/);
});

test('prose with no JSON reads as nothing, not as a guess', () => {
  assert.equal(extractResult('I fixed it, honestly.'), null);
  assert.equal(extractResult(''), null);
  assert.equal(extractResult('{"nodes_changed":[]}'), null);
});

test('the CLI envelope is read, and raw text still works', () => {
  const env = readEnvelope(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK', modelUsage: { 'claude-sonnet-4': {} } }));
  assert.equal(env.text, 'OK');
  assert.equal(env.model, 'claude-sonnet-4');
  assert.equal(env.error, null);

  const plain = readEnvelope('just text');
  assert.equal(plain.text, 'just text');
  assert.equal(plain.model, null);
});

test('an envelope that reports an error says so', () => {
  const env = readEnvelope(JSON.stringify({ type: 'result', subtype: 'error_during_execution', result: '', is_error: true, error: 'credit balance too low' }));
  assert.equal(env.error, 'credit balance too low');
});

const workflow = {
  id: 'wf1',
  name: 'Bays — Slack Router',
  versionId: 'v1',
  nodes: [
    { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
    { name: 'Map fields', type: 'n8n-nodes-base.set', parameters: { values: { string: [{ name: 'x', value: '={{ $json.missing }}' }] } } },
  ],
  connections: { Webhook: { main: [[{ node: 'Map fields', type: 'main', index: 0 }]] } },
};

test('the nodes feeding a node are read from the connections', () => {
  assert.deepEqual(upstreamOf(workflow, 'Map fields'), ['Webhook']);
  assert.deepEqual(upstreamOf(workflow, 'Webhook'), []);
});

test('the context is the failed node, its config, what reached it and what it produced', () => {
  const execution = {
    id: '99',
    status: 'error',
    data: {
      resultData: {
        lastNodeExecuted: 'Map fields',
        runData: {
          Webhook: [{ data: { main: [[{ json: { body: { id: 7 } } }]] } }],
          'Map fields': [{ error: { message: 'Cannot read properties of undefined' }, data: { main: [[]] } }],
        },
      },
    },
  };
  const ctx = context({ workflow, execution, failedNodeName: 'something else' });
  assert.equal(ctx.nodeName, 'Map fields', 'the execution wins over what the caller said failed');
  assert.equal(ctx.node.type, 'n8n-nodes-base.set');
  assert.match(ctx.nodeError.message, /Cannot read properties/);
  assert.deepEqual(ctx.input, { Webhook: [{ body: { id: 7 } }] });
});

test('the snapshot carries the nodes and connections a revert restores from', () => {
  const s = snapshotOf(workflow);
  assert.equal(s.nodes.length, 2);
  assert.ok(s.connections.Webhook);
  assert.equal(snapshotOf({ id: 'x' }), null);
});
