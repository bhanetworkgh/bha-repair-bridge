import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runClaude, reachable } from '../src/claude.js';

async function fixture(failPrimary = false) {
  process.env.BHA_PRIMARY_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_BACKUP_API_KEY = 'native-test';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
  process.env.ANTHROPIC_AUTH_TOKEN = 'router-test';
  const dir = await mkdtemp(path.join(tmpdir(), 'native-first-'));
  const bin = path.join(dir, 'claude'), seen = path.join(dir, 'seen');
  await writeFile(bin, `#!/bin/sh\ncat >/dev/null\necho "$ANTHROPIC_BASE_URL|$ANTHROPIC_API_KEY|$ANTHROPIC_AUTH_TOKEN" >> '${seen}'\n${failPrimary ? `case "$ANTHROPIC_BASE_URL" in *api.anthropic.com*) echo 'API Error: credit balance is too low' >&2; exit 1;; esac` : ''}\necho '{"type":"result","result":"OK","model":"claude-opus-5-5"}'\n`);
  await chmod(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.CLAUDE_BACKUP_BIN = bin;
  return { seen: () => readFile(seen, 'utf8') };
}
const opts = { prompt: 'say OK', cwd: tmpdir(), timeoutMs: 10000 };
test('native primary uses company key without the OpenRouter token', async () => {
  const f = await fixture(); const r = await runClaude(opts);
  assert.equal(r.provider, 'anthropic'); assert.equal(r.ok, true);
  assert.match(await f.seen(), /api.anthropic.com\|native-test\|\n/);
});
test('credit refusal retries on OpenRouter with native key cleared', async () => {
  const f = await fixture(true); const r = await runClaude(opts);
  assert.equal(r.provider, 'openrouter'); assert.equal(r.providerFallback, true);
  assert.match(await f.seen(), /openrouter.ai\/api\|\|router-test/);
});
test('potential writes forbid a second provider run', async () => {
  const f = await fixture(true); const r = await runClaude({ ...opts, tools: 'Bash', canRetry: async () => false });
  assert.equal(r.backupSkipped, 'already_wrote'); assert.equal((await f.seen()).trim().split('\n').length, 1);
});
test('explicit backup health checks OpenRouter after role reversal', async () => {
  await fixture(); const r = await reachable(10000, { provider: 'backup' });
  assert.equal(r.provider, 'openrouter'); assert.equal(r.claude_reachable, true);
});
