#!/usr/bin/env node
import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const read = path => readFileSync(path, 'utf8');
const docs = {
  readme: read('README.md'),
  skill: read('skills/chrome-cdp-ex/SKILL.md'),
  killerPath: read('docs/examples/killer-path.md'),
};

let failures = 0;

for (const command of T.COMMANDS) {
  const names = [command.name, ...(command.aliases || [])];
  const appearsInReadme = names.some(name => docs.readme.includes(name));
  const appearsInSkill = names.some(name => docs.skill.includes(name));
  if (!appearsInReadme || !appearsInSkill) {
    console.error(`Missing command docs for ${command.name}`);
    failures += 1;
  }
}

if (!docs.readme.includes('Playwright is') || !docs.readme.includes('live-page perception')) {
  console.error('README is missing product positioning language');
  failures += 1;
}

const requiredReadmeSections = [
  '## Use this when',
  '## Do not use this when',
  '## Five success cases',
  '### Latest dogfood snapshot',
];
for (const section of requiredReadmeSections) {
  if (!docs.readme.includes(section)) {
    console.error(`README is missing first-impression section: ${section}`);
    failures += 1;
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
    console.error(`README is missing success case: ${item}`);
    failures += 1;
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
    console.error(`README is missing dogfood benchmark proof: ${item}`);
    failures += 1;
  }
}

if (!docs.readme.includes('docs/examples/killer-path.md')) {
  console.error('README is missing a first-run Killer Path example link');
  failures += 1;
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
    console.error(`Killer Path example is missing: ${item}`);
    failures += 1;
  }
}

if (failures > 0) process.exit(1);
console.log(`Docs contract OK: ${T.COMMANDS.length} commands checked`);
