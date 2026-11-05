import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ACTION = new URL('../index.mjs', import.meta.url).pathname;

/** Runs the action against a stub CLI that records its args and env. */
function runAction({ inputs = {}, stdout = '', stderr = '', exitCode = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-action-'));
  mkdirSync(join(dir, 'dist'));
  copyFileSync(ACTION, join(dir, 'index.mjs'));
  writeFileSync(
    join(dir, 'dist/cli.cjs'),
    `require('fs').writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({
      args: process.argv.slice(2), key: process.env.THIRTYSEVENAUDITS_API_KEY }));
    process.stdout.write(${JSON.stringify(stdout)});
    process.stderr.write(${JSON.stringify(stderr)});
    process.exitCode = ${exitCode};`,
  );
  const outputFile = join(dir, 'output');
  const summaryFile = join(dir, 'summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const env = {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_REPOSITORY: 'acme/site',
    GITHUB_SHA: 'abcdef1234567890',
    'INPUT_API-KEY': 'tsa_live_secret',
  };
  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }
  const result = spawnSync(process.execPath, [join(dir, 'index.mjs')], {
    env,
    encoding: 'utf8',
  });
  let call;
  try {
    call = JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8'));
  } catch {
    call = null;
  }
  return {
    ...result,
    call,
    output: readFileSync(outputFile, 'utf8'),
    summary: readFileSync(summaryFile, 'utf8'),
  };
}

const run = (results, extra = {}) =>
  JSON.stringify({ groupId: 'g1', results, pending: 0, timedOut: false, ...extra });
const URL_INPUT = { url: 'https://www.example.com' };

test('builds the audit run command with defaults', () => {
  const { call, status } = runAction({ inputs: URL_INPUT, stdout: run([]) });
  assert.equal(status, 0);
  assert.equal(call.key, 'tsa_live_secret');
  assert.ok(!call.args.includes('tsa_live_secret'));
  assert.deepEqual(call.args, [
    '--json', 'audit', 'run', '--wait',
    '--url', 'https://www.example.com',
    '--timeout', '5m',
    '--note', 'acme/site@abcdef1',
    '--fail-on', 'fail',
  ]);
});

test('passes url-id, auditors and a custom note; never skips --fail-on', () => {
  const { call } = runAction({
    inputs: { 'url-id': 'u1', auditors: 'csp, hsts\ncache', note: 'n', 'fail-on': 'never' },
    stdout: run([]),
  });
  assert.deepEqual(call.args, [
    '--json', 'audit', 'run', '--wait',
    '--url-id', 'u1',
    '--timeout', '5m',
    '--note', 'n',
    '--auditor', 'csp', '--auditor', 'hsts', '--auditor', 'cache',
  ]);
});

test('rejects bad inputs without calling the CLI', () => {
  for (const inputs of [
    {},
    { url: 'a', 'url-id': 'b' },
    { url: 'a', 'fail-on': 'sometimes' },
  ]) {
    const { status, call, stdout } = runAction({ inputs });
    assert.equal(status, 1);
    assert.equal(call, null);
    assert.match(stdout, /::error::/);
  }
});

test('masks the API key before running', () => {
  const { stdout } = runAction({ inputs: URL_INPUT, stdout: run([]) });
  assert.match(stdout, /^::add-mask::tsa_live_secret$/m);
});

test('reports counts, results and a summary of what did not pass', () => {
  const results = [
    { auditorName: 'Cache', status: 'success', message: 'ok' },
    { auditorName: 'CSP', status: 'fail', message: 'a|b\n<script>' },
    { auditorName: 'DNS', status: 'error', message: 'down' },
    { auditorName: 'HSTS', status: 'warning', message: null },
  ];
  const { status, output, summary, stdout } = runAction({
    inputs: URL_INPUT,
    stdout: run(results),
    exitCode: 2,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::2 auditor\(s\) failed and 1 reported a warning\./);
  assert.match(output, /success_count<<EOF_[^\n]+\n1\n/);
  assert.match(output, /warning_count<<EOF_[^\n]+\n1\n/);
  assert.match(output, /fail_count<<EOF_[^\n]+\n2\n/);
  assert.ok(output.includes(JSON.stringify(results)));
  assert.match(summary, /1 passed, 1 warnings, 2 failed/);
  assert.match(summary, /\| fail \| CSP \| a\\\|b \\<script\\> \|/);
  assert.ok(!summary.includes('Cache'));
});

test('a remote message cannot issue a workflow command', () => {
  const { stdout } = runAction({
    inputs: URL_INPUT,
    stdout: run([{ auditorName: 'CSP', status: 'fail', message: 'x\n::error::spoof' }]),
  });
  assert.ok(!/^::error::spoof/m.test(stdout));
});

test('passes with a clean run', () => {
  const { status, stdout } = runAction({
    inputs: URL_INPUT,
    stdout: run([{ auditorName: 'Cache', status: 'success' }]),
  });
  assert.equal(status, 0);
  assert.ok(!stdout.includes('::error::'));
});

test('surfaces the CLI error message', () => {
  const { status, stdout } = runAction({
    inputs: URL_INPUT,
    stderr: `warning first\n${JSON.stringify({ error: { message: 'No monitored URL\nmatches', code: 'url_not_found' } }, null, 2)}\n`,
    exitCode: 1,
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::No monitored URL%0Amatches/);
});

test('warns when the run timed out without a gate', () => {
  const { status, stdout } = runAction({
    inputs: { ...URL_INPUT, 'fail-on': 'never' },
    stdout: run([{ auditorName: 'Cache', status: 'pending' }], { pending: 1, timedOut: true }),
  });
  assert.equal(status, 0);
  assert.match(stdout, /::warning::1 auditor\(s\) were still running/);
});
