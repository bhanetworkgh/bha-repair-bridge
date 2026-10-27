/**
 * The Anthropic backup (27 Oct 2026, LOOP-1793025371486-STVC).
 *
 * On 26 Oct OpenRouter ran dry and the bridge answered every repair with
 * "Claude Code exited 1: API Error: 402 ... billing_error ... can only afford
 * 18201". Bays, North Star, Research Twin and the eval runner already fell back
 * to Anthropic; the bridge did not. These hold the four things that matter: a
 * credit refusal goes to the backup, the backup really is Anthropic on the
 * backup key, a run that may already have written is never re-run, and a
 * service with no backup key reports the refusal as before.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupModel, CREDIT_REFUSAL, reachable, runClaude } from '../src/claude.js';

/**
 * A fake CLI: refuses for credit while it is pointed at OpenRouter, answers OK
 * when pointed at Anthropic, and writes down where each run was pointed.
 * `output` is printed on stdout before the refusal, to stand for a run that
 * had already started working.
 */
async function dryOpenRouter({ output = '' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const seen = path.join(dir, 'runs.txt');
  await writeFile(
    bin,
    `#!/bin/sh
cat > /dev/null
echo "$ANTHROPIC_BASE_URL|key=\${ANTHROPIC_API_KEY:-none}|token=\${ANTHROPIC_AUTH_TOKEN:-none}|model=\${ANTHROPIC_MODEL:-none}" >> ${seen}
case "$ANTHROPIC_BASE_URL" in
  *openrouter*)
    ${output ? `echo '${output}'` : ':'}
    echo 'API Error: 402 {"error":{"type":"billing_error","message":"This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 18201."}}' >&2
    exit 1 ;;
esac
echo '{"type":"result","result":"OK","modelUsage":{"claude-opus-5-5":{}}}'
`,
  );
  await chmod(bin, 0o755);
  return { bin, runs: async () => (await readFile(seen, 'utf8')).trim().split('\n') };
}

function setEnv({ backup = 'sk-ant-backup-test' } = {}) {
  process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-or-test';
  process.env.ANTHROPIC_API_KEY = '';
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_MODEL;
  delete process.env.ANTHROPIC_BACKUP_MODEL;
  delete process.env.ANTHROPIC_BACKUP_BASE_URL;
  if (backup) process.env.ANTHROPIC_BACKUP_API_KEY = backup;
  else delete process.env.ANTHROPIC_BACKUP_API_KEY;
}

const run = (bin, extra = {}) => {
  process.env.CLAUDE_BIN = bin;
  process.env.CLAUDE_BACKUP_BIN = bin;
  return runClaude({ prompt: 'say OK', cwd: tmpdir(), timeoutMs: 20_000, ...extra });
};

test('the 26 Oct refusal text is recognised as a credit refusal, and an ordinary failure is not', () => {
  assert.match('Claude Code exited 1: API Error: 402 {"type":"billing_error"} can only afford 18201', CREDIT_REFUSAL);
  assert.match('This request would exceed your available credits given your current in-flight requests', CREDIT_REFUSAL);
  assert.match('Payment Required', CREDIT_REFUSAL);
  assert.doesNotMatch('API Error: 500 internal server error', CREDIT_REFUSAL);
  assert.doesNotMatch('Claude Code did not finish inside its 600s limit and was stopped.', CREDIT_REFUSAL);
});

test('a credit refusal with no output is re-run once on Anthropic, on the backup key, with the OpenRouter token cleared', async () => {
  setEnv();
  const fake = await dryOpenRouter();
  const notes = [];
  const r = await run(fake.bin, { tools: 'Read', onLog: (d) => notes.push(d) });

  assert.equal(r.ok, true);
  assert.equal(r.provider, 'anthropic_backup');
  assert.equal(r.providerFallback, true);
  assert.match(r.primaryError, /402/);
  const runs = await fake.runs();
  assert.equal(runs.length, 2, 'exactly one retry');
  assert.match(runs[0], /^https:\/\/openrouter\.ai\/api\|key=none\|token=sk-or-test/);
  assert.equal(runs[1], `https://api.anthropic.com|key=sk-ant-backup-test|token=none|model=${backupModel()}`);
  assert.match(notes.join(' '), /re-running on the Anthropic backup/);
});

test('a run whose caller says it already wrote to n8n is never re-run', async () => {
  setEnv();
  const fake = await dryOpenRouter({ output: 'I changed the node' });
  const notes = [];
  const r = await run(fake.bin, { tools: 'Bash', canRetry: async () => false, onLog: (d) => notes.push(d) });

  assert.equal(r.ok, false);
  assert.equal(r.backupSkipped, 'already_wrote');
  assert.equal((await fake.runs()).length, 1, 'one run only');
  assert.match(notes.join(' '), /could write twice/);
});

test('without a canRetry, a tool run that produced output is not re-run either', async () => {
  setEnv();
  const fake = await dryOpenRouter({ output: 'partial work' });
  const r = await run(fake.bin, { tools: 'Bash' });
  assert.equal(r.ok, false);
  assert.equal(r.backupSkipped, 'already_wrote');
  assert.equal((await fake.runs()).length, 1);
});

test('the caller is asked, and a run it clears is re-run even after output', async () => {
  setEnv();
  const fake = await dryOpenRouter({ output: 'read the workflow, wrote nothing' });
  let asked = 0;
  const r = await run(fake.bin, { tools: 'Bash', canRetry: async () => { asked += 1; return true; } });
  assert.equal(asked, 1);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'anthropic_backup');
});

test('with no backup key the refusal is reported as before, and why it was not retried is named', async () => {
  setEnv({ backup: null });
  const fake = await dryOpenRouter();
  const notes = [];
  const r = await run(fake.bin, { onLog: (d) => notes.push(d) });
  assert.equal(r.ok, false);
  assert.match(r.error, /402/);
  assert.equal(r.backupSkipped, 'not_configured');
  assert.equal((await fake.runs()).length, 1);
  assert.match(notes.join(' '), /ANTHROPIC_BACKUP_API_KEY/);
});

test('an OpenRouter-style pin is turned into Anthropic’s own model name for the backup', () => {
  setEnv();
  process.env.ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4.5';
  assert.equal(backupModel(), 'claude-sonnet-4-5');
  process.env.ANTHROPIC_BACKUP_MODEL = 'claude-opus-5-5';
  assert.equal(backupModel(), 'claude-opus-5-5');
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_BACKUP_MODEL;
});

test('the deep check can be pointed at the backup directly, and says so when there is none', async () => {
  setEnv();
  const fake = await dryOpenRouter();
  process.env.CLAUDE_BIN = fake.bin;
  process.env.CLAUDE_BACKUP_BIN = fake.bin;
  const r = await reachable(20_000, { provider: 'backup' });
  assert.equal(r.claude_reachable, true);
  assert.equal(r.provider, 'anthropic_backup');
  assert.equal(r.backup_configured, true);
  assert.equal((await fake.runs()).length, 1, 'straight to Anthropic, no OpenRouter call');

  setEnv({ backup: null });
  const none = await reachable(20_000, { provider: 'backup' });
  assert.equal(none.claude_reachable, false);
  assert.equal(none.backup_configured, false);
  assert.match(none.error, /ANTHROPIC_BACKUP_API_KEY/);
});

test('a healthy OpenRouter run is untouched and says which provider answered', async () => {
  setEnv();
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","result":"OK"}'\n`);
  await chmod(bin, 0o755);
  const r = await run(bin);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.providerFallback, undefined);
});

test('the backup runs its own CLI: the pinned copy is too old for Anthropic', async () => {
  const { backupBin } = await import('../src/claude.js');
  const saved = process.env.CLAUDE_BACKUP_BIN;
  delete process.env.CLAUDE_BACKUP_BIN;
  assert.equal(backupBin(''), 'claude');
  process.env.CLAUDE_BACKUP_BIN = '/x/claude';
  assert.equal(backupBin(), '/x/claude');
  if (saved === undefined) delete process.env.CLAUDE_BACKUP_BIN; else process.env.CLAUDE_BACKUP_BIN = saved;
});

test('the backup skips node_modules/.bin on PATH, where npm start puts the pinned copy', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { backupBin } = await import('../src/claude.js');
  const root = mkdtempSync(join(tmpdir(), 'bin-'));
  const local = join(root, 'app', 'node_modules', '.bin'); mkdirSync(local, { recursive: true }); writeFileSync(join(local, 'claude'), '');
  const global = join(root, 'global', 'bin'); mkdirSync(global, { recursive: true }); writeFileSync(join(global, 'claude'), '');
  const saved = process.env.CLAUDE_BACKUP_BIN; delete process.env.CLAUDE_BACKUP_BIN;
  assert.equal(backupBin(`${local}:${global}:/usr/bin`), join(global, 'claude'));
  if (saved !== undefined) process.env.CLAUDE_BACKUP_BIN = saved;
});
