import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hermesHost = readFileSync(
  join(root, 'skills/chrome-cdp-ex/hosts/hermes.md'),
  'utf8',
);

describe('Hermes host overlay keeps Electron off daily 9222', () => {
  it('documents CDP_PORT=9333 for Electron instead of spawn --port 9222', () => {
    expect(hermesHost).toMatch(/CDP_PORT=9333/);
    expect(hermesHost).toMatch(/Electron/i);
    expect(hermesHost).not.toMatch(/spawn-debug-browser[^\n]*--port 9222/);
  });

  it('does not tell Electron operators to set CDP_PORT=9222 in the skill example', () => {
    const skill = readFileSync(
      join(root, 'skills/chrome-cdp-ex/SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(/CDP_PORT=9333 \.\/bin\/chrome-cdp list/);
    expect(skill).not.toMatch(/# Electron[^\n]*\nCDP_PORT=9222/);
  });
});
