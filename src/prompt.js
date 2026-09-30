/**
 * What Claude Code is told, and what it is given to read.
 *
 * Two halves. `context()` pulls the failed node's configuration and its input
 * and output out of the execution, so the model is not asked to hunt through a
 * whole run. `prompt()` states the job, the rules it may not break, and the JSON
 * it must end with.
 *
 * The rules are in the prompt *and* enforced afterwards. A prompt is guidance;
 * `repair.js` is the guard. A repair is only ever recorded as repaired where
 * the workflow's version actually moved and the retried execution actually
 * passed — whatever the model says about itself.
 */

import { GET_SCRIPT, PUT_SCRIPT } from './scripts.js';

const MAX_INLINE = 6000;

export function clip(value, max = MAX_INLINE) {
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n… [truncated, the whole thing is in the files named below]` : s;
}

/** The nodes that feed a given node, read from the workflow's connections. */
export function upstreamOf(wf, nodeName) {
  const connections = wf?.connections;
  if (!connections || typeof connections !== 'object') return [];
  const feeders = [];
  for (const [from, outputs] of Object.entries(connections)) {
    if (!outputs || typeof outputs !== 'object') continue;
    for (const branches of Object.values(outputs)) {
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!Array.isArray(branch)) continue;
        if (branch.some((c) => c && c.node === nodeName) && !feeders.includes(from)) feeders.push(from);
      }
    }
  }
  return feeders;
}

/** The items a run-data entry produced, flattened out of n8n's nested shape. */
function itemsOf(runEntry) {
  const main = runEntry?.data?.main;
  if (!Array.isArray(main)) return [];
  return main.flatMap((branch) => (Array.isArray(branch) ? branch.map((i) => (i && typeof i === 'object' && 'json' in i ? i.json : i)) : []));
}

/**
 * The failed node, its configuration, what reached it and what it produced.
 *
 * `failedNode` is what the caller said failed; where the execution disagrees —
 * it records its own `lastNodeExecuted` — the execution wins, because that is
 * the node n8n actually stopped on.
 */
export function context({ workflow, execution, failedNodeName }) {
  const resultData = execution?.data?.resultData ?? {};
  const runData = resultData.runData ?? {};
  const nodeName = resultData.lastNodeExecuted || failedNodeName || null;

  const node = Array.isArray(workflow?.nodes) ? workflow.nodes.find((n) => n?.name === nodeName) ?? null : null;
  const runs = Array.isArray(runData[nodeName]) ? runData[nodeName] : [];
  const lastRun = runs[runs.length - 1] ?? null;

  const feeders = nodeName ? upstreamOf(workflow, nodeName) : [];
  const input = {};
  for (const feeder of feeders) {
    const feederRuns = Array.isArray(runData[feeder]) ? runData[feeder] : [];
    const last = feederRuns[feederRuns.length - 1];
    if (last) input[feeder] = itemsOf(last).slice(0, 5);
  }

  return {
    nodeName,
    node,
    nodeError: lastRun?.error ?? resultData.error ?? null,
    output: lastRun ? itemsOf(lastRun).slice(0, 5) : [],
    input,
    upstream: feeders,
    executionStatus: execution?.status ?? null,
  };
}

/** The workflow as it stands, kept whole so a revert has something to restore from. */
export function snapshotOf(workflow) {
  if (!workflow || !Array.isArray(workflow.nodes) || !workflow.connections) return null;
  return {
    id: workflow.id ?? null,
    name: workflow.name ?? null,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings ?? undefined,
    versionId: workflow.versionId ?? null,
  };
}

/**
 * The repair prompt.
 *
 * `dryRun` changes the job rather than dressing it up: in a dry run the model is
 * told it may not run the write script at all, and the outcome it is asked for
 * is the diagnosis alone.
 *
 * The n8n API key is never in this text, and neither is a URL to call: every
 * read and write goes through the two scripts in the working directory. That is
 * the whole point of them — see `scripts.js`.
 */
/**
 * Every node before the failed one, nearest first, with its type, its code or
 * parameters and the first item it produced (30 Sep 2026). The failed node is
 * often only where a fault surfaced: Builder Chasers failed in an Assert node
 * and its cause was two nodes earlier, in the node that built the message.
 */
export function pathToFailure({ workflow, execution, nodeName, max = 8 }) {
  if (!nodeName) return [];
  const runData = execution?.data?.resultData?.runData ?? {};
  const byName = new Map((workflow?.nodes ?? []).map((n) => [n.name, n]));
  const seen = new Set([nodeName]);
  const out = [];
  let frontier = [nodeName];
  while (frontier.length && out.length < max) {
    const next = [];
    for (const name of frontier) {
      for (const feeder of upstreamOf(workflow, name)) {
        if (seen.has(feeder)) continue;
        seen.add(feeder);
        next.push(feeder);
        const node = byName.get(feeder);
        const runs = Array.isArray(runData[feeder]) ? runData[feeder] : [];
        const last = runs[runs.length - 1];
        const code = node?.parameters?.jsCode;
        out.push({
          name: feeder,
          type: node?.type ?? '(not in the workflow)',
          ran: Boolean(last),
          config: typeof code === 'string' ? code : node?.parameters ?? null,
          first_output: last ? itemsOf(last).slice(0, 1) : [],
        });
        if (out.length >= max) break;
      }
      if (out.length >= max) break;
    }
    frontier = next;
  }
  return out;
}

function pathText(path) {
  if (!path.length) return '  (no nodes before it)';
  return path
    .map((n) => `  - "${n.name}" (${n.type})${n.ran ? '' : ' did NOT run in this execution'}
    config: ${clip(n.config, 1500).replace(/\n/g, '\n    ')}
    first item it produced: ${clip(n.first_output, 800).replace(/\n/g, '\n    ')}`)
    .join('\n');
}

export function prompt({ repairId, request, workflow, ctx, files, dryRun, caller = null, recovered = null, path = [], history = '  (not read)', crash = null, prepare = null }) {
  const error = request?.error ?? {};
  const wf = request?.workflow ?? {};
  const exec = request?.execution ?? {};

  const prepareRules = prepare
    ? `THIS IS A PROTECTED, AGENT-FACING WORKFLOW. NOTHING YOU DO GOES LIVE.
  You reach n8n through its MCP tools (mcp__n8n__*). Edits there save a DRAFT;
  nothing is live until a person presses Apply. You have no publish tool.

  ${prepare.workflowEditable ? `You MAY edit workflow ${prepare.workflowId} (and no other) with update_workflow.` : `Do NOT edit workflow ${prepare.workflowId}: it already holds someone else's unpublished draft.`}
  ${prepare.agent ? (prepare.agent.editable ? `You MAY instead edit the ${prepare.agent.name} agent (${prepare.agent.id}) with get_agent / mutate_agent / validate_agent, if the fault is in the agent's own settings (instructions, a skill, a tool definition).` : `Do NOT edit the ${prepare.agent.name} agent: it already holds unpublished changes.`) : 'There is no agent behind this workflow.'}
  Change ONE of the two, never both.

  After a workflow edit you MUST test it: prepare_workflow_pin_data, then
  test_workflow with the trigger pinned to what the failed execution received
  (read it from execution.json). Read the test's node outputs with
  get_workflow_execution; a green status alone proves nothing. Put every test
  execution id in "test_execution_ids". If the test does not pass, fix the draft
  and test again. The bridge re-reads every one of them itself.
  After an agent edit, run validate_agent.

  Report "needs_human" in all cases: a person applies the draft. If you could not
  find the root cause, change nothing.`
    : null;

  const writeRules = prepareRules ? prepareRules : dryRun
    ? `THIS IS A DRY RUN. You must NOT change anything in n8n.

  You may run ./${GET_SCRIPT} to read the workflow.
  Do NOT run ./${PUT_SCRIPT} at all, and do not change anything by any other means.

  Diagnose the failure and describe the smallest fix you WOULD have made. Report
  the outcome as "not_repaired" and put the proposed change in change_summary.`
    : `HOW TO REACH n8n
Two scripts in your working directory are the ONLY way to reach it:

  ./${GET_SCRIPT}                 prints this workflow as JSON
  ./${PUT_SCRIPT} <file.json>     sends it back; prints "HTTP <status>" and n8n's answer

  Do NOT write your own curl, and do not use an API key yourself. The scripts
  hold the URL, the workflow id and the authentication and send it themselves —
  a hand-written call is how the last repair failed with a 401 on a key that
  works. There is no other n8n endpoint for you to call.

  The PUT sends only name, nodes, connections and settings, because n8n rejects
  a body carrying anything else — so save the WHOLE workflow with your fix
  applied to a file and pass that file. The script drops the rest for you.

  After a write, run ./${GET_SCRIPT} again and read back what landed.

  If the PUT prints a status outside 2xx, the write did NOT happen: the workflow
  is unchanged. Say so in human_action, quoting the status and the body it
  printed, and report "needs_human" rather than "repaired".`;

  /**
   * Who sent this input (26 Sep 2026). An agent's tool call carries whatever
   * the agent chose to send, so an empty or malformed call is the agent's
   * mistake unless the workflow invited it — as Post Loop Digest's trigger did,
   * by declaring no inputs at all.
   */
  const callerNote = caller?.called
    ? `\nWHO CALLED IT
  This execution was not started by its own trigger: it was called by ${caller.agentRunId ? `an agent (agent run ${caller.agentRunId})` : caller.parentExecutionId ? `another workflow (execution ${caller.parentExecutionId})` : 'an agent or another workflow (mode "integrated")'}.
  Its input is whatever that caller sent, once.${
    recovered
      ? `\n  The caller recovered on its own: it called this workflow again ${recovered.after_seconds}s later in the same run, and that call succeeded (execution ${recovered.execution_id}).`
      : ''
  }
  Look for a real defect in THIS workflow that let a bad call through or made a
  good call fail — an input it never declares, a field read under the wrong name.
  If the only problem is the input one call happened to carry, change nothing and
  report "not_repaired" with the root cause.
  Your fix will not be checked by retrying this execution (that only replays the
  same input); it is checked against the next real calls after you save.\n`
    : '';

  return `You are repairing one failed n8n workflow for Bays Horizon Advisory. Repair id ${repairId}.

Work on your own to the end: nobody is watching this run and there is nobody to ask.

THE FAILURE
  Workflow:       ${wf.name ?? '(unnamed)'} (id ${wf.id ?? '?'})
  Execution:      ${exec.id ?? '?'}${exec.lastNodeExecuted ? ` — stopped on "${exec.lastNodeExecuted}"` : ''}
  Failed node:    ${ctx.nodeName ?? error.failed_node ?? '(unknown)'}
  Error class:    ${error.class ?? '(unknown)'}
  Severity:       ${error.severity ?? '(unknown)'}${error.subsystem ? `\n  Subsystem:      ${error.subsystem}` : ''}
  Error message:  ${clip(error.message ?? '(none given)', 2000)}
${callerNote}${crash ? `
THIS EXECUTION CRASHED
  n8n killed this run (a crash or out of memory), and this workflow has crashed
  twice in 24 hours. Do not look for a logic bug. Work out where the memory goes
  and propose the smallest change that reduces it: process in batches (Split in
  Batches / Loop Over Items), keep only the fields later nodes use, page a large
  read, or stop carrying binary data. Nothing will be written: report
  "needs_human" and put the exact proposed change in change_summary.
  Data each node produced, largest first:
${crash.map((n) => `    ${n.node}: ${n.items} items, ${n.bytes} bytes`).join('\n') || '    (no run data was kept)'}
` : ''}
THE FAILED NODE, AS IT IS CONFIGURED
${clip(ctx.node ?? '(the node named above is not in the workflow — that may itself be the problem)')}

WHAT n8n RECORDED WHEN IT FAILED
${clip(ctx.nodeError ?? '(no node-level error recorded)', 3000)}

WHAT REACHED THE NODE (from ${ctx.upstream.length ? ctx.upstream.join(', ') : 'no upstream node'})
${clip(ctx.input, 3000)}

WHAT THE NODE PRODUCED
${clip(ctx.output, 2000)}

THE PATH THAT LED HERE (nodes before the failed one, nearest first)
${pathText(path)}

EARLIER REPAIRS OF THIS WORKFLOW (newest first)
${history}

IN YOUR WORKING DIRECTORY
${files.map((f) => `  ${f}`).join('\n')}
The JSON files hold the whole of what was cut short above. The two .sh scripts
are how you read and write the workflow — see below.

THE JOB
0. Read repair-patterns.md first. Every line in it came from a real failure here.
1. Find the root cause. Read the JSON files; the execution data is all there.
   The node that failed is often only where the fault surfaced. If it only
   checks or reports (an "Assert ..." node, a check that throws), follow the
   path above upstream to the node that produced the bad data, and fix THAT.
2. Make the SMALLEST fix that addresses that root cause. One node's parameters,
   an expression, a wrong field name — that size of change.
3. Read the earlier repairs above. Never repeat a change that was put back:
   it already failed once. If your diagnosis matches an earlier one whose fix
   did not hold, find what that fix missed.

${writeRules}

RULES YOU MAY NOT BREAK
  - Never rename a node and never delete one. n8n's connections are keyed on node
    names and the rest of the engine reads them; a rename breaks the workflow silently.
  - Never touch credentials. Not the credential a node uses, not its id, not its name.
    If the cause is a credential, that is a person's job: say so in human_action.
  - Never activate, deactivate or archive a workflow. Whether a workflow is
    running is not part of any repair, and the bridge checks the active state
    before and after this run: if it changed, it is put back and the report says
    so. There is no case where switching it off is the fix.
  - Never change a workflow other than ${wf.id ?? 'the one named above'} — the scripts
    reach only that one, and there is no way around them worth looking for.
  - Do not fix a symptom you cannot explain. If you cannot find the root cause, say so
    and report "needs_human" — a guess written into a live workflow is worse than a
    failure somebody can see.

HOW TO END
Your last output must be one JSON object and nothing after it:

{
  "outcome": "repaired" | "not_repaired" | "needs_human",
  "root_cause": "what actually went wrong, in a sentence or two",
  "change_summary": "exactly what you changed, or what you would change",
  "nodes_changed": ["node name", ...],
  "human_action": "what a person should do, or an empty string if nothing"${prepare ? ',\n  "test_execution_ids": ["the id of every test_workflow execution you ran"]' : ''}
}

"repaired" means you changed the workflow and believe the failure is fixed. It is
checked afterwards: this service re-reads the workflow and then proves the fix —
by retrying the failed execution, or, for a workflow another caller invoked, by
the next real runs after your save. Only a real version change plus that proof is
recorded as a repair. Claiming more than you did gains nothing and costs the record.

human_action is for what the evidence cannot settle. Do not ask a person to
confirm that the fix works, or that a caller sends the right fields: the runs
after your save will show that.`;
}
