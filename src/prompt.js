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
 * told it may not write to n8n at all, and the outcome it is asked for is the
 * diagnosis alone.
 */
export function prompt({ repairId, request, workflow, ctx, files, dryRun, n8nApiBase }) {
  const error = request?.error ?? {};
  const wf = request?.workflow ?? {};
  const exec = request?.execution ?? {};

  const writeRules = dryRun
    ? `THIS IS A DRY RUN. You must NOT change anything in n8n. Do not POST, PUT, PATCH or
DELETE anything — GET only. Diagnose the failure and describe the smallest fix you
WOULD have made. Report the outcome as "not_repaired" and put the proposed change in
change_summary.`
    : `You may change this one workflow, through the n8n API, and only as far as the fix needs:

  GET  ${n8nApiBase}/workflows/${wf.id}      (read it back before you write)
  PUT  ${n8nApiBase}/workflows/${wf.id}      (the whole workflow; n8n has no partial update)

  curl is available. The key is in the environment as $N8N_API_KEY and the header is
  X-N8N-API-KEY. Never print the key.

  A PUT replaces the workflow, so send back everything you read — name, nodes,
  connections, settings — with only your fix changed. Do NOT send "active": changing
  whether a live workflow runs is a second change nobody asked for.`;

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

FILES IN YOUR WORKING DIRECTORY (the whole thing, where the above was cut short)
${files.map((f) => `  ${f}`).join('\n')}

THE JOB
1. Find the root cause. Read the files; the execution data is all there.
2. Make the SMALLEST fix that addresses that root cause. One node's parameters,
   an expression, a wrong field name — that size of change.

${writeRules}

RULES YOU MAY NOT BREAK
  - Never rename a node and never delete one. n8n's connections are keyed on node
    names and the rest of the engine reads them; a rename breaks the workflow silently.
  - Never touch credentials. Not the credential a node uses, not its id, not its name.
    If the cause is a credential, that is a person's job: say so in human_action.
  - Never activate or deactivate a workflow.
  - Never change a workflow other than ${wf.id ?? 'the one named above'}.
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
  "human_action": "what a person should do, or \\"\\" if nothing"
}

"repaired" means you changed the workflow and believe the failure is fixed. It is
checked afterwards: this service re-reads the workflow and retries the failed
execution, and only a real version change plus a passing retry is recorded as a
repair. Claiming more than you did gains nothing and costs the record.`;
}
