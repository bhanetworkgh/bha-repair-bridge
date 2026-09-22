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
export function prompt({ repairId, request, workflow, ctx, files, dryRun }) {
  const error = request?.error ?? {};
  const wf = request?.workflow ?? {};
  const exec = request?.execution ?? {};

  const writeRules = dryRun
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

  return `You are repairing one failed n8n workflow for Bays Horizon Advisory. Repair id ${repairId}.

Work on your own to the end: nobody is watching this run and there is nobody to ask.

THE FAILURE
  Workflow:       ${wf.name ?? '(unnamed)'} (id ${wf.id ?? '?'})
  Execution:      ${exec.id ?? '?'}${exec.lastNodeExecuted ? ` — stopped on "${exec.lastNodeExecuted}"` : ''}
  Failed node:    ${ctx.nodeName ?? error.failed_node ?? '(unknown)'}
  Error class:    ${error.class ?? '(unknown)'}
  Severity:       ${error.severity ?? '(unknown)'}${error.subsystem ? `\n  Subsystem:      ${error.subsystem}` : ''}
  Error message:  ${clip(error.message ?? '(none given)', 2000)}

THE FAILED NODE, AS IT IS CONFIGURED
${clip(ctx.node ?? '(the node named above is not in the workflow — that may itself be the problem)')}

WHAT n8n RECORDED WHEN IT FAILED
${clip(ctx.nodeError ?? '(no node-level error recorded)', 3000)}

WHAT REACHED THE NODE (from ${ctx.upstream.length ? ctx.upstream.join(', ') : 'no upstream node'})
${clip(ctx.input, 3000)}

WHAT THE NODE PRODUCED
${clip(ctx.output, 2000)}

IN YOUR WORKING DIRECTORY
${files.map((f) => `  ${f}`).join('\n')}
The JSON files hold the whole of what was cut short above. The two .sh scripts
are how you read and write the workflow — see below.

THE JOB
1. Find the root cause. Read the JSON files; the execution data is all there.
2. Make the SMALLEST fix that addresses that root cause. One node's parameters,
   an expression, a wrong field name — that size of change.

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
  "human_action": "what a person should do, or an empty string if nothing"
}

"repaired" means you changed the workflow and believe the failure is fixed. It is
checked afterwards: this service re-reads the workflow and retries the failed
execution, and only a real version change plus a passing retry is recorded as a
repair. Claiming more than you did gains nothing and costs the record.`;
}
