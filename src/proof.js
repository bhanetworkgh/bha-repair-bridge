/**
 * What a retry can and cannot prove (30 Sep 2026).
 *
 * n8n's retry replays from the node that failed, using the stored output of every
 * node before it. So a fix made to a node *upstream* of the failure is never run
 * by the retry: the failed node is handed the same stale input it failed on, fails
 * the same way, and a correct repair is recorded `not_repaired` and put back.
 * That is what happened to Builder Chasers: the fix was in "Build Chaser Cards",
 * the failure was in "Assert Chaser Delivered" two nodes later, and every retry
 * replayed the old Slack refusal.
 *
 * A retry is honest proof only when everything the repair changed is the failed
 * node itself or something after it. Otherwise the proof has to be a later real
 * run, which is the path agent-called workflows already use.
 */

const stable = (v) => JSON.stringify(v ?? null);

/** Names of nodes whose definition differs between two versions of a workflow, plus added and removed ones. */
export function changedNodeNames(before, after) {
  const a = new Map((before?.nodes ?? []).map((n) => [n.name, n]));
  const b = new Map((after?.nodes ?? []).map((n) => [n.name, n]));
  const names = new Set();
  for (const [name, node] of b) {
    const old = a.get(name);
    if (!old) names.add(name);
    else if (stable(old.parameters) !== stable(node.parameters) || old.type !== node.type || old.typeVersion !== node.typeVersion || Boolean(old.disabled) !== Boolean(node.disabled) || stable(old.credentials) !== stable(node.credentials) || stable(old.onError) !== stable(node.onError)) names.add(name);
  }
  for (const name of a.keys()) if (!b.has(name)) names.add(name);
  return [...names];
}

/** The failed node and everything reachable from it along the connections. */
export function downstreamOf(connections, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const outputs of Object.values(connections?.[cur] ?? {})) {
      for (const branch of outputs ?? []) {
        for (const link of branch ?? []) {
          if (link?.node && !seen.has(link.node)) {
            seen.add(link.node);
            stack.push(link.node);
          }
        }
      }
    }
  }
  return seen;
}

/**
 * Whether retrying the failed execution would actually run what the repair changed.
 * Returns `{ ok, upstream }`: `upstream` lists changed nodes the retry would skip.
 * With no failed node named, or nothing changed, the answer is "cannot tell" and the
 * retry is not trusted to prove anything on its own.
 */
export function retryCanProve({ failedNode, before, after }) {
  const changed = changedNodeNames(before, after);
  if (!failedNode || changed.length === 0) return { ok: false, upstream: changed, changed };
  const reach = downstreamOf(after?.connections ?? before?.connections, failedNode);
  const upstream = changed.filter((n) => !reach.has(n));
  return { ok: upstream.length === 0, upstream, changed };
}

/**
 * A node that exists only to fail. BHA's convention is a node named "Raise ..." (a Code node
 * that throws, or n8n's Stop and Error) whose failure IS the alarm: the error handler turns it
 * into an incident so a person sees it. "Bays — Submit Actions / Raise Refused Click" is one:
 * somebody clicked a review button only Jason and Destiny may use, the workflow changed
 * nothing and raised on purpose. There is no defect for a repair to find, and an edit would
 * only weaken the alarm. Assert nodes are NOT alarms of this kind: they report an upstream
 * fault, and that fault is exactly what a repair should chase.
 */
export function isDeliberateAlarm(workflow, failedNode) {
  if (!/^raise\b/i.test(String(failedNode ?? '').trim())) return false;
  const node = (workflow?.nodes ?? []).find((n) => n.name === failedNode);
  return Boolean(node && (node.type === 'n8n-nodes-base.stopAndError' || node.type === 'n8n-nodes-base.code'));
}
