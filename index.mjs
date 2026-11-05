import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./dist/cli.cjs', import.meta.url));
const FAIL_ON_EXIT_CODE = 2;
const FAILED = new Set(['fail', 'error']);
const STATUS_ORDER = ['fail', 'error', 'warning', 'information', 'pending'];

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

/** Escapes a message for a workflow command, so it stays on one line. */
const escapeCommand = (text) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Auditor messages quote remote sites: keep them from breaking the table. */
const escapeCell = (text) =>
  String(text ?? '')
    .replace(/[\\|`*_<>[\]]/g, '\\$&')
    .replace(/\s+/g, ' ');

function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${randomUUID()}`;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${key}<<${delimiter}\n${value}\n${delimiter}\n`,
  );
}

function fail(message) {
  console.log(`::error::${escapeCommand(message)}`);
  process.exitCode = 1;
}

function buildArgs() {
  const url = input('url');
  const urlId = input('url-id');
  if (Boolean(url) === Boolean(urlId)) {
    throw new Error('Set exactly one of the url and url-id inputs.');
  }
  const failOn = input('fail-on') || 'fail';
  if (!['fail', 'warning', 'never'].includes(failOn)) {
    throw new Error(`Invalid fail-on "${failOn}". Use fail, warning or never.`);
  }
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: sha } = process.env;
  const note =
    input('note') ||
    (repository && sha ? `${repository}@${sha.slice(0, 7)}` : '');

  const args = ['--json', 'audit', 'run', '--wait'];
  args.push(...(url ? ['--url', url] : ['--url-id', urlId]));
  args.push('--timeout', input('timeout') || '5m');
  if (note) args.push('--note', note);
  if (failOn !== 'never') args.push('--fail-on', failOn);
  for (const auditor of input('auditors').split(/[,\n]/)) {
    if (auditor.trim()) args.push('--auditor', auditor.trim());
  }
  return args;
}

function cliError(stderr) {
  // Warnings may precede the error, which the CLI pretty-prints as JSON.
  const start = stderr.lastIndexOf('{\n  "error"');
  try {
    return JSON.parse(stderr.slice(start)).error.message;
  } catch {
    return stderr.trim() || 'The 37 Audits CLI failed.';
  }
}

function writeSummary(results, counts) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = results
    .filter((r) => r.status !== 'success')
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
    )
    .map(
      (r) =>
        `| ${r.status} | ${escapeCell(r.auditorName ?? r.auditorId)} | ${escapeCell(r.message)} |`,
    );
  const lines = [
    '## 37 Audits',
    '',
    `${counts.success} passed, ${counts.warning} warnings, ${counts.fail} failed`,
    '',
  ];
  if (rows.length > 0) {
    lines.push('| Status | Auditor | Message |', '| --- | --- | --- |', ...rows, '');
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

function report(run) {
  const results = run.results ?? [];
  const counts = {
    success: results.filter((r) => r.status === 'success').length,
    warning: results.filter((r) => r.status === 'warning').length,
    fail: results.filter((r) => FAILED.has(r.status)).length,
  };
  setOutput('success_count', counts.success);
  setOutput('warning_count', counts.warning);
  setOutput('fail_count', counts.fail);
  setOutput('results', JSON.stringify(results));
  writeSummary(results, counts);

  for (const r of results) {
    const message = String(r.message ?? '').replace(/\s+/g, ' ');
    console.log(`${r.status}: ${r.auditorName ?? r.auditorId} ${message}`.trim());
  }
  if (run.timedOut) {
    console.log(
      `::warning::${run.pending} auditor(s) were still running at the timeout; their results will land on 37audits.com.`,
    );
  }
  return counts;
}

function main() {
  const apiKey = input('api-key');
  if (!apiKey) throw new Error('The api-key input is required.');
  console.log(`::add-mask::${apiKey}`);

  const cli = spawnSync(process.execPath, [CLI, ...buildArgs()], {
    env: { ...process.env, THIRTYSEVENAUDITS_API_KEY: apiKey },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  let run;
  try {
    run = JSON.parse(cli.stdout);
  } catch {
    throw new Error(cliError(cli.stderr ?? ''));
  }
  const counts = report(run);

  if (cli.status === FAIL_ON_EXIT_CODE) {
    fail(
      `${counts.fail} auditor(s) failed and ${counts.warning} reported a warning.`,
    );
  } else if (cli.status !== 0) {
    throw new Error(cliError(cli.stderr ?? ''));
  }
}

try {
  main();
} catch (err) {
  fail(err.message);
}
