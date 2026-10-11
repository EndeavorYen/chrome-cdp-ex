import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  alignContractToSurvivors,
  diffContracts,
  helpCaptureDifferences,
  liveSurvivorSynopses,
  survivorSynopsisDifferences,
} from '../scripts/check-public-contracts.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
const contractPath = join(rootDir, 'docs/contracts', `v${version}`, 'public-contracts.v1.json');
const synopsisPath = join(rootDir, 'docs/contracts', `v${version}`, 'survivor-synopsis.v1.json');

function dropUnsafeFull(text) {
  return String(text)
    .replace('list|tabs|ls [--unsafe-full] [--format json]', 'list|tabs|ls [--format json]')
    .replace('perceive <target> [flags] [--unsafe-full] [--format json]', 'perceive <target> [flags] [--format json]');
}

describe('#675 captured help and synopsis stay on the live command surface', () => {
  it('keeps captured help in the contract diff', () => {
    const contract = {
      commands: [],
      mcp: {},
      cliCases: [{ id: 'no-args-help', stdout: 'list|tabs|ls [--format json]' }],
    };
    expect(alignContractToSurvivors(contract).cliCases[0].stdout).toBe('list|tabs|ls [--format json]');
    const live = { ...contract, cliCases: [{ id: 'no-args-help', stdout: 'list|tabs|ls [--unsafe-full] [--format json]' }] };
    expect(diffContracts(alignContractToSurvivors(contract), alignContractToSurvivors(live)).join('\n'))
      .toMatch(/unsafe-full/);
  });

  it('fails when captured help drops --unsafe-full from list and perceive', () => {
    const fixture = JSON.parse(readFileSync(contractPath, 'utf8'));
    expect(helpCaptureDifferences(fixture.cliCases)).toEqual([]);
    const stale = structuredClone(fixture);
    for (const entry of stale.cliCases) {
      if (entry.id === 'help' || entry.id === 'no-args-help') entry.stdout = dropUnsafeFull(entry.stdout);
    }
    const differences = helpCaptureDifferences(stale.cliCases);
    expect(differences.join('\n')).toMatch(/no-args-help: list\.synopsis/);
    expect(differences.join('\n')).toMatch(/no-args-help: perceive\.synopsis/);
    expect(differences.join('\n')).toMatch(/help: list\.synopsis/);
    expect(differences.join('\n')).toMatch(/help: perceive\.synopsis/);
    const aligned = diffContracts(alignContractToSurvivors(stale), alignContractToSurvivors(fixture));
    expect(aligned.join('\n')).toMatch(/stdout/);
  });

  it('fails when the captured synopsis drops --unsafe-full', () => {
    const expected = JSON.parse(readFileSync(synopsisPath, 'utf8'));
    const stale = structuredClone(expected);
    stale.commands.list.synopsis = stale.commands.list.synopsis.replace(' [--unsafe-full]', '');
    stale.commands.perceive.synopsis = stale.commands.perceive.synopsis.replace(' [--unsafe-full]', '');
    const differences = survivorSynopsisDifferences(stale, liveSurvivorSynopses());
    expect(differences.join('\n')).toMatch(/list\.synopsis/);
    expect(differences.join('\n')).toMatch(/perceive\.synopsis/);
  });
});
