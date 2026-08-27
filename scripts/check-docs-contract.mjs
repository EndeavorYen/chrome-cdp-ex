#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateCommandSurfaces } from './generate-command-surfaces.mjs';
import { SURVIVOR_COMMANDS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import {
  LOCKED_PK_BOARD,
  PK_324_CHART_FACES,
  PK_324_CHART_FILES,
  PK_324_SCOREBOARD_FILE,
  renderPk324ChartSvg,
  renderPk324ScoreboardSvg,
  scoreCell,
} from './lib/pk-324-board.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

export { SURVIVOR_COMMANDS };

const SURVIVOR_SET = new Set(SURVIVOR_COMMANDS);

export function mentionsCommand(text, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text || '');
}

function sameText(left, right) {
  return String(left || '').replace(/\r\n/g, '\n') === String(right || '').replace(/\r\n/g, '\n');
}

export function isSurvivorCommand(name) {
  return SURVIVOR_SET.has(name);
}

export const KILLER_PATH_ORDER = [
  ['doctor', 'doctor'],
  ['list', 'list'],
  ['open', 'open fallback'],
  ['perceive:page', 'perceive compact page read'],
  ['action', 'click/fill action'],
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
    } else if (/\bunreleased candidate\b/i.test(text)) {
      failures.push(`${label} must not keep the unreleased-candidate banner after v${version} is published`);
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
    'Not a merge gate',
    'npm run benchmark:campaign -- --rounds 10 --types mcp,cli,killer,large-app,real-app,real-app,real-app,real-app,real-app,cli',
    '--real-app-targets dashboard,docs-app,auth-flow,data-table,canvas-heavy',
    '--allow-failures',
    'gh issue create',
    'npm test',
    'npm run lint',
    'npm run check:docs',
    'npm run smoke:live',
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
  if (/10\+\s*round mixed campaign for release readiness/i.test(text)) {
    failures.push('Self-improvement loop runbook must not treat 10-round mixed campaign as a merge instruction');
  }
  if (docs.reference && !docs.reference.includes('self-improvement-loop.md')) {
    failures.push('Reference docs must link to the self-improvement loop runbook');
  }
  return failures;
}

const BANNED_CAMPAIGN_MERGE_GATES = [
  /requires a passing 10\+\s*round mixed campaign/i,
  /10\+\s*round mixed campaign for release readiness/i,
  /A release candidate should pass matched MCP\/CLI rounds/i,
];

function checkWorkstreamVerificationContract(docs) {
  const failures = [];
  for (const [label, text] of [['CLAUDE.md', docs.claude], ['CONTRIBUTING.md', docs.contributing]]) {
    if (!text) continue;
    for (const item of ['npm test', 'npm run lint', 'npm run check:docs', 'npm run smoke:live']) {
      if (!text.includes(item)) {
        failures.push(`${label} verification is missing: ${item}`);
      }
    }
    if (BANNED_CAMPAIGN_MERGE_GATES.some(pattern => pattern.test(text))) {
      failures.push(`${label} must not list 10-round mixed campaign as required`);
    }
  }
  return failures;
}

export { LOCKED_PK_BOARD };
export const LOCKED_LIVE_SESSION_BOARD = LOCKED_PK_BOARD;

export const README_FIRST_SCREEN_MARKERS = Object.freeze([
  ['advantage', 'browser you already have open', 'live-session hook'],
  ['quickstart', '## Quick start', 'Quick Start'],
]);

function markerIndex(text, marker) {
  return text.toLowerCase().indexOf(String(marker).toLowerCase());
}

export function checkReadmeFirstScreenOrder(readme) {
  const failures = [];
  for (const [id, marker, label] of README_FIRST_SCREEN_MARKERS) {
    if (markerIndex(readme, marker) === -1) {
      failures.push(`README first screen is missing ${id}: ${label}`);
    }
  }
  return failures;
}

export function checkPk324BoardContract(pkBoard) {
  const failures = [];
  const board = pkBoard || '';
  if (!board.includes(LOCKED_PK_BOARD.date) || !board.includes(LOCKED_PK_BOARD.sha)) {
    failures.push(`docs/pk-324-board.md is missing the locked board identity (${LOCKED_PK_BOARD.date} / ${LOCKED_PK_BOARD.sha})`);
  }
  if (!board.includes('1042×632') || !/\bn\s*=\s*3\b/.test(board)) {
    failures.push('docs/pk-324-board.md is missing the Playwright same-machine viewport / n=3 median line');
  }
  if (!board.includes('token = UTF-8 characters each tool returned to the agent')
    && !board.includes('token = UTF-8 chars returned to the agent')) {
    failures.push('docs/pk-324-board.md is missing the token footnote');
  }
  if (!board.includes('Playwright void click/hover = 0') || !/no invented snapshot/i.test(board)) {
    failures.push('docs/pk-324-board.md is missing the token-counting line');
  }
  if (!board.includes('time is wall ms')) {
    failures.push('docs/pk-324-board.md is missing the wall-ms footnote');
  }
  for (const job of LOCKED_PK_BOARD.jobs) {
    if (!board.includes(job.name) && !(job.name.includes('#content-container') && board.includes('#content-container'))) {
      failures.push(`docs/pk-324-board.md is missing locked board job: ${job.name}`);
    }
    for (const tool of ['cdp', 'browserUse', 'playwright']) {
      const cell = scoreCell(job, tool);
      if (!board.includes(cell)) failures.push(`docs/pk-324-board.md is missing locked board cell: ${job.name} ${cell}`);
    }
  }
  if (!board.includes('empty innerText') || !board.includes('AI4AI')) {
    failures.push('docs/pk-324-board.md must show PDF FAIL for Browser Use and Playwright, PASS for chrome-cdp-ex');
  }
  if (!board.includes('blocking')
    || !board.includes('#sp_message_container_1476394')
    || !board.includes('sp_message_iframe_1476394')
    || !/did not dismiss/i.test(board)
    || !board.includes('snapshot looked clear')) {
    failures.push('docs/pk-324-board.md must explain overlay detect PASS/FAIL, not only the token count');
  }
  for (const slower of LOCKED_PK_BOARD.slowerThanBrowserUse) {
    if (!board.includes(`${slower.cdp} vs ${slower.browserUse}`)) {
      failures.push(`docs/pk-324-board.md must state the slower wall-clock pair ${slower.job} (${slower.cdp} vs ${slower.browserUse})`);
    }
  }
  if (/\bmean wall\b|\baveraged time\b|\bavg wall\b/i.test(board) && !/do not average/i.test(board)) {
    failures.push('docs/pk-324-board.md must not average time across heterogeneous jobs');
  }
  return failures;
}

export function checkPk324ChartContract(charts = {}) {
  const failures = [];
  for (const face of PK_324_CHART_FACES) {
    const actual = charts[face] || '';
    const expected = renderPk324ChartSvg(face);
    if (!actual) {
      failures.push(`Missing PK chart ${PK_324_CHART_FILES[face]}`);
      continue;
    }
    if (!sameText(actual, expected)) {
      failures.push(`${PK_324_CHART_FILES[face]} does not match the locked ${face} chart`);
    }
    for (const job of LOCKED_PK_BOARD.jobs) {
      for (const tool of LOCKED_PK_BOARD.tools) {
        const value = job[tool.key][face];
        const needle = `data-job="${job.name}" data-tool="${tool.label}" data-face="${face}" data-value="${value}"`;
        if (!actual.includes(needle)) {
          failures.push(`${PK_324_CHART_FILES[face]} is missing locked ${face} bar ${job.name} ${tool.label}=${value}`);
        }
      }
    }
  }
  return failures;
}

export function checkPk324ScoreboardContract(svg) {
  const failures = [];
  const actual = svg || '';
  const expected = renderPk324ScoreboardSvg();
  if (!actual.includes('data-value="10/10"') || !/data-value="10\/10"[^>]*font-weight="700"/.test(actual)) {
    failures.push('PK scoreboard SVG must bold chrome-cdp-ex total success 10/10');
  }
  if (!actual.includes('data-value="8/10"') || !actual.includes('data-value="9/10"')) {
    failures.push('PK scoreboard SVG must show Browser Use 8/10 and Playwright 9/10');
  }
  if (/data-value="8\/10"[^>]*font-weight="700"/.test(actual)
    || /data-value="9\/10"[^>]*font-weight="700"/.test(actual)) {
    failures.push('PK scoreboard SVG must bold only the winning total (chrome-cdp-ex 10/10)');
  }
  if (!actual.includes('steps / token / wall ms')) {
    failures.push('PK scoreboard SVG must label job cells as steps / token / wall ms');
  }
  if (/\bcost\b|\bcp\b/i.test(actual)) {
    failures.push('PK scoreboard SVG must not add a cost/cp column');
  }
  for (const job of LOCKED_PK_BOARD.jobs) {
    const expectedFails = LOCKED_PK_BOARD.tools.filter(tool => job[tool.key].success === 'FAIL').length;
    const failRe = new RegExp(
      `data-job="${job.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" data-tool="[^"]+" data-success="FAIL"`,
      'g',
    );
    const actualFails = (actual.match(failRe) || []).length;
    if (expectedFails > 0 && actualFails < expectedFails) {
      failures.push(`PK scoreboard SVG must keep ${expectedFails} FAIL cell(s) visible on ${job.name}`);
    }
    for (const tool of LOCKED_PK_BOARD.tools) {
      const cell = job[tool.key];
      const needle = `data-job="${job.name}" data-tool="${tool.label}" data-success="${cell.success}" data-steps="${cell.steps}" data-token="${cell.token}" data-time="${cell.time}"`;
      if (!actual.includes(needle)) {
        failures.push(`PK scoreboard SVG is missing locked cell: ${job.name} ${tool.label} ${cell.success} ${cell.steps}/${cell.token}/${cell.time}`);
      }
      if (cell.success === 'FAIL' && !actual.includes(`data-job="${job.name}" data-tool="${tool.label}" data-success="FAIL"`)) {
        failures.push(`PK scoreboard SVG must color-mark FAIL on ${job.name} ${tool.label}`);
      }
    }
  }
  if (actual && !sameText(actual, expected)) {
    failures.push(`${PK_324_SCOREBOARD_FILE} does not match the locked scoreboard`);
  }
  if (!actual) {
    failures.push(`Missing PK scoreboard ${PK_324_SCOREBOARD_FILE}`);
  }
  return failures;
}

export function checkReadmePkTableContract(readme) {
  const failures = [];
  if (/PASS\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+/.test(readme)
    || /FAIL\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+/.test(readme)) {
    failures.push('README must not keep engineer mashup cells (success / steps / time / token)');
  }
  if (/^\s*\|[^\n]*\b(?:PASS|FAIL)\b[^\n]*\|/m.test(readme)
    || /^\s*\|\s*\|?\s*chrome-cdp-ex\s*\|\s*Browser Use\s*\|\s*Playwright\s*\|/m.test(readme)
    || /^\s*\|\s*job\s*\|/m.test(readme)) {
    failures.push('README must not keep a markdown PK grid as the first-glance comparison');
  }
  return failures;
}

export function checkSkillGoldenPathContract(skill) {
  const failures = [];
  const text = skill || '';
  if (/models\?search/i.test(text)) {
    failures.push('Always-loaded SKILL.md must not keep HuggingFace models?search liturgy');
  }
  if (/leftover-ax/i.test(text)) {
    failures.push('Always-loaded SKILL.md must not keep leftover-ax tautology');
  }
  if (/cap-swap/i.test(text)) {
    failures.push('Always-loaded SKILL.md must not keep cap-swap sampling');
  }
  if (/\bstdio MCP\b|\bconfirm:\s*true\b|setup\.mjs\s+--for/i.test(text)) {
    failures.push('Always-loaded SKILL.md must not require MCP, setup.mjs --for, or confirm:true');
  }
  return failures;
}

export function checkDefaultHelpContract(help) {
  const failures = [];
  const text = help || '';
  for (const name of SURVIVOR_COMMANDS) {
    if (!mentionsCommand(text, name)) {
      failures.push(`Default cdp help is missing survivor command: ${name}`);
    }
  }
  if (/\bjsclick\s+</.test(text)) {
    failures.push('Default cdp help must not advertise jsclick as a product name');
  }
  if (/\beval64\s+</.test(text)) {
    failures.push('Default cdp help must not advertise eval64 as a product name');
  }
  if (text.includes('tab-group') && text.includes('broadcast') && text.includes('checkpoint')) {
    failures.push('Default cdp help must list survivors, not the 81-command catalog');
  }
  return failures;
}

export function checkReadmeLivePathContract(readme) {
  const failures = [];
  const text = readme || '';
  const quickStart = text.split(/## Quick start/i)[1]?.split(/^## /m)[0] || '';
  if (/setup\.mjs\s+--for/i.test(quickStart) || /\bstdio MCP\b/i.test(quickStart) || /live-validated/i.test(quickStart)) {
    failures.push('README Quick Start must not require MCP, setup.mjs --for, or six-host live-validated loops');
  }
  const fold = text.split(/## Daily browser CDP/i)[0] || text;
  if (fold.includes('experiment/pk-324-scoreboard.svg') || /10\/10[\s\S]{0,80}8\/10[\s\S]{0,80}9\/10/.test(fold)) {
    failures.push('README first screen must not use the 10/8/9 PK scoreboard SVG as the first claim');
  }
  return failures;
}

export function checkReadmeFaceContract(readme, extras = {}) {
  const failures = [];
  failures.push(...checkReadmeFirstScreenOrder(readme));
  failures.push(...checkReadmePkTableContract(readme));
  failures.push(...checkReadmeLivePathContract(readme));
  if (!/browser you already have open/i.test(readme)) {
    failures.push('README is missing the live-session hook');
  }
  if (!readme.includes('docs/pk-324-board.md')) {
    failures.push('README must link the engineer grid at docs/pk-324-board.md');
  }
  if (!readme.includes('./bin/chrome-cdp doctor') || !readme.includes('./bin/chrome-cdp list')) {
    failures.push('README Quick Start must stay doctor → list');
  }
  if (!readme.includes('INTEGRATIONS.md') && !readme.includes('docs/integrations/')) {
    failures.push('README is missing cross-host integrations entry point');
  }
  if (!/\bMIT\b/.test(readme) || !readme.includes('LICENSE')) {
    failures.push('README is missing license');
  }
  if (/\bmean wall\b|\baveraged time\b|\bavg wall\b/i.test(readme) && !/not averaged/i.test(readme)) {
    failures.push('README must not average time across heterogeneous jobs');
  }
  if (readme.includes('<th colspan="4">chrome-cdp-ex</th>')
    || readme.includes('<th>success</th>')
    || /<td>PASS<\/td><td>1<\/td><td>139<\/td><td>62<\/td>/.test(readme)) {
    failures.push('README must not keep the ten-row lab table');
  }
  if (readme.includes('156 ms') || /page\.content\(\)/.test(readme)) {
    failures.push('README must not invent Playwright timings');
  }
  if (/cloud.?vm|connectOverCDP|\b9224\b/i.test(readme)) {
    failures.push('README must not add a cloud-VM wall');
  }
  if (readme.includes('## Five success cases') || readme.includes('### Promotion checklist') || readme.includes('commands-81')) {
    failures.push('README must not restore the command-catalog first screen');
  }
  if (readme.includes('#sp_message_container_1476394') || readme.includes('empty `innerText`')) {
    failures.push('README must not restore the overlay/PDF caution wall; keep those notes on docs/pk-324-board.md');
  }
  if (Object.hasOwn(extras, 'pkBoard')) failures.push(...checkPk324BoardContract(extras.pkBoard || ''));
  if (Object.hasOwn(extras, 'pkCharts')) failures.push(...checkPk324ChartContract(extras.pkCharts || {}));
  if (Object.hasOwn(extras, 'pkScoreboard')) failures.push(...checkPk324ScoreboardContract(extras.pkScoreboard || ''));
  return failures;
}

function commandCatalogText(docs) {
  return [
    docs.reference || '',
    docs.skillCommands || '',
    docs.commands || '',
  ].join('\n');
}

export function checkCommandCardContract(docs, commands) {
  const failures = [];
  const skill = docs.skill || '';
  const catalog = commandCatalogText(docs);
  for (const command of commands) {
    const names = [command.name, ...(command.aliases || [])];
    if (isSurvivorCommand(command.name)) {
      if (!names.some(name => mentionsCommand(skill, name))) {
        failures.push(`Always-loaded SKILL.md is missing survivor command: ${command.name}`);
      }
      continue;
    }
    if (!names.some(name => catalog.includes(name))) {
      failures.push(`Missing leftover command docs for ${command.name} (references/commands.md or docs/reference.md)`);
    }
  }
  return failures;
}

export function checkDocsContract(docs, commands) {
  const failures = [];

  failures.push(...checkCommandCardContract(docs, commands));
  failures.push(...checkSkillGoldenPathContract(docs.skill || ''));
  failures.push(...checkDefaultHelpContract(T.helpStr()));

  failures.push(...checkReadmeFaceContract(docs.readme || '', {
    ...(Object.hasOwn(docs, 'pkBoard') ? { pkBoard: docs.pkBoard || '' } : {}),
    ...(Object.hasOwn(docs, 'pkCharts') ? { pkCharts: docs.pkCharts || {} } : {}),
    ...(Object.hasOwn(docs, 'pkScoreboard') ? { pkScoreboard: docs.pkScoreboard || '' } : {}),
  }));

  const requiredKillerPathTerms = [
    'TL;DR',
    'doctor',
    'list',
    'open',
    'perceive',
    'click',
    'fill',
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
  failures.push(...checkWorkstreamVerificationContract(docs));
  return failures;
}

function readOptional(path) {
  try {
    return readFileSync(resolve(ROOT_DIR, path), 'utf8');
  } catch {
    return '';
  }
}

function readDocs() {
  const read = path => readFileSync(resolve(ROOT_DIR, path), 'utf8');
  const pkCharts = {};
  for (const [face, rel] of Object.entries(PK_324_CHART_FILES)) {
    pkCharts[face] = readOptional(rel);
  }
  return {
    readme: read('README.md'),
    reference: read('docs/reference.md'),
    pkBoard: read('docs/pk-324-board.md'),
    pkCharts,
    pkScoreboard: readOptional(PK_324_SCOREBOARD_FILE),
    selfImprovementLoop: read('docs/self-improvement-loop.md'),
    skill: read('skills/chrome-cdp-ex/SKILL.md'),
    skillCommands: readOptional('skills/chrome-cdp-ex/references/commands.md'),
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
  console.log(`Docs contract OK: ${SURVIVOR_COMMANDS.length} survivor commands on the card (${T.COMMANDS.length} catalog)`);
}
