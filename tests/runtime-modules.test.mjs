import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { RUNTIME_SOURCE_FILES, runtimeSources } from './runtime-source.mjs';

// The lib/cdp-*.mjs modules import each other in cycles. That is safe only while no module reads
// another module's constant during its own top-level evaluation. Loading each module on its own
// changes the evaluation order, so a new cross-module read at load time fails here first.
describe('runtime modules', () => {
  for (const name of RUNTIME_SOURCE_FILES.filter(file => file.startsWith('lib/'))) {
    it(`${name} loads on its own`, () => {
      const url = new URL(`../skills/chrome-cdp-ex/scripts/${name}`, import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
        timeout: 20_000,
      });
      expect(result.status, result.stderr).toBe(0);
    });
  }

  it('cdp-base imports no other cdp-* module, so it is initialized before any module reads it', () => {
    const base = runtimeSources().find(source => source.name === 'lib/cdp-base.mjs').text;
    expect(base).not.toMatch(/from '\.\/cdp-(?!domains|session)[a-z-]+\.mjs'/);
  });
});
