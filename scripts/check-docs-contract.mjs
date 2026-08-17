#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateCommandSurfaces } from './generate-command-surfaces.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

export const KILLER_PATH_ORDER = [
  ['doctor', 'doctor'],
  ['list', 'list'],
  ['open', 'open fallback'],
  ['perceive:page', 'perceive compact page read'],
  ['action', 'click/fill action'],
  ['perceive:since-action', 'perceive --since-action after click/fill'],
  ['report', 'report after perceive --since-action'],
];

const CDP_COMMAND_RE = /^node\s+skills\/chrome-cdp-ex\/scripts\/cdp\.mjs\s+(.+)$/;

export function extractCdpCommandKinds(markdown) {
  return markdown
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => line.match(CDP_COMMAND_RE)?.[1] || '')
    .filter(Boolean)
    .map(commandArgsToKind)
    .filter(Boolean);
}

export function commandArgsToKind(args) {
  if (/^doctor\b/.test(args)) return 'doctor';
  if (/^list\b/.test(args)) return 'list';
  if (/^open\b/.test(args)) return 'open';
  if (/^report\b/.test(args)) return 'report';
  if (/^click\b/.test(args)) return 'click';
  if (/^fill\b/.test(args)) return 'fill';
  if (/^cascade\b/.test(args)) return 'cascade';
  if (/^record-actions\b/.test(args)) return 'record-actions';
  if (/^replay\b/.test(args)) return 'replay';
  if (/^export-playwright\b/.test(args)) return 'export-playwright';
  if (/^perceive\b/.test(args) && /\s--since-action\b/.test(args)) return 'perceive:since-action';
  if (/^perceive\b/.test(args) && /\s-C\b/.test(args) && /\s-d\s+\d+\b/.test(args)) {
    return 'perceive:page';
  }
  return '';
}

function matchesRequiredKind(kind, required) {
  if (required === 'action') return kind === 'click' || kind === 'fill';
  return kind === required;
}

export function validateKillerPathContract(markdown) {
  const failures = [];
  const kinds = extractCdpCommandKinds(markdown);
  let cursor = 0;

  for (const [required, label] of KILLER_PATH_ORDER) {
    const foundAt = kinds.findIndex((kind, index) => index >= cursor && matchesRequiredKind(kind, required));
    if (foundAt === -1) {
      failures.push(`Killer Path command sequence is missing or out of order: ${label}`);
      cursor = kinds.length;
    } else {
      cursor = foundAt + 1;
    }
  }

  if (!kinds.includes('fill')) {
    failures.push('Killer Path is missing form-fill alternative command');
  }
  if (!markdown.includes('click <target> "#missing" --format json')) {
    failures.push('Killer Path example is missing failed-action recovery command');
  }
  if (!kinds.includes('cascade')) {
    failures.push('Killer Path example is missing CSS tracing command');
  }
  if (!kinds.includes('record-actions')) {
    failures.push('Killer Path example is missing record-actions handoff command');
  }
  if (!kinds.includes('replay')) {
    failures.push('Killer Path example is missing replay handoff command');
  }
  if (!kinds.includes('export-playwright')) {
    failures.push('Killer Path example is missing export-playwright handoff command');
  }

  return failures;
}

function parseJsonDoc(text, label, failures) {
  try {
    return JSON.parse(text);
  } catch (e) {
    failures.push(`${label} is not valid JSON: ${e.message}`);
    return null;
  }
}

function hasCandidateReleaseClaim(text, version) {
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidateVersion = new RegExp(`\\bv${escapedVersion}\\b`, 'i');
  const releaseContext = /\b(?:release(?:\s+notes?)?|pinned|latest|measured|published)\b/i;
  const bracketContexts = [...text.matchAll(/\[([^\]\n]{1,300})\]/g)].map(match => match[1]);
  const clauseContexts = text
    .split(/\r?\n/)
    .flatMap(line => line.split(/(?:;|；|。|(?<!\d)[.!?](?!\d))/u))
    .filter(clause => clause.length <= 2_000);
  return [...bracketContexts, ...clauseContexts]
    .some(context => candidateVersion.test(context) && releaseContext.test(context));
}

function checkReleaseMetadataContract(docs) {
  const failures = [];
  if (!docs.packageJson && !docs.pluginManifest) return failures;

  const packageModel = docs.packageJson ? parseJsonDoc(docs.packageJson, 'package.json', failures) : null;
  const pluginModel = docs.pluginManifest ? parseJsonDoc(docs.pluginManifest, '.claude-plugin/plugin.json', failures) : null;
  if (!packageModel || !pluginModel) return failures;

  if (packageModel.version !== pluginModel.version) {
    failures.push(`Release metadata version mismatch: package.json ${packageModel.version} != .claude-plugin/plugin.json ${pluginModel.version}`);
  }
  const version = packageModel.version;
  const publishedVersion = docs.changelog?.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] || null;
  if (!publishedVersion) {
    failures.push('CHANGELOG.md is missing the latest published semantic version');
    return failures;
  }
  for (const [label, text] of [['README.md', docs.readme], ['docs/reference.md', docs.reference]]) {
    if (!text) continue;
    if (!text.includes(`/releases/tag/v${publishedVersion}`)) {
      failures.push(`${label} is missing the published release tag v${publishedVersion}`);
    }
    if (!text.includes(`pi-chrome-cdp-${publishedVersion}.tgz`)) {
      failures.push(`${label} is missing the published release tarball pi-chrome-cdp-${publishedVersion}.tgz`);
    }
    if (version !== publishedVersion) {
      if (!text.toLowerCase().includes('unreleased') || !text.includes(`v${version}`)) {
        failures.push(`${label} must identify v${version} as an unreleased candidate while v${publishedVersion} remains published`);
      }
      if (text.includes(`/releases/tag/v${version}`)) {
        failures.push(`${label} must not fabricate an unreleased release tag v${version}`);
      }
      if (text.includes(`pi-chrome-cdp-${version}.tgz`)) {
        failures.push(`${label} must not fabricate an unreleased tarball pi-chrome-cdp-${version}.tgz`);
      }
      if (hasCandidateReleaseClaim(text, version)) {
        failures.push(`${label} must not present unreleased candidate v${version} as a published or measured release`);
      }
    }
  }
  return failures;
}

function checkContributorDocsContract(docs) {
  const failures = [];
  const stalePath = 'skills/chrome-cdp/scripts/cdp.mjs';
  for (const [label, text] of [
    ['CLAUDE.md', docs.claude],
    ['CONTRIBUTING.md', docs.contributing],
    ['DESIGN.md', docs.design],
  ]) {
    if (text?.includes(stalePath)) failures.push(`${label} contains stale path: ${stalePath}`);
  }
  if (/single-file implementation|~\s*2400\s+lines/i.test(docs.claude || '')) {
    failures.push('CLAUDE.md contains an obsolete single-file or line-count claim');
  }
  if (/\|[^\n]*(?:`emulate`|`frame`|`components`|Replay\/checkpoint\/session reports)[^\n]*\|\s*Future\s*\|/i.test(docs.design || '')) {
    failures.push('DESIGN.md marks shipped features as Future');
  }
  return failures;
}

function checkSelfImprovementLoopContract(docs) {
  const failures = [];
  const text = docs.selfImprovementLoop || '';
  const required = [
    '## Round Contract',
    '## 1. Self-Assess',
    '## 2. Open Issues',
    '## 3. Implement And Verify',
    '## 4. Review And Merge',
    '## 5. Next-Round Backlog',
    'npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli',
    '--real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy',
    '--allow-failures',
    'gh issue create',
    'npm test',
    'npm run lint',
    'npm run check:docs',
    'gh pr create --base main',
    'gh pr checks',
    'gh pr merge',
    'History trend',
    'issueDrafts',
    'origin/main',
  ];
  for (const item of required) {
    if (!text.includes(item)) {
      failures.push(`Self-improvement loop runbook is missing: ${item}`);
    }
  }
  if (!docs.reference.includes('self-improvement-loop.md')) {
    failures.push('Reference docs must link to the self-improvement loop runbook');
  }
  return failures;
}

export const LOCKED_LIVE_SESSION_BOARD = Object.freeze({
  date: '2026-08-17',
  sha: '22c525d4',
  opponent: 'Browser Use',
  jobs: Object.freeze([
    'scroll to bottom (HF home)',
    'nested overflow (Comfy `#content-container`)',
    'click Browse 2M+ models',
    'search submit bert',
    'nav example.org',
    'read HF home',
    'hover reveal',
    'PDF text one page',
    'overlay detect',
    'click Browse 1M+ applications',
  ]),
  scores: Object.freeze([
    '1 / 62 / 139 PASS',
    '1 / 118 / 227 PASS',
    '1 / 83 / 144 PASS',
    '3 / 6307 / 391 PASS',
    '1 / 549 / 487 PASS',
    '2 / 7636 / 507 PASS',
    '1 / 114 / 410 PASS',
    '5 / 770 / 1261 PASS',
    '1 / 69 / 297 PASS',
    '1 / 86 / 16 PASS',
    '1 / 3863 / 152 PASS',
    '1 / 7540 / 6 PASS',
    '1 / 192 / 145 PASS',
    '2 / 12025 / 14 PASS',
    '1 / 4323 / 232 PASS',
    '1 / 94 / 5 FAIL',
    '1 / 232 / 142 PASS',
    '1 / 35139 / 21 FAIL',
    '1 / 580 / 457 PASS',
    '2 / 7640 / 625 PASS',
  ]),
  wallAdmissions: Object.freeze(['16 ms vs 297', '6 vs 152', '14 vs 145', '21 vs 142']),
});

export function checkReadmeFaceContract(readme) {
  const failures = [];
  if (!/browser you already have open/i.test(readme)) {
    failures.push('README is missing the live-session hook');
  }
  if (!/one step/i.test(readme) || !/short receipt|skinny/i.test(readme)) {
    failures.push('README is missing the one-step receipt face');
  }
  if (!readme.includes(LOCKED_LIVE_SESSION_BOARD.date) || !readme.includes(LOCKED_LIVE_SESSION_BOARD.sha)) {
    failures.push(`README is missing the locked live-session board identity (${LOCKED_LIVE_SESSION_BOARD.date} / ${LOCKED_LIVE_SESSION_BOARD.sha})`);
  }
  if (!readme.includes(LOCKED_LIVE_SESSION_BOARD.opponent)) {
    failures.push('README is missing the Browser Use comparison');
  }
  if (!/steps\s*\/\s*agent-facing chars\s*\/\s*wall ms/i.test(readme)) {
    failures.push('README must say the board columns are steps / agent-facing chars / wall ms');
  }
  for (const job of LOCKED_LIVE_SESSION_BOARD.jobs) {
    if (!readme.includes(job)) failures.push(`README is missing locked board job: ${job}`);
  }
  for (const score of LOCKED_LIVE_SESSION_BOARD.scores) {
    if (!readme.includes(score)) failures.push(`README is missing locked board score: ${score}`);
  }
  if (!/(faster|quicker).{0,120}(wall|clock)|(wall|clock).{0,120}(faster|quicker)/is.test(readme)) {
    failures.push('README must admit Browser Use is faster on wall-clock for some jobs');
  }
  for (const admission of LOCKED_LIVE_SESSION_BOARD.wallAdmissions) {
    if (!readme.includes(admission)) {
      failures.push(`README must admit the locked wall-clock loss: ${admission}`);
    }
  }
  if (!/empty/i.test(readme) || !readme.includes('1 / 94 / 5 FAIL')) {
    failures.push('README must show Browser Use failing PDF text as empty');
  }
  if (!/overlay/i.test(readme) || !readme.includes('1 / 35139 / 21 FAIL')) {
    failures.push('README must show Browser Use failing overlay detect');
  }
  if (/^\|.*playwright.*\|/im.test(readme)) {
    failures.push('README must not put Playwright in the score table');
  }
  if (/playwright[^\n]{0,120}\d+\s*ms/i.test(readme) || /\d+\s*ms[^\n]{0,120}playwright/i.test(readme)) {
    failures.push('README must not invent Playwright timings');
  }
  if (readme.includes('## Five success cases') || readme.includes('### Promotion checklist') || readme.includes('commands-81')) {
    failures.push('README must not restore the command-catalog first screen');
  }
  if (!readme.includes('./bin/chrome-cdp doctor')) {
    failures.push('README is missing a doctor start path');
  }
  if (!readme.includes('INTEGRATIONS.md') && !readme.includes('docs/integrations/')) {
    failures.push('README is missing cross-host integrations entry point');
  }
  if (!/\bMIT\b/.test(readme) || !readme.includes('LICENSE')) {
    failures.push('README is missing license');
  }
  return failures;
}

export function checkDocsContract(docs, commands) {
  const failures = [];

  const commandReference = `${docs.readme}\n${docs.reference || ''}`;
  for (const command of commands) {
    const names = [command.name, ...(command.aliases || [])];
    const appearsInReference = names.some(name => commandReference.includes(name));
    const appearsInSkill = names.some(name => docs.skill.includes(name));
    if (!appearsInReference || !appearsInSkill) {
      failures.push(`Missing command docs for ${command.name}`);
    }
  }

  failures.push(...checkReadmeFaceContract(docs.readme || ''));

  const requiredKillerPathTerms = [
    'TL;DR',
    'doctor',
    'list',
    'open',
    'perceive',
    'click',
    'fill',
    '--since-action',
    'report',
  ];
  for (const item of requiredKillerPathTerms) {
    if (!docs.killerPath.includes(item)) {
      failures.push(`Killer Path example is missing: ${item}`);
    }
  }

  failures.push(...validateKillerPathContract(docs.killerPath));
  failures.push(...checkReleaseMetadataContract(docs));
  failures.push(...checkContributorDocsContract(docs));
  failures.push(...checkSelfImprovementLoopContract(docs));
  return failures;
}

function readSkillCorpus() {
  const skillDir = 'skills/chrome-cdp-ex';
  const parts = [readFileSync(resolve(ROOT_DIR, skillDir, 'SKILL.md'), 'utf8')];
  for (const rel of [
    'references/commands.md',
    'references/recipes.md',
    'references/troubleshooting.md',
  ]) {
    try {
      parts.push(readFileSync(resolve(ROOT_DIR, skillDir, rel), 'utf8'));
    } catch {
      // Optional during partial checkouts; missing files fail command coverage naturally.
    }
  }
  return parts.join('\n');
}

function readDocs() {
  const read = path => readFileSync(resolve(ROOT_DIR, path), 'utf8');
  return {
    readme: read('README.md'),
    reference: read('docs/reference.md'),
    selfImprovementLoop: read('docs/self-improvement-loop.md'),
    skill: readSkillCorpus(),
    killerPath: read('docs/examples/killer-path.md'),
    packageJson: read('package.json'),
    pluginManifest: read('.claude-plugin/plugin.json'),
    changelog: read('CHANGELOG.md'),
    claude: read('CLAUDE.md'),
    contributing: read('CONTRIBUTING.md'),
    design: read('DESIGN.md'),
  };
}

export function runDocsContract() {
  const failures = checkDocsContract(readDocs(), T.COMMANDS);
  try {
    generateCommandSurfaces({ rootDir: ROOT_DIR });
  } catch (error) {
    failures.push(error.message || String(error));
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = runDocsContract();
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exit(1);
  console.log(`Docs contract OK: ${T.COMMANDS.length} commands checked`);
}
