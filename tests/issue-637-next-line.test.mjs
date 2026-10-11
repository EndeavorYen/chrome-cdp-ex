import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { formatPolicyFailureText } from '../skills/chrome-cdp-ex/scripts/lib/session-policy.mjs';
import { __test__ as T } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const SCAN_ROOTS = [
  'skills/chrome-cdp-ex/scripts',
  'scripts',
];

function walkMjs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walkMjs(path, out);
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

// A Next line is `Next:` plus a shell command and nothing else (#637).
export function nextLineFailures(text) {
  const failures = [];
  for (const line of String(text).split('\n')) {
    const match = line.match(/^(\s*)Next:\s(.*)$/);
    if (!match) continue;
    const command = match[2];
    if (!command.trim()) {
      failures.push(`empty Next command: ${line}`);
      continue;
    }
    if (/\(Kind:/.test(command) || /\(ask first\)/.test(command) || /(^|\s)#/.test(command)) {
      failures.push(`trailing text: ${line}`);
      continue;
    }
    const syntax = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' });
    if (syntax.status !== 0) failures.push(`bash -n failed: ${line}\n${syntax.stderr}`);
  }
  return failures;
}

function expectRunnableNext(text) {
  expect(nextLineFailures(text), text).toEqual([]);
}

describe('#637 Next lines are bare shell commands', () => {
  it('rejects a Kind suffix, an ask-first suffix, and a trailing comment', () => {
    expect(nextLineFailures('Next: cdp perceive ABCD1234 -C -d 8 (Kind: unknown)')).not.toEqual([]);
    expect(nextLineFailures('Next: cdp list (ask first)')).not.toEqual([]);
    expect(nextLineFailures('Next: cdp list  # if empty: cdp open https://example.com')).not.toEqual([]);
    expect(nextLineFailures('Next: cdp list')).toEqual([]);
  });

  it('keeps every formatted receipt Next line runnable', () => {
    const samples = [
      T.formatCliError(new Error('boom'), { cmd: 'eval', targetPrefix: 'ABCD1234' }),
      T.formatCliError(new Error(''), {}),
      T.formatCliError(new Error('target ID required. Run "cdp list" first.'), { cmd: 'perceive' }),
      T.formatCliError(new Error('Ambiguous prefix "AB" — matches 2 targets.'), { cmd: 'click' }),
      T.formatCliError(new Error('Unknown command: clik'), { cmd: 'clik' }),
      T.formatActionFailure(new Error('Named control not found: "Save"'), {
        action: 'click',
        target: { targetId: 'ABCD1234ABCD1234', input: 'Save' },
      }),
      T.formatDoctorReport([
        { status: 'OK', label: 'Node', detail: 'v22' },
        { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222' },
      ]),
      T.formatDoctorReport([
        { status: 'OK', label: 'Node', detail: 'v22' },
        { status: 'OK', label: 'CDP', detail: 'reachable' },
      ]),
      T.formatThrottleText({ mode: 'status', targetId: 'ABCD1234', profile: 'off' }),
      T.formatThrottleText({ mode: 'apply', targetId: 'ABCD1234', profile: 'slow-3g' }),
      T.formatOpenReadyMessage('ABCD1234ABCD1234', 'https://example.com'),
      formatPolicyFailureText('policy: CDP_DENY_ACTIONS blocks "click"; it did not run.', { targetPrefix: 'ABCD1234' }),
    ];
    for (const sample of samples) expectRunnableNext(sample);
  });

  it('has no Kind suffix, ask-first suffix, or trailing comment on a Next line in shipped scripts', () => {
    const hits = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkMjs(join(rootDir, root))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (const [index, line] of lines.entries()) {
          if (!line.includes('Next:')) continue;
          if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
          if (/\(Kind:/.test(line) || /\(ask first\)/.test(line) || /Next:\s[^'"\n]*\s#/.test(line)) {
            hits.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
