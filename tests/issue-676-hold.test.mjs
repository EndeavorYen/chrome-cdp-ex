import { writeFileSync } from 'node:fs';
import { it } from 'vitest';

// The signal-cleanup test spawns this file with CHROME_CDP_EX_VITEST_HOLD=1
// and interrupts that process. The normal suite leaves the env unset.
it('stays running only for the signal-cleanup probe', () => {
  if (process.env.CHROME_CDP_EX_VITEST_HOLD !== '1') return;
  writeFileSync(process.env.CHROME_CDP_EX_SIGNAL_READY, process.env.CHROME_CDP_EX_VITEST_RUN_RUNTIME || '');
  return new Promise(() => {});
}, 120_000);
