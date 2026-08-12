import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { checkDocsContract, validateKillerPathContract } from '../scripts/check-docs-contract.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
const selfImprovementLoop = readFileSync(new URL('../docs/self-improvement-loop.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
const killerPath = readFileSync(new URL('../docs/examples/killer-path.md', import.meta.url), 'utf8');
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const pluginManifest = readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8');
const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const runtimeV3ArchitectureUrl = new URL('../docs/architecture/runtime-v3.md', import.meta.url);
const runtimeV3AdrUrl = new URL('../docs/adr/0001-runtime-v3-contract-first-strangler.md', import.meta.url);
const runtimeV3FinalAdrUrl = new URL('../docs/adr/0003-runtime-v3-application-dispatch.md', import.meta.url);
const publicContractsReadmeUrl = new URL('../docs/contracts/README.md', import.meta.url);

describe('Killer Path docs contract', () => {
  it('runs by absolute script path without depending on caller cwd', () => {
    const script = fileURLToPath(new URL('../scripts/check-docs-contract.mjs', import.meta.url));
    const child = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('Docs contract OK: 81 commands checked');
  });

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
      selfImprovementLoop,
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
      selfImprovementLoop,
      skill,
      killerPath,
      packageJson,
      pluginManifest: pluginManifest.replace(/"version":\s*"[^"]+"/, '"version": "0.0.0"'),
      claude,
      contributing,
      design,
    };

    expect(checkDocsContract(docs, [])).toContain(
      `Release metadata version mismatch: package.json ${packageVersion} != .claude-plugin/plugin.json 0.0.0`,
    );
  });

  it('rejects stale contributor paths, obsolete line counts, and shipped features marked future', () => {
    const docs = {
      readme,
      reference,
      selfImprovementLoop,
      skill,
      killerPath,
      packageJson,
      pluginManifest,
      claude: `${claude}\n- Single-file implementation: ~2400 lines`,
      contributing: contributing.replaceAll('skills/chrome-cdp-ex/scripts/cdp.mjs', 'skills/chrome-cdp/scripts/cdp.mjs'),
      design: `${design}\n| \`emulate\`, \`frame\`, \`components\` | Future |`,
    };

    expect(checkDocsContract(docs, [])).toEqual(expect.arrayContaining([
      'CLAUDE.md contains an obsolete single-file or line-count claim',
      'CONTRIBUTING.md contains stale path: skills/chrome-cdp/scripts/cdp.mjs',
      'DESIGN.md marks shipped features as Future',
    ]));
  });

  it('allows command reference details outside the README', () => {
    const skillCorpus = [
      skill,
      readFileSync(new URL('../skills/chrome-cdp-ex/references/commands.md', import.meta.url), 'utf8'),
    ].join('\n');
    const docs = {
      readme: readme.replaceAll('mock', ''),
      reference,
      selfImprovementLoop,
      skill: skillCorpus,
      killerPath,
    };

    expect(checkDocsContract(docs, [{ name: 'mock', aliases: [] }])).not.toContain(
      'Missing command docs for mock',
    );
  });

  it('requires the self-improvement loop runbook to cover issue, test, review, and merge commands', () => {
    const docs = {
      readme,
      reference,
      selfImprovementLoop: selfImprovementLoop.replace('gh issue create', 'gh issue draft'),
      skill,
      killerPath,
    };

    expect(checkDocsContract(docs, [])).toContain(
      'Self-improvement loop runbook is missing: gh issue create',
    );
  });
});

describe('Repository release gates', () => {
  it('ships the Runtime v3 contract source of truth and fixture policy', () => {
    const files = JSON.parse(packageJson).files;

    expect(existsSync(runtimeV3ArchitectureUrl)).toBe(true);
    expect(existsSync(runtimeV3AdrUrl)).toBe(true);
    expect(existsSync(runtimeV3FinalAdrUrl)).toBe(true);
    expect(existsSync(publicContractsReadmeUrl)).toBe(true);
    expect(files).toEqual(expect.arrayContaining([
      'docs/architecture/runtime-v3.md',
      'docs/adr/0001-runtime-v3-contract-first-strangler.md',
      'docs/adr/0003-runtime-v3-application-dispatch.md',
      'docs/contracts/',
    ]));
    const architecture = readFileSync(runtimeV3ArchitectureUrl, 'utf8');
    expect(architecture).toMatch(/representative browser-independent CLI\s+exit and error behavior/);
    expect(architecture).toContain('68 application handlers');
    expect(architecture).toContain('13 targetless CLI adapters');
    expect(architecture).toContain('five daemon protocol groups');
    expect(architecture).toContain('Intentional compatibility components retained');
    expect(architecture).toContain('None is retained merely as a fallback');
    expect(architecture).toContain('currently implements public `browser`, `page`, and `frame` resources');
    expect(architecture).toMatch(/Future graph extensions may add\s+browser contexts, DOM\/accessibility nodes/);
    expect(architecture).not.toContain('remaining target architecture');
    expect(architecture).not.toContain('77 explicitly enumerated legacy command routes');
  });

  it('keeps Phase 1 host evidence historical while promoting only the exact-tree runtime benchmark', () => {
    const codexIntegration = readFileSync(new URL('../docs/integrations/codex.md', import.meta.url), 'utf8');
    const codexKillerPath = readFileSync(new URL('../docs/examples/codex-killer-path.md', import.meta.url), 'utf8');

    for (const surface of [readme, codexIntegration, codexKillerPath]) {
      expect(surface).toContain('Phase 1 candidate');
    }
    expect(readme).toContain('historical for the current tree');
    expect(readme).toContain('current Runtime v3 benchmark');
    const benchmark = readFileSync(new URL('../experiment/benchmark.html', import.meta.url), 'utf8');
    expect(benchmark).toContain('Smart Eye benchmark · latest measured release');
    expect(benchmark).not.toContain('historical for current tree');
  });

  it('runs CI for pull requests targeting main and dev', () => {
    expect(ciWorkflow).toMatch(/pull_request:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\bdev\b[^\]]*\]/);
  });

  it('runs the docs contract in CI', () => {
    expect(ciWorkflow).toContain('npm run check:docs');
  });

  it('publishes the versioned changelog narrative instead of generated commit notes', () => {
    expect(releaseWorkflow).toContain('CHANGELOG.md');
    expect(releaseWorkflow).toContain('--notes-file');
    expect(releaseWorkflow).not.toContain('--generate-notes');
  });

  it('validates host evidence and the actual tarball before attaching a release', () => {
    expect(releaseWorkflow).toContain('npm ci');
    expect(releaseWorkflow).toContain('npm run check:host-validation');
    expect(releaseWorkflow).toContain('npm run check:contracts');
    expect(releaseWorkflow).toContain('npm pack');
    expect(releaseWorkflow).toContain('npm run check:contracts -- --tarball "$TARBALL"');
    expect(releaseWorkflow).toContain('npm run check:release-package -- "$TARBALL"');
    expect(releaseWorkflow).toContain("node-version: '22'");
    expect(releaseWorkflow).toMatch(/gh release create "\$TAG" "\$TARBALL"/);
  });
});

describe('Codex for OSS evidence baseline', () => {
  it('records dated, claim-safe maintenance and ecosystem evidence', () => {
    const evidence = readFileSync(new URL('../docs/outreach/codex-for-oss-evidence.md', import.meta.url), 'utf8');

    for (const expected of [
      '2026-08-12',
      '12 stars',
      '84 issues',
      '55 pull requests',
      '18 releases',
      '16 cumulative `.tgz` downloads',
      '0 downloads for `v2.15.0` immediately after publication',
      '71 views / 41 unique visitors',
      '41 unique visitors',
      '79 clones / 51 unique cloners',
      '51 unique cloners',
      '22 GitHub code-search references',
      '52,197 stars and 4,559 forks',
      'v2.15.0',
      'historically `live-validated`',
      'not a full six-host installation test',
      'https://openai.com/form/codex-for-oss/',
      'https://github.com/EndeavorYen/chrome-cdp-ex/pull/125',
    ]) {
      expect(evidence).toContain(expected);
    }
    expect(evidence).toMatch(/mirrors? or indexes?/i);
    expect(evidence).toMatch(/not.*adoption/i);
  });
});
