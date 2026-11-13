/**
 * The settings named for what they are (13 Nov 2026): ANTHROPIC_API_KEY is an
 * Anthropic key, OPENROUTER_API_KEY and OPENROUTER_BASE_URL are OpenRouter's.
 * Claude Code only reads ANTHROPIC_* names, so each route must hand the CLI the
 * right value under the name it understands, and the Anthropic key must never
 * reach the OpenRouter route (set, the CLI would use it instead of the token).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaude, reachable, backupConfigured } from '../src/claude.js';
import { envMissing } from '../src/config.js';

async function fixture({ failPrimary = false, baseUrl = 'https://openrouter.ai/api/v1' } = {}) {
  for (const n of ['ANTHROPIC_BACKUP_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BACKUP_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_MODEL', 'ANTHROPIC_BACKUP_MODEL']) delete process.env[n];
  process.env.BHA_PRIMARY_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-named';
  process.env.OPENROUTER_API_KEY = 'sk-or-named';
  process.env.OPENROUTER_BASE_URL = baseUrl;
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-names-'));
  const bin = path.join(dir, 'claude'), seen = path.join(dir, 'seen');
  await writeFile(bin, `#!/bin/sh\ncat >/dev/null\necho "$ANTHROPIC_BASE_URL|$ANTHROPIC_API_KEY|$ANTHROPIC_AUTH_TOKEN" >> '${seen}'\n${failPrimary ? `case "$ANTHROPIC_BASE_URL" in *api.anthropic.com*) echo 'API Error: credit balance is too low' >&2; exit 1;; esac` : ''}\necho '{"type":"result","result":"OK","model":"claude-opus-5-5"}'\n`);
  await chmod(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.CLAUDE_BACKUP_BIN = bin;
  return { seen: async () => (await readFile(seen, 'utf8')).trim().split('\n') };
}
const opts = { prompt: 'say OK', cwd: tmpdir(), timeoutMs: 10000 };

test('the Anthropic route gets ANTHROPIC_API_KEY and no OpenRouter token', async () => {
  const f = await fixture();
  const r = await runClaude(opts);
  assert.equal(r.provider, 'anthropic');
  assert.deepEqual(await f.seen(), ['https://api.anthropic.com|sk-ant-named|']);
});

test('the OpenRouter fallback gets OPENROUTER_* under the CLI names, /v1 taken off, and no Anthropic key', async () => {
  const f = await fixture({ failPrimary: true });
  const r = await runClaude(opts);
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.providerFallback, true);
  assert.deepEqual((await f.seen())[1], 'https://openrouter.ai/api||sk-or-named');
});

test('the backup health check reaches OpenRouter on the new names, and the backup reads as configured', async () => {
  const f = await fixture({ baseUrl: 'https://openrouter.ai/api/' });
  assert.equal(backupConfigured(), true);
  const r = await reachable(10000, { provider: 'backup' });
  assert.equal(r.claude_reachable, true);
  assert.equal(r.provider, 'openrouter');
  assert.deepEqual(await f.seen(), ['https://openrouter.ai/api||sk-or-named']);
});

test('nothing is reported missing on the new names, and a missing Anthropic key is named', async () => {
  await fixture();
  for (const n of ['BRIDGE_KEY', 'N8N_BASE_URL', 'N8N_API_KEY', 'DASHBOARD_URL', 'DASHBOARD_INBOUND_KEY', 'REPORT_WEBHOOK_URL']) process.env[n] = 'x';
  assert.deepEqual(envMissing(), []);
  delete process.env.ANTHROPIC_API_KEY;
  assert.deepEqual(envMissing(), ['ANTHROPIC_API_KEY']);
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(backupConfigured(), false);
});
