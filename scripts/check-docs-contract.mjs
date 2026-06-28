#!/usr/bin/env node
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

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

function checkReleaseMetadataContract(docs) {
  const failures = [];
  if (!docs.packageJson && !docs.pluginManifest) return failures;

  const packageModel = docs.packageJson ? parseJsonDoc(docs.packageJson, 'package.json', failures) : null;
  const pluginModel = docs.pluginManifest ? parseJsonDoc(docs.pluginManifest, '.claude-plugin/plugin.json', failures) : null;
  if (!packageModel || !pluginModel) return failures;

  if (packageModel.version !== pluginModel.version) {
    failures.push(`Release metadata version mismatch: package.json ${packageModel.version} != .claude-plugin/plugin.json ${pluginModel.version}`);
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

  if (!docs.readme.includes('Playwright is') || !docs.readme.includes('live-page perception')) {
    failures.push('README is missing product positioning language');
  }

  const requiredReadmeSections = [
    '## Use this when',
    '## Do not use this when',
    '## Five success cases',
    '### Latest dogfood snapshot',
  ];
  for (const section of requiredReadmeSections) {
    if (!docs.readme.includes(section)) {
      failures.push(`README is missing first-impression section: ${section}`);
    }
  }

  const requiredSuccessCases = [
    'Logged-in dashboard inspection',
    'Action evidence after form input',
    'CSS source tracing',
    'Long-session debugging',
    'Workflow capture and replay',
  ];
  for (const item of requiredSuccessCases) {
    if (!docs.readme.includes(item)) {
      failures.push(`README is missing success case: ${item}`);
    }
  }

  const requiredBenchmarkProof = [
    'Total time',
    'Action evidence coverage',
    'Stale-ref recovery',
    'Quality gate',
  ];
  for (const item of requiredBenchmarkProof) {
    if (!docs.readme.includes(item)) {
      failures.push(`README is missing dogfood benchmark proof: ${item}`);
    }
  }

  if (!docs.readme.includes('docs/examples/killer-path.md')) {
    failures.push('README is missing a first-run Killer Path example link');
  }
  if (!docs.readme.includes('### Promotion checklist')) {
    failures.push('README is missing benchmark-gated promotion checklist');
  }
  if (!docs.readme.includes('gate.passed') || !docs.readme.includes('block promotion')) {
    failures.push('README promotion checklist must block claims when benchmark gates fail');
  }
  if (!docs.readme.includes('heuristic-smoke-baseline') || !docs.readme.includes('--comparison-baselines')) {
    failures.push('README promotion checklist must require measured comparison baselines');
  }

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
  return failures;
}

function readDocs() {
  const read = path => readFileSync(path, 'utf8');
  return {
    readme: read('README.md'),
    reference: read('docs/reference.md'),
    skill: read('skills/chrome-cdp-ex/SKILL.md'),
    killerPath: read('docs/examples/killer-path.md'),
    packageJson: read('package.json'),
    pluginManifest: read('.claude-plugin/plugin.json'),
  };
}

export function runDocsContract() {
  return checkDocsContract(readDocs(), T.COMMANDS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = runDocsContract();
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exit(1);
  console.log(`Docs contract OK: ${T.COMMANDS.length} commands checked`);
}
