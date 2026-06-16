import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { validateKillerPathContract } from '../scripts/check-docs-contract.mjs';

const killerPath = readFileSync(new URL('../docs/examples/killer-path.md', import.meta.url), 'utf8');

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
});
