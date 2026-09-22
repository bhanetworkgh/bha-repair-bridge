/**
 * The failures this bridge will not send to Claude Code.
 *
 * Two kinds, and they are refused for different reasons.
 *
 * **The six workflows** are the machinery that decides when workflows get
 * repaired — the three error handlers, the healer that calls this service, the
 * retry workflow and the reporter. A machine editing those is a machine editing
 * its own supervisor.
 *
 * **Crashes and out-of-memory failures** are refused because they are not
 * workflow faults (22 Sep 2026, after the 08:00 incident). A workflow that ran
 * out of memory or whose execution crashed did not do anything wrong that a
 * code change can fix: the instance did. Sending one to Claude Code means
 * spending ten minutes and a model run looking for a bug in a workflow that has
 * none — and, worse, inviting an edit to a workflow that was working.
 *
 * Both are `skipped`, and both are reported like any other outcome. A skip is a
 * result, not a silence.
 */

/** The workflows this bridge will not touch, by name. */
export const REFUSED_WORKFLOWS = [
  'Bays — Error Handler',
  'North Star — Error Handler',
  'Research Twin — Error Handler',
  'BHA — Self Healer',
  'Engine — Self-Healing Retry',
  'BHA — Self Healer Reports',
];

/** Dashes differ between what n8n stores and what a payload carries, so compare on a flattened name. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[‐-―−-]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const REFUSED_SET = new Set(REFUSED_WORKFLOWS.map(normalizeName));

export function isRefusedWorkflow(name) {
  return REFUSED_SET.has(normalizeName(name));
}

/** The phrase both halves of the report use, so the reason reads the same everywhere. */
export const INFRASTRUCTURE = 'infrastructure, not a workflow fault';

/**
 * What n8n says when the instance, rather than the workflow, was the problem.
 *
 * `WorkflowCrashedError` and "possible out-of-memory" are n8n's own words for
 * an execution the instance killed. A status of `crashed` is the same thing
 * said by the execution record.
 */
const INFRASTRUCTURE_PATTERNS = [/possible out-of-memory/i, /WorkflowCrashedError/i, /out of memory/i, /JavaScript heap out of memory/i, /ERR_WORKER_OUT_OF_MEMORY/i];

/** Every string on a request that might carry n8n's words, gathered in one place. */
function textOf(request) {
  const e = request?.error ?? {};
  const i = request?.incident ?? {};
  return [e.message, e.class, e.failed_node, i.summary, request?.execution?.status]
    .filter((v) => typeof v === 'string')
    .join('\n');
}

/**
 * Whether this failure is the instance's rather than the workflow's.
 *
 * Takes the request and, where it has been read, the execution — the request is
 * what is known before anything is fetched, and the execution's own status is
 * the more reliable of the two. Either is enough.
 */
export function infrastructureFailure({ request, execution } = {}) {
  const status = String(execution?.status ?? request?.execution?.status ?? '').toLowerCase();
  if (status === 'crashed') {
    return {
      refused: true,
      reason: `The execution's status is "crashed" — ${INFRASTRUCTURE}. n8n killed this run; the workflow did not fail on anything a code change can fix.`,
      matched: 'status: crashed',
    };
  }

  const haystack = [textOf(request), JSON.stringify(execution?.data?.resultData?.error ?? '')].join('\n');
  for (const pattern of INFRASTRUCTURE_PATTERNS) {
    const hit = haystack.match(pattern);
    if (hit) {
      return {
        refused: true,
        reason: `The failure names ${hit[0]} — ${INFRASTRUCTURE}. The instance ran out of memory or killed the run; there is no workflow bug here for a repair to find.`,
        matched: hit[0],
      };
    }
  }

  return { refused: false, reason: null, matched: null };
}
