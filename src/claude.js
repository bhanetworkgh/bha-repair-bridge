/**
 * Running Claude Code headless.
 *
 * The CLI is a dependency of this package *and* installed globally by the
 * Render build, deliberately: `node_modules/.bin/claude` is what this module
 * runs when it is there, and `claude` on PATH is the fallback. Either way the
 * service works whether or not the global install survived the image.
 *
 * The prompt goes in on stdin rather than as an argument: a repair prompt
 * carries a whole node's configuration and there is no argument length to be
 * surprised by on stdin.
 *
 * The child is given a **deliberately small environment** — the model
 * credentials and the n8n credentials, nothing else. It is told to use curl
 * against the n8n API, so it needs those two and no more; BRIDGE_KEY,
 * DASHBOARD_INBOUND_KEY and the report webhook never reach it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeModel, env } from './config.js';

/**
 * The model a run asks OpenRouter for.
 *
 * Pinned, because the CLI's own default resolved to `claude-sonnet-4-20250514`
 * on this account — a Sonnet from May 2025 doing repairs in September 2026.
 * `ANTHROPIC_MODEL` on the service overrides this without a release, and
 * `GET /health?deep=1` reports the model that actually served the request, so a
 * name OpenRouter does not know shows up there rather than inside a repair.
 */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export function model() {
  return env('ANTHROPIC_MODEL') || DEFAULT_MODEL;
}

/** Where the CLI is: an override, then this package's own copy, then PATH. */
export function claudeBin() {
  const override = env('CLAUDE_BIN');
  if (override) return override;
  const local = fileURLToPath(new URL('../node_modules/.bin/claude', import.meta.url));
  return existsSync(local) ? local : 'claude';
}

/** The environment the child gets, and nothing beyond it. */
function childEnv(extra = {}) {
  const base = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    // OpenRouter, through Claude Code's own Anthropic-compatible settings. No
    // proxy, and no cached first-party login in the container.
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? '',
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
    ANTHROPIC_MODEL: model(),
    // Keep the CLI quiet and non-interactive.
    CI: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  };
  if (process.env.NO_PROXY) base.NO_PROXY = process.env.NO_PROXY;
  if (process.env.HTTPS_PROXY) base.HTTPS_PROXY = process.env.HTTPS_PROXY;
  if (process.env.HTTP_PROXY) base.HTTP_PROXY = process.env.HTTP_PROXY;
  return base;
}

/**
 * One headless run.
 *
 * Never throws for a failed run: it returns what happened, because every path
 * out of a repair has to end in a report and an exception three frames down is
 * how a run ends in silence instead.
 */
/**
 * The permission mode a repair runs under.
 *
 * `acceptEdits` rather than `bypassPermissions`, deliberately: the CLI refuses
 * `bypassPermissions` outright when the process is root — "cannot be used with
 * root/sudo privileges" — and a container that runs as root would fail every
 * repair in the first second with an error about a flag. The tools a repair
 * needs are granted by name through `--allowedTools` instead, which is the
 * narrower grant anyway. `CLAUDE_PERMISSION_MODE` overrides it where the
 * service runs as somebody else, and a run refused for root falls back to
 * `acceptEdits` on its own.
 */
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

const ROOT_REFUSAL = /root\/sudo privileges/i;

/**
 * OpenRouter refusing for want of credit (27 Oct 2026), the way it reached this
 * service on 26 Oct: "API Error: 402 ... billing_error ... can only afford
 * 18201". Bays, North Star, Research Twin and the eval runner already fall back
 * to Anthropic on this; the bridge had no backup, so it could not repair at all
 * while OpenRouter was dry (LOOP-1793025371486-STVC).
 */
export const CREDIT_REFUSAL = /(\b402\b|billing_error|payment required|can only afford|insufficient (credits|balance|funds)|exceed your available credits|credit balance is too low|requires more credits)/i;

/** Whether the Anthropic backup is set on this service. Without it a credit refusal is reported as before. */
export function backupConfigured() {
  return Boolean(env('ANTHROPIC_BACKUP_API_KEY'));
}

/**
 * The model the backup asks Anthropic for. Anthropic's own names have no
 * provider prefix and use dashes, so an OpenRouter-style pin such as
 * `anthropic/claude-sonnet-4.5` is turned into `claude-sonnet-4-5`.
 * `ANTHROPIC_BACKUP_MODEL` overrides it.
 */
export function backupModel() {
  const set = env('ANTHROPIC_BACKUP_MODEL');
  if (set) return set;
  return model().replace(/^anthropic\//, '').replace(/\./g, '-');
}

/** The environment that sends the CLI straight to Anthropic on the backup key. */
function backupEnv() {
  return {
    ANTHROPIC_BASE_URL: env('ANTHROPIC_BACKUP_BASE_URL') || 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_API_KEY: env('ANTHROPIC_BACKUP_API_KEY') ?? '',
  };
}

/** One run on the backup, with the caller's own environment kept (the n8n scripts need it). */
export function runOnBackup(options) {
  return spawnClaude({ ...options, extraEnv: { ...(options.extraEnv ?? {}), ...backupEnv() }, modelOverride: backupModel(), modelArg: env('CLAUDE_MODEL') ? backupModel() : null });
}

/**
 * An answer that means the model name itself was refused — a 404 or
 * not_found_error from OpenRouter naming the model, rather than anything the
 * run did.
 */
const UNKNOWN_MODEL = /(not_found_error|404).*model|model.*(not found|not_found_error|is not a valid|unknown)/i;

/**
 * One headless run, with one retry: a CLI that refused the permission mode
 * because the process is root is re-run under the mode it will accept, rather
 * than reported as a repair that could not start.
 */
export async function runClaude(options) {
  const first = await spawnClaude(options);
  // An envelope can report ok with an error inside it; a credit refusal there still falls back below.
  if (first.ok && !(first.error && CREDIT_REFUSAL.test(`${first.error} ${first.text ?? ''}`))) return { ...first, provider: 'openrouter' };

  const said = `${first.error ?? ''} ${first.stderr ?? ''}`;

  const mode = env('CLAUDE_PERMISSION_MODE') || DEFAULT_PERMISSION_MODE;
  if (options.tools && mode !== DEFAULT_PERMISSION_MODE && ROOT_REFUSAL.test(said)) {
    options.onLog?.(`the CLI refused --permission-mode ${mode} for running as root; retrying under ${DEFAULT_PERMISSION_MODE}`);
    const second = await spawnClaude({ ...options, permissionMode: DEFAULT_PERMISSION_MODE });
    return { ...second, ms: second.ms + first.ms };
  }

  /**
   * A pinned model the provider does not know, retried once on the CLI's own
   * default — but only where the run produced nothing at all, which is what a
   * refusal at the first API call looks like. A run that had already started
   * doing things is never re-run: it may have written to n8n, and doing that
   * twice is worse than reporting one failure.
   */
  if (!first.text && UNKNOWN_MODEL.test(said)) {
    options.onLog?.(`the provider does not know the model ${model()}; retrying on the CLI's own default`);
    const second = await spawnClaude({ ...options, modelOverride: '' });
    return { ...second, ms: second.ms + first.ms, modelFallback: true };
  }

  /**
   * OpenRouter out of credit, retried once on the Anthropic backup (27 Oct
   * 2026). Never a run that may already have changed something: a run with
   * tools is re-run only when the caller's `canRetry` says nothing was written
   * (the repair reads n8n's own call log for that), and without a `canRetry`
   * only when the first run produced no output at all, as above. A refusal the
   * backup cannot take is reported exactly as before, with the reason named.
   */
  const refusal = `${first.error ?? ''} ${first.stderr ?? ''} ${first.text ?? ''}`;
  if ((!first.ok || first.error) && CREDIT_REFUSAL.test(refusal)) {
    if (!backupConfigured()) {
      options.onLog?.('OpenRouter refused for credit and no Anthropic backup is set on this service (ANTHROPIC_BACKUP_API_KEY), so the run is reported as it failed');
      return { ...first, provider: 'openrouter', backupSkipped: 'not_configured' };
    }
    const safe = !options.tools ? true : options.canRetry ? await options.canRetry(first) : !first.text;
    if (!safe) {
      options.onLog?.('OpenRouter refused for credit after the run had already written to n8n, so it is not re-run on the backup: a second run could write twice');
      return { ...first, provider: 'openrouter', backupSkipped: 'already_wrote' };
    }
    options.onLog?.(`OpenRouter refused for credit; re-running on the Anthropic backup (${backupModel()})`);
    const second = await runOnBackup(options);
    return { ...second, ms: second.ms + first.ms, provider: 'anthropic_backup', providerFallback: true, primaryError: (first.error || '').slice(0, 600) };
  }

  return { ...first, provider: 'openrouter' };
}

function spawnClaude({ prompt, cwd, timeoutMs, tools = null, permissionMode = null, modelOverride = null, modelArg = undefined, extraEnv = {}, extraArgs = [], onLog = () => {} }) {
  const bin = claudeBin();
  const args = ['-p', '--output-format', 'json'];

  // The backup names its own model: CLAUDE_MODEL is an OpenRouter name and Anthropic would refuse it.
  const model = modelArg !== undefined ? modelArg : claudeModel();
  if (model) args.push('--model', model);

  if (tools) {
    // A repair needs tools; the deep health check does not, and is given none.
    args.push('--allowedTools', tools);
    args.push('--permission-mode', permissionMode || env('CLAUDE_PERMISSION_MODE') || DEFAULT_PERMISSION_MODE);
  }

  // Per-run arguments, e.g. the n8n MCP server for a prepare run (30 Sep 2026).
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

  const extra = env('CLAUDE_EXTRA_ARGS');
  if (extra) args.push(...extra.split(/\s+/).filter(Boolean));

  const environment = childEnv(extraEnv);
  // An empty modelOverride means "let the CLI choose", which is what the
  // unknown-model fallback needs; null means "use the pinned one".
  if (modelOverride === '') delete environment.ANTHROPIC_MODEL;
  else if (modelOverride) environment.ANTHROPIC_MODEL = modelOverride;

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, text: '', stderr: '', model: null, error: `Claude Code could not be started (${bin}): ${e instanceof Error ? e.message : String(e)}`, timedOut: false, code: null, ms: 0 });
      return;
    }

    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;

    const kill = setTimeout(() => {
      timedOut = true;
      onLog('timeout reached, stopping Claude Code');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > 8_000_000) out = out.slice(-8_000_000);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-200_000);
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolve({ ...result, ms: Date.now() - started });
    };

    child.on('error', (e) => {
      finish({ ok: false, text: out, stderr: err, model: null, error: `Claude Code could not be run (${bin}): ${e.message}`, timedOut, code: null });
    });

    child.on('close', (code) => {
      const parsed = readEnvelope(out);
      if (timedOut) {
        finish({ ok: false, text: parsed.text || out, stderr: err, model: parsed.model, error: `Claude Code did not finish inside its ${Math.round(timeoutMs / 1000)}s limit and was stopped.`, timedOut: true, code });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          text: parsed.text || out,
          stderr: err,
          model: parsed.model,
          error: `Claude Code exited ${code}: ${(err || parsed.text || out).trim().slice(0, 600) || 'no output'}`,
          timedOut: false,
          code,
        });
        return;
      }
      finish({ ok: true, text: parsed.text, stderr: err, model: parsed.model, error: parsed.error, timedOut: false, code });
    });

    child.stdin.on('error', () => {
      /* the child died before the prompt was written; the close handler reports it */
    });
    child.stdin.end(prompt);
  });
}

/**
 * Reads the `--output-format json` envelope.
 *
 * Falls back to the raw text, because an envelope that changed shape must not
 * turn a good run into an unreadable one — the JSON this service actually needs
 * is inside the assistant's own answer, and that is parsed separately.
 */
export function readEnvelope(stdout) {
  const raw = (stdout || '').trim();
  if (!raw) return { text: '', model: null, error: null };
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const text = typeof o.result === 'string' ? o.result : typeof o.text === 'string' ? o.text : raw;
      const model = typeof o.model === 'string' ? o.model : o.modelUsage && typeof o.modelUsage === 'object' ? Object.keys(o.modelUsage)[0] ?? null : null;
      const error = o.is_error || o.subtype === 'error' || o.subtype === 'error_during_execution' ? String(o.error ?? o.subtype ?? 'Claude Code reported an error') : null;
      return { text, model: model ?? null, error };
    }
  } catch {
    /* not the envelope; the raw text is the answer */
  }
  return { text: raw, model: null, error: null };
}

/**
 * The proof that Claude Code reaches OpenRouter on this key.
 *
 * No tools, one word asked for, a minute at most. It is the thing to run before
 * trusting a repair, and it says what went wrong rather than just false.
 */
export async function reachable(timeoutMs, { provider = null } = {}) {
  const ask = {
    prompt: 'reply with the single word OK',
    cwd: process.env.TMPDIR || '/tmp',
    timeoutMs,
    tools: null,
  };
  // provider 'backup' asks Anthropic directly, so the backup can be proved before OpenRouter ever runs dry.
  if (provider === 'backup' && !backupConfigured()) {
    return { claude_reachable: false, provider: 'anthropic_backup', provider_fallback: false, backup_configured: false, model_pinned: backupModel(), model_fallback: false, model: null, said: null, ms: 0, error: 'ANTHROPIC_BACKUP_API_KEY is not set on this service, so there is no backup to check.' };
  }
  const r = provider === 'backup' ? { ...(await runOnBackup(ask)), provider: 'anthropic_backup' } : await runClaude(ask);
  const said = (r.text || '').trim();
  const ok = r.ok && !r.error && /\bok\b/i.test(said);
  return {
    claude_reachable: ok,
    /** What the run was asked for, and what answered — they differ when the pin is wrong. */
    model_pinned: r.provider === 'anthropic_backup' ? backupModel() : model(),
    model_fallback: Boolean(r.modelFallback),
    /** Which provider answered: openrouter, or anthropic_backup after a credit refusal (27 Oct 2026). */
    provider: r.provider ?? 'openrouter',
    provider_fallback: Boolean(r.providerFallback),
    backup_configured: backupConfigured(),
    model: r.model,
    said: said ? said.slice(0, 200) : null,
    ms: r.ms,
    error: ok ? null : r.error || (r.ok ? `Claude Code answered with something other than OK: ${said.slice(0, 200) || '(nothing)'}` : 'Claude Code did not answer'),
  };
}
