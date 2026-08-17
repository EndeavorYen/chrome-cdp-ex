#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { generateCommandSurfaces } from './generate-command-surfaces.mjs';
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

export { LOCKED_PK_BOARD };
export const LOCKED_LIVE_SESSION_BOARD = LOCKED_PK_BOARD;

export const README_FIRST_SCREEN_MARKERS = Object.freeze([
  ['cool', 'codex-killer-path-demo-poster.png', 'Cool visual (poster / 60-second demo)'],
  ['advantage', '## The tab you already have', 'project advantage'],
  ['comparison', '## 10 jobs. Who finishes.', 'comparison PK table'],
  ['scoreboard', 'experiment/pk-324-scoreboard.svg', 'PK scoreboard SVG'],
  ['charts', 'experiment/pk-324-steps.svg', 'PK bar charts below the scoreboard'],
  ['demo', '## Demo', 'demo links'],
  ['quickstart', '## Quick start', 'Quick Start'],
]);

function markerIndex(text, marker) {
  return text.indexOf(marker);
}

export function checkReadmeFirstScreenOrder(readme) {
  const failures = [];
  let cursor = -1;
  for (const [id, marker, label] of README_FIRST_SCREEN_MARKERS) {
    const index = markerIndex(readme, marker);
    if (index === -1) {
      failures.push(`README first screen is missing ${id}: ${label}`);
      continue;
    }
    if (index < cursor) {
      failures.push(`README first screen is out of order: ${label} must follow the previous locked section`);
    }
    cursor = index;
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
    if (actual !== expected) {
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

function comparisonSection(readme) {
  const start = readme.search(/^## 10 jobs\. Who finishes\./m);
  const end = readme.search(/^## Demo\b/m);
  if (start === -1) return '';
  return end > start ? readme.slice(start, end) : readme.slice(start);
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
  if (actual && actual !== expected) {
    failures.push(`${PK_324_SCOREBOARD_FILE} does not match the locked scoreboard`);
  }
  if (!actual) {
    failures.push(`Missing PK scoreboard ${PK_324_SCOREBOARD_FILE}`);
  }
  return failures;
}

export function checkReadmePkTableContract(readme) {
  const failures = [];
  const section = comparisonSection(readme);
  if (!section) {
    failures.push('README comparison heading must stay ## 10 jobs. Who finishes.');
    return failures;
  }
  if (!section.includes(PK_324_SCOREBOARD_FILE)) {
    failures.push('README comparison first glance must be the PK scoreboard SVG');
  }
  if (!/chrome-cdp-ex[\s\S]{0,120}Browser Use[\s\S]{0,120}Playwright/.test(section)) {
    failures.push('README PK table columns must be chrome-cdp-ex | Browser Use | Playwright');
  }

  const scoreboardIdx = section.indexOf(PK_324_SCOREBOARD_FILE);
  const chartIdx = section.indexOf('experiment/pk-324-steps.svg');
  if (chartIdx !== -1 && scoreboardIdx !== -1 && chartIdx < scoreboardIdx) {
    failures.push('README bar charts must sit below the PK scoreboard SVG, not first glance');
  }

  if (/PASS\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+/.test(readme)
    || /FAIL\s*\/\s*\d+\s*\/\s*\d+\s*\/\s*\d+/.test(readme)) {
    failures.push('README must not keep engineer mashup cells (success / steps / time / token)');
  }

  if (/^\s*\|[^\n]*\b(?:PASS|FAIL)\b[^\n]*\|/m.test(readme)
    || /^\s*\|\s*\|?\s*chrome-cdp-ex\s*\|\s*Browser Use\s*\|\s*Playwright\s*\|/m.test(readme)
    || /^\s*\|\s*job\s*\|/m.test(readme)) {
    failures.push('README must not keep a markdown PK grid as the first-glance comparison');
  }

  if (!/steps\s*\/\s*token\s*\/\s*wall\s*ms/i.test(section)) {
    failures.push('README PK table must label job cells as steps / token / wall ms');
  }
  if (/\bcost\b|\bcp\b/i.test(section)) {
    failures.push('README PK table must not add a cost/cp column');
  }
  return failures;
}

export function checkReadmeFaceContract(readme, extras = {}) {
  const failures = [];
  failures.push(...checkReadmeFirstScreenOrder(readme));
  failures.push(...checkReadmePkTableContract(readme));
  if (!/browser you already have open/i.test(readme)) {
    failures.push('README is missing the live-session hook');
  }
  if (!/one step/i.test(readme) || !/short receipt|skinny/i.test(readme)) {
    failures.push('README is missing the one-step receipt face');
  }
  if (!readme.includes(LOCKED_PK_BOARD.date) || !readme.includes(LOCKED_PK_BOARD.sha)) {
    failures.push(`README is missing the locked live-session board identity (${LOCKED_PK_BOARD.date} / ${LOCKED_PK_BOARD.sha})`);
  }
  for (const face of PK_324_CHART_FACES) {
    if (!readme.includes(PK_324_CHART_FILES[face])) {
      failures.push(`README is missing the ${face} PK chart ${PK_324_CHART_FILES[face]}`);
    }
  }
  if (!readme.includes('docs/pk-324-board.md')) {
    failures.push('README must link the engineer grid at docs/pk-324-board.md');
  }
  if (!readme.includes('experiment/codex-killer-path-demo.mp4')
    || !readme.includes('experiment/codex-killer-path-demo-poster.png')) {
    failures.push('README Cool section must restore the clickable Codex poster / 60-second demo');
  }
  if (!readme.includes('experiment/showcase.html')
    || !readme.includes('experiment/codex-killer-path-demo.html')
    || !readme.includes('experiment/benchmark.html')) {
    failures.push('README Demo section must link showcase, killer-path demo, and benchmark pages');
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
  for (const slower of LOCKED_PK_BOARD.slowerThanBrowserUse) {
    if (!readme.includes(`${slower.cdp} vs ${slower.browserUse}`)) {
      failures.push(`README must draw the slower wall-clock pair ${slower.job} (${slower.cdp} vs ${slower.browserUse}) honestly`);
    }
  }
  if (!/playwright.{0,80}(faster|quicker)|(faster|quicker).{0,80}playwright/is.test(readme)) {
    failures.push('README must admit Playwright is faster on wall-clock for some jobs');
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
  const pkCharts = {};
  for (const [face, rel] of Object.entries(PK_324_CHART_FILES)) {
    try {
      pkCharts[face] = read(rel);
    } catch {
      pkCharts[face] = '';
    }
  }
  let pkScoreboard = '';
  try {
    pkScoreboard = read(PK_324_SCOREBOARD_FILE);
  } catch {
    pkScoreboard = '';
  }
  return {
    readme: read('README.md'),
    reference: read('docs/reference.md'),
    pkBoard: read('docs/pk-324-board.md'),
    pkCharts,
    pkScoreboard,
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
