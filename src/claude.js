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
export const DEFAULT_MODEL = 'claude-sonnet-5';

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
  if (first.ok) return first;

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

  return first;
}

function spawnClaude({ prompt, cwd, timeoutMs, tools = null, permissionMode = null, modelOverride = null, extraEnv = {}, onLog = () => {} }) {
  const bin = claudeBin();
  const args = ['-p', '--output-format', 'json'];

  const model = claudeModel();
  if (model) args.push('--model', model);

  if (tools) {
    // A repair needs tools; the deep health check does not, and is given none.
    args.push('--allowedTools', tools);
    args.push('--permission-mode', permissionMode || env('CLAUDE_PERMISSION_MODE') || DEFAULT_PERMISSION_MODE);
  }

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
export async function reachable(timeoutMs) {
  const r = await runClaude({
    prompt: 'reply with the single word OK',
    cwd: process.env.TMPDIR || '/tmp',
    timeoutMs,
    tools: null,
  });
  const said = (r.text || '').trim();
  const ok = r.ok && !r.error && /\bok\b/i.test(said);
  return {
    claude_reachable: ok,
    /** What the run was asked for, and what answered — they differ when the pin is wrong. */
    model_pinned: model(),
    model_fallback: Boolean(r.modelFallback),
    model: r.model,
    said: said ? said.slice(0, 200) : null,
    ms: r.ms,
    error: ok ? null : r.error || (r.ok ? `Claude Code answered with something other than OK: ${said.slice(0, 200) || '(nothing)'}` : 'Claude Code did not answer'),
  };
}
