/**
 * Which model a run asks for.
 *
 * The CLI's own default resolved to a Sonnet from May 2025 on this account, so
 * the model is pinned. Two things are worth holding: the pin reaches the child
 * process, and a pin the provider does not know falls back rather than turning
 * every repair into an error about a model name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_MODEL, model, runClaude } from '../src/claude.js';

/** A fake CLI that writes the model it was given to a file and answers OK. */
async function echoingClaude() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const seen = path.join(dir, 'model.txt');
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\nprintf '%s' "\${ANTHROPIC_MODEL-<unset>}" > ${seen}\necho '{"type":"result","result":"OK"}'\n`);
  await chmod(bin, 0o755);
  return { bin, read: () => readFile(seen, 'utf8') };
}

/**
 * A fake CLI that refuses a pinned model the way a provider does — 404, nothing
 * on stdout — and answers normally once the pin is gone.
 */
async function pickyClaude() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  await writeFile(
    bin,
    `#!/bin/sh
cat > /dev/null
if [ -n "\${ANTHROPIC_MODEL-}" ]; then
  echo "API Error: 404 {\\"error\\":{\\"type\\":\\"not_found_error\\",\\"message\\":\\"model: \$ANTHROPIC_MODEL\\"}}" >&2
  exit 1
fi
echo '{"type":"result","result":"OK","modelUsage":{"claude-sonnet-4-20250514":{}}}'
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

const run = (bin, extra = {}) => {
  process.env.CLAUDE_BIN = bin;
  return runClaude({ prompt: 'say OK', cwd: tmpdir(), timeoutMs: 20_000, ...extra });
};

test('the pinned model is a current Sonnet and reaches the child process', async () => {
  delete process.env.ANTHROPIC_MODEL;
  assert.equal(model(), DEFAULT_MODEL);
  assert.match(DEFAULT_MODEL, /sonnet/);

  const fake = await echoingClaude();
  const r = await run(fake.bin);
  assert.equal(r.ok, true);
  assert.equal(await fake.read(), DEFAULT_MODEL);
});

test('ANTHROPIC_MODEL on the service wins, so the pin can move without a release', async () => {
  process.env.ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4.5';
  assert.equal(model(), 'anthropic/claude-sonnet-4.5');

  const fake = await echoingClaude();
  await run(fake.bin);
  assert.equal(await fake.read(), 'anthropic/claude-sonnet-4.5');

  delete process.env.ANTHROPIC_MODEL;
});

test('a model the provider does not know falls back to the CLI’s own default', async () => {
  const notes = [];
  const r = await run(await pickyClaude(), { onLog: (d) => notes.push(d) });

  assert.equal(r.ok, true);
  assert.equal(r.modelFallback, true);
  assert.equal(r.model, 'claude-sonnet-4-20250514', 'the answer records which model actually served it');
  assert.match(notes.join(' '), /does not know the model/);
});

test('a run that had already produced output is never re-run', async () => {
  // Anything that wrote to stdout may have used a tool, and a repair that ran
  // twice could write to n8n twice. Only a run with no output at all is retried.
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const count = path.join(dir, 'runs.txt');
  await writeFile(bin, `#!/bin/sh\ncat > /dev/null\necho x >> ${count}\necho 'I did some work'\necho "404 not_found_error model" >&2\nexit 1\n`);
  await chmod(bin, 0o755);

  const r = await run(bin);
  assert.equal(r.ok, false);
  assert.equal(r.modelFallback, undefined);
  assert.equal((await readFile(count, 'utf8')).trim().split('\n').length, 1, 'exactly one run');
});
