import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { QUARANTINE, quarantined } from './quarantine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDir = fileURLToPath(new URL('.', import.meta.url));

function assignEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function entryPath(file) {
  return join(root, ...file.split('/'));
}

describe('quarantined()', () => {
  const savedCi = process.env.CI;
  const savedFlag = process.env.CDP_RUN_QUARANTINED;

  afterEach(() => {
    assignEnv('CI', savedCi);
    assignEnv('CDP_RUN_QUARANTINED', savedFlag);
  });

  it.each([
    ['no CI', undefined, undefined, false],
    ['empty CI', '', undefined, false],
    ['CI=1', '1', undefined, true],
    ['CI=true', 'true', undefined, true],
    ['CI=0', '0', undefined, true],
    ['CI=1 and CDP_RUN_QUARANTINED=1', '1', '1', false],
    ['CI=true and CDP_RUN_QUARANTINED=1', 'true', '1', false],
    ['CI=1 and CDP_RUN_QUARANTINED=0', '1', '0', true],
    ['CI=1 and CDP_RUN_QUARANTINED empty', '1', '', true],
    ['CI=1 and CDP_RUN_QUARANTINED=true', '1', 'true', true],
    ['only CDP_RUN_QUARANTINED=1', undefined, '1', false],
  ])('%s', (label, ci, flag, expected) => {
    assignEnv('CI', ci);
    assignEnv('CDP_RUN_QUARANTINED', flag);
    expect(quarantined(518), label).toBe(expected);
    expect(quarantined(687), label).toBe(expected);
  });

  it('reads the environment on each call', () => {
    assignEnv('CI', '1');
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(518)).toBe(true);
    assignEnv('CDP_RUN_QUARANTINED', '1');
    expect(quarantined(518)).toBe(false);
    assignEnv('CI', undefined);
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(687)).toBe(false);
  });

  it('stays false when issue is not a number', () => {
    assignEnv('CI', '1');
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(undefined)).toBe(false);
    expect(quarantined('518')).toBe(false);
  });
});

describe('QUARANTINE list', () => {
  it('points each entry at a file that skips that issue', () => {
    expect(QUARANTINE.length).toBeGreaterThan(0);
    for (const entry of QUARANTINE) {
      const path = entryPath(entry.file);
      expect(existsSync(path), entry.file).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text, entry.file).toContain(`skipIf(quarantined(${entry.issue}))`);
      expect(text, `${entry.file} ${entry.test}`).toContain(entry.test);
    }
  });

  it('matches the skipIf(quarantined) call count under tests/*.test.mjs', () => {
    const callRe = /skipIf\(quarantined\(\d+\)\)/g;
    let count = 0;
    for (const name of readdirSync(testsDir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const text = readFileSync(join(testsDir, name), 'utf8');
      count += text.match(callRe)?.length ?? 0;
    }
    expect(count).toBe(QUARANTINE.length);
  });
});
