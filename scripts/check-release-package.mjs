#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { statSync } from 'fs';
import { basename, posix, resolve } from 'path';
import { fileURLToPath } from 'url';

export const REQUIRED_RELEASE_ENTRIES = [
  'package/.claude-plugin/plugin.json',
  'package/INTEGRATIONS.md',
  'package/bin/chrome-cdp',
  'package/docs/benchmarks/host-validation.v1.json',
  'package/docs/architecture/runtime-v3.md',
  'package/docs/adr/0001-runtime-v3-contract-first-strangler.md',
  'package/docs/adr/0003-runtime-v3-application-dispatch.md',
  'package/docs/contracts/README.md',
  'package/docs/contracts/v2.15.0/public-contracts.v1.json',
  'package/docs/contracts/v2.15.0/package-entries.v1.json',
  'package/docs/contracts/v2.15.0/runtime-dispatch.v1.json',
  'package/docs/contracts/v2.16.0/public-contracts.v1.json',
  'package/docs/contracts/v2.16.0/package-entries.v1.json',
  'package/docs/contracts/v2.16.0/runtime-dispatch.v1.json',
  'package/docs/contracts/v2.17.0/public-contracts.v1.json',
  'package/docs/contracts/v2.17.0/package-entries.v1.json',
  'package/docs/contracts/v2.17.0/runtime-dispatch.v1.json',
  'package/docs/examples/codex-killer-path.md',
  'package/experiment/codex-killer-path-demo-poster.png',
  'package/experiment/codex-killer-path-demo.html',
  'package/experiment/codex-killer-path-demo.mp4',
  'package/scripts/check-host-validation.mjs',
  'package/scripts/check-release-package.mjs',
  'package/scripts/check-public-contracts.mjs',
  'package/scripts/setup.mjs',
  'package/README.md',
  'package/package.json',
  'package/skills/chrome-cdp-ex/SKILL.md',
  'package/skills/chrome-cdp-ex/scripts/cdp.mjs',
  'package/skills/chrome-cdp-ex/scripts/mcp-server.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/action-evidence.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/action-receipt-surfaces.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/command-application.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/command-surface.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/daemon-action-handlers.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/page-health.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/pdf-text.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/perception-model.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/responsive-audit.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/screenshot-health.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/session-report.mjs',
  'package/skills/chrome-cdp-ex/scripts/lib/target-binding.mjs',
];

export function validateReleaseEntries(entries) {
  const available = new Set(entries);
  return REQUIRED_RELEASE_ENTRIES.filter(entry => !available.has(entry));
}

export function validatePackageInventory(entries, fixture, packageVersion) {
  const errors = [];
  if (fixture?.schema !== 'chrome-cdp-ex.package-entries.v1') {
    return ['Release package inventory has an invalid or missing schema'];
  }
  if (fixture.productVersion !== packageVersion) {
    return [`Release package inventory version mismatch: fixture ${fixture.productVersion} != package ${packageVersion}`];
  }
  if (!Array.isArray(fixture.entries)) {
    return ['Release package inventory entries must be an array'];
  }
  const expected = [...fixture.entries];
  const canonical = [...new Set(expected)].sort();
  if (JSON.stringify(expected) !== JSON.stringify(canonical)) {
    return ['Release package inventory fixture entries must be unique and sorted'];
  }
  const actualEntries = entries.filter(entry => !entry.endsWith('/'));
  if (new Set(actualEntries).size !== actualEntries.length) {
    errors.push('Release package inventory contains duplicate file entries');
  }
  const actual = [...new Set(actualEntries)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const entry of expected) {
    if (!actualSet.has(entry)) errors.push(`Release package inventory is missing entry: ${entry}`);
  }
  for (const entry of actual) {
    if (!expectedSet.has(entry)) errors.push(`Release package inventory has unexpected entry: ${entry}`);
  }
  return errors;
}

export function listTarEntries(tarballPath) {
  const listed = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  if (listed.status !== 0) {
    const detail = listed.stderr.trim() || `tar exited with status ${listed.status}`;
    return { entries: [], error: detail };
  }
  return {
    entries: listed.stdout.split('\n').map(line => line.trim()).filter(line => line && !line.endsWith('/')).sort(),
    error: null,
  };
}

function extractTarText(tarballPath, entry) {
  const extracted = spawnSync('tar', ['-xOzf', tarballPath, entry], { encoding: 'utf8' });
  if (extracted.status !== 0) {
    const detail = extracted.stderr.trim() || `tar exited with status ${extracted.status}`;
    return { text: '', error: detail };
  }
  return { text: extracted.stdout, error: null };
}

function readmeTargets(readme) {
  const targets = [];
  const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g;
  const htmlLink = /\b(?:href|src)="([^"]+)"/g;
  for (const pattern of [markdownLink, htmlLink]) {
    for (const match of readme.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

function packagedReadmeTarget(target) {
  const value = target.trim().replace(/^<|>$/g, '');
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }
  const pathOnly = value.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  const packaged = posix.normalize(posix.join('package', pathOnly));
  return packaged.startsWith('package/') ? packaged : false;
}

export function validateReadmeLinks(entries, readme) {
  const available = new Set(entries.map(entry => entry.replace(/\/$/, '')));
  const missing = new Set();
  for (const target of readmeTargets(readme)) {
    const packaged = packagedReadmeTarget(target);
    if (packaged === false) {
      missing.add(`README relative link escapes release package: ${target}`);
      continue;
    }
    if (packaged && !available.has(packaged)) missing.add(packaged);
  }
  return [...missing]
    .sort()
    .map(entry => entry.startsWith('README ')
      ? entry
      : `README relative link is missing from release package: ${entry}`);
}

export function inspectReleasePackage(tarballPath) {
  const resolvedPath = resolve(tarballPath);
  try {
    if (!statSync(resolvedPath).isFile()) {
      return { errors: [`Release package is not a file: ${resolvedPath}`], resolvedPath };
    }
  } catch {
    return { errors: [`Release package does not exist: ${resolvedPath}`], resolvedPath };
  }

  const listed = listTarEntries(resolvedPath);
  if (listed.error) {
    const detail = listed.error;
    return { errors: [`Unable to list release package ${resolvedPath}: ${detail}`], resolvedPath };
  }

  const entries = listed.entries;
  const errors = validateReleaseEntries(entries).map(
    entry => `Release package is missing required entry: ${entry}`,
  );
  if (entries.includes('package/README.md')) {
    const extractedReadme = extractTarText(resolvedPath, 'package/README.md');
    if (extractedReadme.error) {
      const detail = extractedReadme.error;
      errors.push(`Unable to read packaged README.md: ${detail}`);
    } else {
      errors.push(...validateReadmeLinks(entries, extractedReadme.text));
    }
  }
  if (entries.includes('package/package.json')) {
    const packageJson = extractTarText(resolvedPath, 'package/package.json');
    if (packageJson.error) {
      errors.push(`Unable to read packaged package.json: ${packageJson.error}`);
    } else {
      try {
        const packageVersion = JSON.parse(packageJson.text).version;
        const inventoryPath = `package/docs/contracts/v${packageVersion}/package-entries.v1.json`;
        const inventory = extractTarText(resolvedPath, inventoryPath);
        if (inventory.error) {
          errors.push(`Unable to read packaged inventory ${inventoryPath}: ${inventory.error}`);
        } else {
          errors.push(...validatePackageInventory(entries, JSON.parse(inventory.text), packageVersion));
        }
      } catch (error) {
        errors.push(`Unable to validate packaged inventory: ${error.message}`);
      }
    }
  }
  return { errors, resolvedPath };
}

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node scripts/check-release-package.mjs <tarball.tgz>');
    process.exitCode = 1;
    return;
  }

  const result = inspectReleasePackage(args[0]);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Release package OK: ${REQUIRED_RELEASE_ENTRIES.length} required entries in ${basename(result.resolvedPath)}`,
  );
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main(process.argv.slice(2));
