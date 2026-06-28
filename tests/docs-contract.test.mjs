import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { checkDocsContract, validateKillerPathContract } from '../scripts/check-docs-contract.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
const killerPath = readFileSync(new URL('../docs/examples/killer-path.md', import.meta.url), 'utf8');
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const pluginManifest = readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

describe('Killer Path docs contract', () => {
  it('accepts the documented first-run golden path', () => {
    expect(validateKillerPathContract(killerPath)).toEqual([]);
  });

  it('requires since-action evidence before the session report', () => {
    const reportTooEarly = killerPath.replace(
      'node skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action\nnode skills/chrome-cdp-ex/scripts/cdp.mjs report <target>',
      'node skills/chrome-cdp-ex/scripts/cdp.mjs report <target>\nnode skills/chrome-cdp-ex/scripts/cdp.mjs perceive <target> --since-action',
    );

    expect(validateKillerPathContract(reportTooEarly)).toContain(
      'Killer Path command sequence is missing or out of order: report after perceive --since-action',
    );
  });

  it('requires an explicit form-fill action alternative', () => {
    const withoutFill = killerPath.replace(
      /For forms[\s\S]+?```bash[\s\S]+?```/,
      'For forms, keep using the same action line.',
    );

    expect(validateKillerPathContract(withoutFill)).toContain(
      'Killer Path is missing form-fill alternative command',
    );
  });

  it('requires recovery, CSS tracing, replay, and export handoff examples', () => {
    const withoutPromotionWorkflow = killerPath
      .replace(/node skills\/chrome-cdp-ex\/scripts\/cdp\.mjs click <target> "#missing" --format json\n/g, '')
      .replace(/node skills\/chrome-cdp-ex\/scripts\/cdp\.mjs cascade <target> @ref background-color --format json\n/g, '')
      .replace(/node skills\/chrome-cdp-ex\/scripts\/cdp\.mjs record-actions <target> --format json\n/g, '')
      .replace(/node skills\/chrome-cdp-ex\/scripts\/cdp\.mjs replay <target> --file record-actions\.json --format json\n/g, '')
      .replace(/node skills\/chrome-cdp-ex\/scripts\/cdp\.mjs export-playwright <target> --format json\n/g, '');

    expect(validateKillerPathContract(withoutPromotionWorkflow)).toEqual(expect.arrayContaining([
      'Killer Path example is missing failed-action recovery command',
      'Killer Path example is missing CSS tracing command',
      'Killer Path example is missing record-actions handoff command',
      'Killer Path example is missing replay handoff command',
      'Killer Path example is missing export-playwright handoff command',
    ]));
  });

  it('requires README promotion claims to be benchmark-gated', () => {
    const docsWithoutChecklist = {
      readme: readme.replace(/### Promotion checklist[\s\S]+?(?=\n### |\n## |$)/, ''),
      reference,
      skill,
      killerPath,
    };

    expect(checkDocsContract(docsWithoutChecklist, [])).toEqual(expect.arrayContaining([
      'README is missing benchmark-gated promotion checklist',
      'README promotion checklist must block claims when benchmark gates fail',
    ]));
  });

  it('documents a checked-in measured baseline artifact for comparison reruns', () => {
    expect(readme).toContain('docs/benchmarks/measured-baselines.example.json');
    expect(reference).toContain('docs/benchmarks/measured-baselines.example.json');
  });

  it('requires package and plugin manifest versions to match', () => {
    const packageVersion = JSON.parse(packageJson).version;
    const docs = {
      readme,
      reference,
      skill,
      killerPath,
      packageJson,
      pluginManifest: pluginManifest.replace(/"version":\s*"[^"]+"/, '"version": "0.0.0"'),
    };

    expect(checkDocsContract(docs, [])).toContain(
      `Release metadata version mismatch: package.json ${packageVersion} != .claude-plugin/plugin.json 0.0.0`,
    );
  });

  it('allows command reference details outside the README', () => {
    const docs = {
      readme: readme.replaceAll('mock', ''),
      reference,
      skill,
      killerPath,
    };

    expect(checkDocsContract(docs, [{ name: 'mock', aliases: [] }])).not.toContain(
      'Missing command docs for mock',
    );
  });
});

describe('Repository release gates', () => {
  it('runs CI for pull requests targeting main and dev', () => {
    expect(ciWorkflow).toMatch(/pull_request:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\bdev\b[^\]]*\]/);
  });

  it('runs the docs contract in CI', () => {
    expect(ciWorkflow).toContain('npm run check:docs');
  });
});
