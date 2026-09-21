/**
 * bha-repair-bridge — the HTTP surface.
 *
 * Three routes and no more:
 *
 *   GET  /health            what is set, what is running, and whether writes are on
 *   GET  /health?deep=1     the proof that Claude Code reaches OpenRouter on this key
 *   POST /fix-workflow      one repair request from n8n's "BHA — Self Healer"
 *
 * `/health` answers before any secret exists — that is how somebody finds out
 * which ones are still missing, so it must never depend on one.
 *
 * `/fix-workflow` answers 202 and does the work afterwards. n8n's HTTP node
 * would time out long before a ten-minute Claude Code run, and a repair that
 * only exists while a socket is open is a repair that a dropped connection can
 * erase. The result comes back by the two reports instead, never on this
 * response.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { deepHealthTimeoutMs, dryRun, env, envMissing, port } from './config.js';
import { reachable } from './claude.js';
import { errText, log, logError } from './log.js';
import { accept, activeRepairs, busy, RequestError } from './repair.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  // A body that is not JSON is the caller's mistake, answered as one rather
  // than as a 500 from deep inside the parser.
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'The body must be JSON.' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'The body is larger than this service accepts (5mb).' });
    }
    return next(err);
  });

  app.get('/health', async (req, res) => {
    const base = {
      ok: true,
      busy: busy(),
      dry_run: dryRun(),
      env_missing: envMissing(),
    };

    const deep = req.query.deep === '1' || req.query.deep === 'true';
    if (!deep) return res.json(base);

    /**
     * The deep check runs Claude Code for real, with no tools, and asks for one
     * word. It is the thing to run before trusting a repair: everything else on
     * this service can be right while the model is unreachable.
     */
    try {
      const r = await reachable(deepHealthTimeoutMs());
      log(null, 'health.deep', { claude_reachable: r.claude_reachable, model: r.model, model_pinned: r.model_pinned, model_fallback: r.model_fallback, ms: r.ms, error: r.error });
      return res.json({
        ...base,
        ok: r.claude_reachable,
        claude_reachable: r.claude_reachable,
        model: r.model,
        model_pinned: r.model_pinned,
        model_fallback: r.model_fallback,
        said: r.said,
        checked_in_ms: r.ms,
        error: r.error,
      });
    } catch (e) {
      logError(null, 'health.deep.failed', errText(e));
      return res.json({ ...base, ok: false, claude_reachable: false, model: null, error: errText(e) });
    }
  });

  app.post('/fix-workflow', (req, res) => {
    const key = env('BRIDGE_KEY');
    const given = req.get('x-api-key');

    if (!key) {
      logError(null, 'fix-workflow.unconfigured', 'BRIDGE_KEY is not set, so every request is refused.');
      return res.status(503).json({ ok: false, error: 'BRIDGE_KEY is not set on this service, so it cannot authenticate anything. Nothing was accepted.' });
    }
    if (given !== key) {
      logError(null, 'fix-workflow.unauthorised', { has_header: Boolean(given) });
      return res.status(401).json({ ok: false, error: 'The x-api-key header is missing or wrong.' });
    }

    try {
      const accepted = accept(req.body ?? {});
      return res.status(202).json({ accepted: true, repair_id: accepted.repair_id });
    } catch (e) {
      if (e instanceof RequestError) {
        logError(null, 'fix-workflow.rejected', e.message);
        return res.status(e.status).json({ ok: false, error: e.message });
      }
      logError(null, 'fix-workflow.error', errText(e));
      return res.status(500).json({ ok: false, error: `The request could not be accepted: ${errText(e)}` });
    }
  });

  /** What is running right now, by repair id. Useful when a repair seems stuck. */
  app.get('/repairs/active', (_req, res) => res.json({ busy: busy(), repairs: activeRepairs() }));

  app.use((req, res) => res.status(404).json({ ok: false, error: `No route ${req.method} ${req.path}. This service has /health and /fix-workflow.` }));

  // eslint-disable-next-line no-unused-vars -- express identifies an error handler by its arity
  app.use((err, _req, res, _next) => {
    logError(null, 'unhandled', errText(err));
    res.status(500).json({ ok: false, error: errText(err) });
  });

  return app;
}

/** Only listen when started as a program, so a test can mount the app without a port. */
const startedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (startedDirectly) {
  const app = createApp();
  const server = app.listen(port(), () => {
    log(null, 'listening', { port: port(), dry_run: dryRun(), env_missing: envMissing() });
  });

  /**
   * A repair runs for up to ten minutes after its request has been answered, so
   * a shutdown stops taking new work and lets what is running finish rather
   * than killing a half-made repair and reporting nothing about it.
   */
  const shutdown = (signal) => {
    log(null, 'shutdown', { signal, busy: busy() });
    server.close(() => {
      const wait = setInterval(() => {
        if (busy() === 0) {
          clearInterval(wait);
          log(null, 'shutdown.done');
          process.exit(0);
        }
      }, 1000);
      // Render sends SIGKILL eventually; this is the honest best effort.
      setTimeout(() => {
        logError(null, 'shutdown.forced', { still_running: busy() });
        process.exit(0);
      }, 60_000).unref();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (e) => logError(null, 'unhandledRejection', errText(e)));
  process.on('uncaughtException', (e) => logError(null, 'uncaughtException', errText(e)));
}
