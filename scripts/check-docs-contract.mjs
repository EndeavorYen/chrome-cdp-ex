#!/usr/bin/env node
// Docs checks that protect agents, not wording: every command is documented, the
// default help lists the survivor commands, versions agree, changelog fragments
// parse, and generated command tables match command-surface.mjs.
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkChangelogFragments, loadChangelogTexts } from './changelog-fragments.mjs';
import { generateCommandSurfaces } from './generate-command-surfaces.mjs';
import { nextCommandsMissingFromAllowlist } from './check-next-run-command.mjs';
import { SURVIVOR_COMMANDS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

export { SURVIVOR_COMMANDS };

const SURVIVOR_SET = new Set(SURVIVOR_COMMANDS);

export function mentionsCommand(text, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text || '');
}

// Survivor commands must be on the always-loaded SKILL.md; every other command must
// be documented in references/commands.md or docs/reference.md.
export function checkCommandCardContract(docs, commands) {
  const failures = [];
  const skill = docs.skill || '';
  const catalog = [docs.reference || '', docs.skillCommands || ''].join('\n');
  for (const command of commands) {
    const names = [command.name, ...(command.aliases || [])];
    if (SURVIVOR_SET.has(command.name)) {
      if (!names.some(name => mentionsCommand(skill, name))) {
        failures.push(`Always-loaded SKILL.md is missing survivor command: ${command.name}`);
      }
      continue;
    }
    if (!names.some(name => catalog.includes(name))) {
      failures.push(`Missing command docs for ${command.name} (references/commands.md or docs/reference.md)`);
    }
  }
  return failures;
}

export function checkDefaultHelpContract(help) {
  const failures = [];
  for (const name of SURVIVOR_COMMANDS) {
    if (!mentionsCommand(help, name)) failures.push(`Default cdp help is missing survivor command: ${name}`);
  }
  return failures;
}

export function checkReleaseMetadataContract(docs) {
  const failures = [];
  let pkg;
  let plugin;
  try {
    pkg = JSON.parse(docs.packageJson);
    plugin = JSON.parse(docs.pluginManifest);
  } catch (error) {
    return [`package.json or .claude-plugin/plugin.json is not valid JSON: ${error.message}`];
  }
  if (pkg.version !== plugin.version) {
    failures.push(`Release metadata version mismatch: package.json ${pkg.version} != .claude-plugin/plugin.json ${plugin.version}`);
  }
  const published = docs.changelogPublished?.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  if (!published) return [...failures, 'CHANGELOG.md is missing the latest published semantic version'];
  if (!String(docs.readme || '').includes(`/releases/tag/v${published}`)) {
    failures.push(`README.md does not link the published release tag v${published}`);
  }
  return failures;
}

export function checkDocsContract(docs, commands, help) {
  return [
    ...checkCommandCardContract(docs, commands),
    ...checkDefaultHelpContract(help),
    ...checkReleaseMetadataContract(docs),
  ];
}

function readDocs() {
  const read = path => readFileSync(resolve(ROOT_DIR, path), 'utf8');
  return {
    readme: read('README.md'),
    reference: read('docs/reference.md'),
    skill: read('skills/chrome-cdp-ex/SKILL.md'),
    skillCommands: read('skills/chrome-cdp-ex/references/commands.md'),
    packageJson: read('package.json'),
    pluginManifest: read('.claude-plugin/plugin.json'),
    changelogPublished: loadChangelogTexts(ROOT_DIR).published,
  };
}

export function runDocsContract() {
  const failures = checkDocsContract(readDocs(), T.COMMANDS, T.helpStr());
  failures.push(...checkChangelogFragments(ROOT_DIR));
  try {
    generateCommandSurfaces({ rootDir: ROOT_DIR });
  } catch (error) {
    failures.push(error.message || String(error));
  }
  const missingNext = nextCommandsMissingFromAllowlist({ rootDir: ROOT_DIR });
  if (missingNext.length > 0) {
    failures.push(`Next hint names commands run_command does not accept: ${missingNext.join(', ')}`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = runDocsContract();
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exit(1);
  console.log(`Docs contract OK: ${SURVIVOR_COMMANDS.length} survivor commands on the card (${T.COMMANDS.length} catalog)`);
}
