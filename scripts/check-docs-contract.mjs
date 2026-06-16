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

  return failures;
}

export function checkDocsContract(docs, commands) {
  const failures = [];

  for (const command of commands) {
    const names = [command.name, ...(command.aliases || [])];
    const appearsInReadme = names.some(name => docs.readme.includes(name));
    const appearsInSkill = names.some(name => docs.skill.includes(name));
    if (!appearsInReadme || !appearsInSkill) {
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
  return failures;
}

function readDocs() {
  const read = path => readFileSync(path, 'utf8');
  return {
    readme: read('README.md'),
    skill: read('skills/chrome-cdp-ex/SKILL.md'),
    killerPath: read('docs/examples/killer-path.md'),
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
