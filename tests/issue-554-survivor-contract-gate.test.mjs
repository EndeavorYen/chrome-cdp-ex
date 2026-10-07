import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  alignContractToSurvivors,
  diffContracts,
  survivorSynopsisDifferences,
} from '../scripts/check-public-contracts.mjs';
import { COMMAND_SURFACE, SURVIVOR_COMMANDS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const synopsisPath = join(rootDir, 'docs/contracts/v2.21.0/survivor-synopsis.v1.json');

function liveSynopses() {
  const commands = {};
  for (const name of SURVIVOR_COMMANDS) {
    const help = COMMAND_SURFACE.resolve(name).help;
    commands[name] = { synopsis: help.synopsis, summary: help.summary };
  }
  return commands;
}

describe('#554 survivor contract gate', () => {
  it('T1 a non-survivor synopsis change reports no drift', () => {
    const expected = JSON.parse(readFileSync(synopsisPath, 'utf8'));
    const table = COMMAND_SURFACE.resolve('table');
    const drifted = {
      ...liveSynopses(),
      table: { synopsis: `${table.help.synopsis} drifted`, summary: `${table.help.summary} drifted` },
    };
    expect(survivorSynopsisDifferences(expected, drifted)).toEqual([]);
  });

  it('T2 a survivor synopsis change is reported', () => {
    const expected = JSON.parse(readFileSync(synopsisPath, 'utf8'));
    const drifted = liveSynopses();
    drifted.click = { ...drifted.click, synopsis: 'click drifted' };
    const differences = survivorSynopsisDifferences(expected, drifted);
    expect(differences.length).toBeGreaterThan(0);
    expect(differences.join('\n')).toMatch(/click/);
  });

  it('removing a non-survivor command is ignored and a survivor field change is reported', () => {
    const expected = {
      commands: [
        { name: 'click', kind: 'mutation' },
        { name: 'table', kind: 'read' },
      ],
      mcp: {},
      cliCases: [],
    };
    const withoutTable = {
      commands: [{ name: 'click', kind: 'mutation' }],
      mcp: {},
      cliCases: [],
    };
    expect(diffContracts(alignContractToSurvivors(expected), alignContractToSurvivors(withoutTable))).toEqual([]);
    const driftedClick = {
      commands: [{ name: 'click', kind: 'read' }],
      mcp: {},
      cliCases: [],
    };
    const clickDrift = diffContracts(alignContractToSurvivors(expected), alignContractToSurvivors(driftedClick));
    expect(alignContractToSurvivors(driftedClick).commands.map(command => command.name)).toEqual(['click']);
    expect(clickDrift.join('\n')).toMatch(/commands\[0\]\.kind/);
  });
});
