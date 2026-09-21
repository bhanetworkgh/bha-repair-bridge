/**
 * Reporting. Twice, always, whatever happened.
 *
 * Silence is the one forbidden outcome of a repair, so both reports are tried
 * three times each — once, then twice more with backoff — and a report that
 * still will not send is logged at error level with its whole body, so the row
 * can be replayed by hand from the log rather than lost.
 *
 * The two reports are the same body, and the webhook's carries four more fields
 * (incident, lane, alert_permalink, retry_execution_id) because n8n posts it to
 * Slack and closes the ledger incident, and needs the incident to do that.
 */
import { dashboardRepairUrl, env, reportWebhookUrl } from './config.js';
import { errText, log, logError } from './log.js';

const ATTEMPTS = 3;
const BACKOFF_MS = [2000, 4000];

async function post(url, headers, body, { repairId, label }) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (res.ok) {
        log(repairId, `report.${label}.sent`, { status: res.status, attempt });
        return { ok: true, status: res.status, attempts: attempt };
      }
      // A 4xx will not come good on a retry, but it is retried anyway: the cost
      // is two seconds and the alternative is deciding, from here, that the
      // other service meant it.
      logError(repairId, `report.${label}.refused`, { status: res.status, attempt, body: text.slice(0, 500) });
      if (attempt === ATTEMPTS) return { ok: false, status: res.status, attempts: attempt, error: text.slice(0, 500) };
    } catch (e) {
      logError(repairId, `report.${label}.failed`, { attempt, error: errText(e) });
      if (attempt === ATTEMPTS) return { ok: false, status: 0, attempts: attempt, error: errText(e) };
    }
    await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 4000));
  }
  return { ok: false, status: 0, attempts: ATTEMPTS, error: 'unreachable' };
}

/**
 * Sends both reports and returns what happened to each.
 *
 * Neither failure stops the other: they are two independent obligations and a
 * dashboard that is down must not also cost the Slack report.
 */
export async function reportBoth({ repairId, dashboardBody, webhookBody }) {
  const url = dashboardRepairUrl();
  const key = env('DASHBOARD_INBOUND_KEY');
  const hook = reportWebhookUrl();

  const tasks = [];

  if (!url || !key) {
    logError(repairId, 'report.dashboard.unconfigured', {
      missing: [!url ? 'DASHBOARD_URL' : null, !key ? 'DASHBOARD_INBOUND_KEY' : null].filter(Boolean),
      body: dashboardBody,
    });
    tasks.push(Promise.resolve({ ok: false, status: 0, attempts: 0, error: 'DASHBOARD_URL or DASHBOARD_INBOUND_KEY is not set' }));
  } else {
    tasks.push(post(url, { 'x-dashboard-key': key }, dashboardBody, { repairId, label: 'dashboard' }));
  }

  if (!hook) {
    logError(repairId, 'report.webhook.unconfigured', { missing: ['REPORT_WEBHOOK_URL'], body: webhookBody });
    tasks.push(Promise.resolve({ ok: false, status: 0, attempts: 0, error: 'REPORT_WEBHOOK_URL is not set' }));
  } else {
    tasks.push(post(hook, {}, webhookBody, { repairId, label: 'webhook' }));
  }

  const [dashboard, webhook] = await Promise.all(tasks);

  if (!dashboard.ok || !webhook.ok) {
    // The whole body, loudly, once. This is the copy a person replays from.
    logError(repairId, 'report.undelivered', {
      dashboard: dashboard.ok ? 'sent' : dashboard.error,
      webhook: webhook.ok ? 'sent' : webhook.error,
      unsent_body: webhookBody,
    });
  }

  return { dashboard, webhook };
}
