import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkCoAuthors,
  checkForbiddenText,
  checkHeadSha,
  checkVerification,
} from '../scripts/check-pr-submission.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/check-pr-submission.mjs', import.meta.url));
const workflow = readFileSync(new URL('../.github/workflows/pr-submission-check.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../docs/pr-submission-check.md', import.meta.url), 'utf8');
const tempDirs = [];

const passingBody = [
  '## Summary',
  'Adds a submission check.',
  '',
  '## Verification',
  'proof: unit tests',
  'EVIDENCE CLASS: automated',
  '## Notes',
  'Nothing else.',
].join('\n');

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function writeTemp(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-submission-check-'));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  writeFileSync(filePath, contents);
  return filePath;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PR_FORBIDDEN_TERMS: '', ...env },
  });
}

function actionSha(text, action) {
  const match = text.match(new RegExp(`${action}@([0-9a-f]{40})`));
  return match?.[1] ?? '';
}

describe('checkVerification', () => {
  it('accepts a Verification section that contains Proof and Evidence class', () => {
    expect(checkVerification(passingBody)).toEqual([]);
  });

  it('reports a missing Verification heading', () => {
    expect(checkVerification('Proof and Evidence class without a heading\n')).toEqual([
      'missing ## Verification heading',
    ]);
  });

  it('reports a missing Evidence class inside the Verification section', () => {
    const body = [
      '## Verification',
      '### Notes',
      'Proof is in the subsection.',
      '## Later',
      'Evidence class: should not count',
    ].join('\n');
    expect(checkVerification(body)).toEqual([
      'Verification section missing Evidence class',
    ]);
  });

  it('reports a missing Proof inside the Verification section', () => {
    expect(checkVerification('## Verification\nEvidence class: manual\n')).toEqual([
      'Verification section missing Proof',
    ]);
  });
});

describe('checkForbiddenText', () => {
  it('flags a /home/user/x path', () => {
    expect(checkForbiddenText('see /home/user/x for logs')).toEqual([
      'path /home/user/x',
    ]);
    expect(checkForbiddenText('see /home/user/x.')).toEqual([
      'path /home/user/x',
    ]);
  });

  it('flags the other local path shapes', () => {
    expect(checkForbiddenText('mac /Users/user/project')).toEqual(['path /Users/user/project']);
    expect(checkForbiddenText('box /root/secret')).toEqual(['path /root/secret']);
    expect(checkForbiddenText('repo /workspace/repo')).toEqual(['path /workspace/repo']);
    expect(checkForbiddenText('win C:\\Users\\user\\file')).toEqual(['path C:\\Users\\user\\file']);
    expect(checkForbiddenText('open ~/notes')).toEqual(['path ~/notes']);
  });

  it('does not flag a relative segment', () => {
    expect(checkForbiddenText('home/user/x and workspace/repo')).toEqual([]);
  });

  it('flags an extra term case-insensitively and ignores blanks', () => {
    expect(checkForbiddenText('Seen HIDDEN-MARKER once', ['hidden-marker', '', '  '])).toEqual([
      'term hidden-marker',
    ]);
  });

  it('matches extra terms as substrings', () => {
    expect(checkForbiddenText('axb', ['a.b'])).toEqual([]);
    expect(checkForbiddenText('value a.b here', ['a.b'])).toEqual(['term a.b']);
  });

  it('accepts text with no local paths or extra terms', () => {
    expect(checkForbiddenText('clean submission text', ['other-term'])).toEqual([]);
  });
});

describe('checkCoAuthors', () => {
  it('flags a blocked co-author trailer and reports commit index and line', () => {
    const messages = [
      'First change\n',
      'Second change\n\nCo-authored-by: example-bot <example-bot@example.com>\n',
    ];
    expect(checkCoAuthors(messages)).toEqual([
      'commit 1 line 3: Co-authored-by: example-bot <example-bot@example.com>',
    ]);
  });

  it('accepts a human co-author trailer', () => {
    const messages = [
      'Fix the check\n\nco-authored-by: Local Contributor <contributor@example.com>\n',
    ];
    expect(checkCoAuthors(messages)).toEqual([]);
  });
});

describe('checkHeadSha', () => {
  const head = '37bdbe0abc1234def';

  it('accepts cited head tokens that are prefixes of the current head', () => {
    expect(checkHeadSha('head sha `37bdbe0`', head)).toEqual([]);
    expect(checkHeadSha('Head: 37bdbe0abc', head)).toEqual([]);
    expect(checkHeadSha('on head 37BDBE0', head)).toEqual([]);
    expect(checkHeadSha(`head commit \`${head}\``, head)).toEqual([]);
  });

  it('reports a stale head token', () => {
    expect(checkHeadSha('on head 1111111aaaa', head)).toEqual([
      'body cites head 1111111aaaa but current head is 37bdbe0abc1234def',
    ]);
    expect(checkHeadSha('head sha `37bdbe0abc1234def999`', head)).toEqual([
      'body cites head 37bdbe0abc1234def999 but current head is 37bdbe0abc1234def',
    ]);
  });

  it('accepts a body with no head citation', () => {
    expect(checkHeadSha('The head of the queue moved.', head)).toEqual([]);
    expect(checkHeadSha('header abc1234def', 'fff0000aaa')).toEqual([]);
  });
});

describe('PR submission check CLI', () => {
  it('exits 0 when the submission passes', () => {
    const bodyFile = writeTemp('body.md', passingBody);
    const commitsFile = writeTemp('commits.txt', [
      'Add the checker',
      '',
      'Co-authored-by: Local Contributor <contributor@example.com>',
      '---commit---',
      '',
    ].join('\n'));
    const child = runCli([
      '--body-file', bodyFile,
      '--head', 'abc1234def',
      '--commits-file', commitsFile,
    ]);
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout).toBe('OK\n');
  });

  it('exits 1 when verification fails', () => {
    const bodyFile = writeTemp('body.md', '## Summary\nmissing section\n');
    const child = runCli(['--body-file', bodyFile, '--head', 'abc1234def']);
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(1);
    expect(child.stdout).toContain('FAIL verification: missing ## Verification heading');
    expect(child.stdout).not.toContain('OK');
  });

  it('exits 1 when a commit trailer matches the blocked co-author pattern', () => {
    const bodyFile = writeTemp('body.md', passingBody);
    const commitsFile = writeTemp('commits.txt', [
      'First change',
      '---commit---',
      'Second change',
      '',
      'Co-authored-by: example-bot <example-bot@example.com>',
      '---commit---',
      '',
    ].join('\n'));
    const child = runCli([
      '--body-file', bodyFile,
      '--head', 'abc1234def',
      '--commits-file', commitsFile,
    ]);
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(1);
    expect(child.stdout).toContain(
      'FAIL co-author: commit 1 line 3: Co-authored-by: example-bot <example-bot@example.com>',
    );
  });

  it('exits 1 when PR_FORBIDDEN_TERMS matches the body', () => {
    const bodyFile = writeTemp('body.md', `${passingBody}\nmentions hidden-marker\n`);
    const child = runCli(
      ['--body-file', bodyFile, '--head', 'abc1234def'],
      { PR_FORBIDDEN_TERMS: 'missing-term, hidden-marker\n' },
    );
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(1);
    expect(child.stdout).toContain('FAIL forbidden-text: term hidden-marker');
  });

  it('exits 2 on a usage error', () => {
    const child = runCli(['--head', 'abc1234def']);
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain('Usage: node scripts/check-pr-submission.mjs');
  });
});

describe('PR submission check workflow and docs', () => {
  it('pins the same actions as ci.yml and checks the pull request text', () => {
    expect(actionSha(workflow, 'actions/checkout')).toBe(actionSha(ciWorkflow, 'actions/checkout'));
    expect(actionSha(workflow, 'actions/setup-node')).toBe(actionSha(ciWorkflow, 'actions/setup-node'));
    expect(actionSha(workflow, 'actions/checkout')).toBe('11bd71901bbe5b1630ceea73d27597364c9af683');
    expect(actionSha(workflow, 'actions/setup-node')).toBe('49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow.match(/runs-on:/g)).toHaveLength(1);
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('node-version: 22');
    expect(workflow).not.toContain('npm ci');
    expect(workflow).not.toContain('cache:');
    expect(workflow).toContain('types: [opened, edited, synchronize, reopened, ready_for_review]');
    expect(workflow).toContain('branches: [main, dev]');
    expect(workflow).toContain('PR_BODY: ${{ github.event.pull_request.body }}');
    expect(workflow).toContain('PR_FORBIDDEN_TERMS: ${{ vars.PR_FORBIDDEN_TERMS }}');
    expect(workflow).toContain('BASE: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('HEAD: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain("printf '%s' \"$PR_BODY\" > body.md");
    expect(workflow).toContain("git log --format='%B%n---commit---' \"$BASE..$HEAD\" > commits.txt");
    expect(workflow).toContain('--body-file body.md --head "$HEAD" --commits-file commits.txt');
  });

  it('documents the rules, the repository variable, and local usage', () => {
    expect(doc).toContain('PR_FORBIDDEN_TERMS');
    expect(doc).toContain('scripts/check-pr-submission.mjs');
    expect(doc).toContain('## Verification');
    expect(doc).toContain('Evidence class');
    expect(doc).toContain('--body-file');
    expect(doc).toContain('--head');
    expect(doc).toContain('---commit---');
  });
});
