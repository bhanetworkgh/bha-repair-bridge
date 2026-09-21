/**
 * Everything this service reads from the environment, in one place.
 *
 * Read through functions rather than captured at import time, so a test can set
 * a variable and so `/health` reports what is set *now* rather than what was set
 * the moment the process booted.
 *
 * Nothing here throws on a missing variable. The service must boot and answer
 * `/health` before its secrets exist — that is how anybody finds out which ones
 * are still missing.
 */

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * The variables without which a repair cannot run end to end.
 *
 * `ANTHROPIC_API_KEY` is deliberately not here: it is set to the empty string on
 * purpose so Claude Code uses `ANTHROPIC_AUTH_TOKEN` against OpenRouter instead.
 * `SLACK_REPORT_CHANNEL` is not here either — it is only a fallback for a
 * request that did not name its own `report_channel`.
 */
export const REQUIRED_ENV = [
  'BRIDGE_KEY',
  'N8N_BASE_URL',
  'N8N_API_KEY',
  'DASHBOARD_URL',
  'DASHBOARD_INBOUND_KEY',
  'REPORT_WEBHOOK_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];

export function env(name) {
  return trim(process.env[name]) || null;
}

/** The required variables that are not set, by name. Empty is the healthy answer. */
export function envMissing() {
  return REQUIRED_ENV.filter((name) => !env(name));
}

export function port() {
  return Number(process.env.PORT) || 10000;
}

/** Anything other than an explicit truthy value is false: a repair writes by default. */
export function dryRun() {
  return /^(1|true|yes|on)$/i.test(trim(process.env.DRY_RUN));
}

/** The n8n instance, without the API path — where a workflow link points. */
export function n8nHost() {
  const base = env('N8N_BASE_URL');
  return base ? base.replace(/\/+$/, '') : null;
}

/** The n8n REST base. Derived from N8N_BASE_URL so one host is configured once. */
export function n8nApiBase() {
  const host = n8nHost();
  return host ? `${host}/api/v1` : null;
}

/** Where the dashboard takes a repair result. */
export function dashboardRepairUrl() {
  const base = env('DASHBOARD_URL');
  return base ? `${base.replace(/\/+$/, '')}/api/engine/repair` : null;
}

export function reportWebhookUrl() {
  return env('REPORT_WEBHOOK_URL');
}

/** Claude Code's hard stop. Ten minutes, per the brief; tunable for a test. */
export function repairTimeoutMs() {
  return Number(process.env.REPAIR_TIMEOUT_MS) || 10 * 60 * 1000;
}

/** The deep health check's own timeout. One minute, per the brief. */
export function deepHealthTimeoutMs() {
  return Number(process.env.DEEP_HEALTH_TIMEOUT_MS) || 60 * 1000;
}

/** How long to wait for a retried execution to reach a final status. */
export function retryWaitMs() {
  return Number(process.env.RETRY_WAIT_MS) || 5 * 60 * 1000;
}

/** How long any one call to n8n may take. */
export function n8nTimeoutMs() {
  return Number(process.env.N8N_TIMEOUT_MS) || 30 * 1000;
}

/** The model to run Claude Code on, where one is pinned. Null means the CLI's own default. */
export function claudeModel() {
  return env('CLAUDE_MODEL');
}
