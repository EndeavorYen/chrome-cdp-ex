import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { checkDocsContract, validateKillerPathContract } from '../scripts/check-docs-contract.mjs';
import { PK_324_CHART_FILES } from '../scripts/lib/pk-324-board.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
const selfImprovementLoop = readFileSync(new URL('../docs/self-improvement-loop.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
const killerPath = readFileSync(new URL('../docs/examples/killer-path.md', import.meta.url), 'utf8');
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const pluginManifest = readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const claude = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
const pkBoard = readFileSync(new URL('../docs/pk-324-board.md', import.meta.url), 'utf8');
const pkCharts = Object.fromEntries(Object.entries(PK_324_CHART_FILES).map(([face, rel]) => [
  face,
  readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'),
]));
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

  it('requires README to lead Cool → advantage → win score + charts → demo → Quick Start', () => {
    const docs = {
      readme,
      reference,
      pkBoard,
      pkCharts,
      selfImprovementLoop,
      skill,
      killerPath,
      packageJson,
      pluginManifest,
      changelog,
      claude,
      contributing,
      design,
    };

    expect(checkDocsContract(docs, [])).toEqual([]);
    expect(checkDocsContract({
      ...docs,
      readme: readme.replace(/22c525d4/g, 'deadbeef'),
    }, [])).toContain(
      'README is missing the locked live-session board identity (2026-08-17 / 22c525d4)',
    );
    expect(checkDocsContract({
      ...docs,
      readme: readme.replace('chrome-cdp-ex **10 PASS**', 'chrome-cdp-ex **9 PASS**'),
    }, [])).toContain('README win score must name chrome-cdp-ex 10 PASS, Browser Use 8 PASS, Playwright 9 PASS');
    expect(checkDocsContract({
      ...docs,
      readme: `${readme}\n<th colspan="4">chrome-cdp-ex</th>\n<th>success</th>\n<td>PASS</td><td>1</td><td>139</td><td>62</td>\n`,
    }, [])).toContain('README must not keep the ten-row lab table');
    expect(checkDocsContract({
      ...docs,
      pkBoard: pkBoard.replace('PASS / 1 / 139 / 62', 'PASS / 1 / 138 / 62'),
    }, [])).toContain('docs/pk-324-board.md is missing locked board cell: scroll to bottom (HF home) PASS / 1 / 139 / 62');
    expect(checkDocsContract({
      ...docs,
      readme: `${readme}\nPlaywright did the same click in 156 ms.\n`,
    }, [])).toContain('README must not invent Playwright timings');
    expect(checkDocsContract({
      ...docs,
      readme: `${readme}\n## Five success cases\n`,
    }, [])).toContain('README must not restore the command-catalog first screen');
  });

  it('documents a checked-in measured baseline artifact for comparison reruns', () => {
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
      changelog,
      claude,
      contributing,
      design,
    };

    expect(checkDocsContract(docs, [])).toContain(
      `Release metadata version mismatch: package.json ${packageVersion} != .claude-plugin/plugin.json 0.0.0`,
    );
  });

  it('keeps an unreleased package candidate separate from pinned published release links', () => {
    const docs = {
      readme,
      reference,
      selfImprovementLoop,
      skill,
      killerPath,
      packageJson,
      pluginManifest,
      changelog,
      claude,
      contributing,
      design,
    };

    expect(checkDocsContract(docs, [])).toEqual([]);
    expect(checkDocsContract({
      ...docs,
      readme: readme.replace(/^> \*\*Unreleased candidate:\*\*.*\n/m, ''),
    }, [])).toContain(
      'README.md must identify v2.16.0 as an unreleased candidate while v2.15.0 remains published',
    );
    expect(checkDocsContract({
      ...docs,
      readme: docs.readme
        .replaceAll('v2.15.0', 'v2.16.0')
        .replaceAll('pi-chrome-cdp-2.15.0.tgz', 'pi-chrome-cdp-2.16.0.tgz'),
    }, [])).toEqual(expect.arrayContaining([
      'README.md is missing the published release tag v2.15.0',
      'README.md is missing the published release tarball pi-chrome-cdp-2.15.0.tgz',
      'README.md must not fabricate an unreleased release tag v2.16.0',
      'README.md must not fabricate an unreleased tarball pi-chrome-cdp-2.16.0.tgz',
    ]));
    expect(checkDocsContract({
      ...docs,
      changelog: changelog.replace('## [2.15.0]', '## [9.8.7]'),
    }, [])).toContain('README.md is missing the published release tag v9.8.7');

    for (const falseClaim of [
      '[![Release v2.16.0](https://img.shields.io/badge/release-v2.15.0-brightgreen)]',
      '**Pinned release (v2.16.0):**',
      'Latest measured release: v2.16.0 passed 10/10 rounds.',
      '[v2.16.0 release notes →](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)',
      '[v2.16.0 release](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)',
      'Release: v2.16.0',
      'Pinned release: v2.16.0',
      'Latest release: v2.16.0',
      'Measured candidate v2.16.0 — release pending.',
      '[Latest: v2.16.0](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)',
      '[v2.16.0 — pinned](https://github.com/EndeavorYen/chrome-cdp-ex/releases/tag/v2.15.0)',
    ]) {
      expect(checkDocsContract({ ...docs, readme: `${docs.readme}\n${falseClaim}\n` }, []), falseClaim)
        .toContain('README.md must not present unreleased candidate v2.16.0 as a published or measured release');
    }
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

  it('does not make unqualified PATH node the only SKILL.md invocation (#157)', () => {
    expect(skill).toMatch(/bin\/chrome-cdp|HERMES_HOME|process\.execPath/);
    expect(skill).toMatch(/If `node -v` is <22, use the Node 22 path printed by doctor/);
    const invocationLines = skill.split(/\r?\n/).filter(line =>
      /chrome-cdp-ex\/scripts\/cdp\.mjs|bin\/chrome-cdp/.test(line) && !line.trim().startsWith('#'),
    );
    expect(invocationLines.some(line => !/^node\s+/.test(line.trim()))).toBe(true);
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

    for (const surface of [codexIntegration, codexKillerPath]) {
      expect(surface).toContain('Phase 1 candidate');
      expect(surface).toMatch(/historical/i);
    }
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

  it('cleanly skips release work for an unreleased package candidate', () => {
    expect(releaseWorkflow).toContain('id: readiness');
    expect(releaseWorkflow).toContain('ready=false');
    expect(releaseWorkflow).toContain("steps.readiness.outputs.ready == 'true'");
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

describe('Read this page contract (#161)', () => {
  it('documents text --auto and perceive -x in CLI help', async () => {
    process.env.NODE_ENV = 'test';
    const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
    const usage = T.helpStr();
    expect(usage).toContain('--auto');
    expect(usage).toMatch(/-x <sel> \/ --exclude/);
  });

  it('lists text --auto, eval, and call in SKILL.md and recipes.md', () => {
    const recipes = readFileSync(new URL('../skills/chrome-cdp-ex/references/recipes.md', import.meta.url), 'utf8');
    expect(skill).toContain('text --auto');
    expect(skill).toMatch(/`eval`/);
    expect(skill).toMatch(/`call`/);
    expect(recipes).toMatch(/## Read this page/i);
    expect(recipes).toContain('text <target> --auto');
    expect(recipes).toContain('raw/main/LICENSE');
    expect(recipes).toContain('perceive <target> -s main');
    expect(recipes).toContain('h1.title');
    const xSection = recipes.split(/### X \/ Twitter/)[1]?.split(/^## /m)[0] || '';
    const xCode = [...xSection.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
    expect(xCode).toContain('text <target> --auto');
    expect(xCode).not.toContain('perceive');
  });
});
