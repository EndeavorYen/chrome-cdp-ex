#!/usr/bin/env node
import { readFileSync } from 'fs';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const read = path => readFileSync(path, 'utf8');
const docs = {
  readme: read('README.md'),
  skill: read('skills/chrome-cdp-ex/SKILL.md'),
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

if (failures > 0) process.exit(1);
console.log(`Docs contract OK: ${T.COMMANDS.length} commands checked`);
