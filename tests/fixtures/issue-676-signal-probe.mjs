import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Vitest registers this shape of listener before vitest.config.js runs. The
// 'exit' listener calls process.exit() again, and Node then skips every exit
// listener that was registered later (#676). This probe installs that shape
// first, then loads the real config, then delivers the signal.
const signal = process.argv[2];
if (signal !== 'SIGINT' && signal !== 'SIGTERM') {
  console.error('expected SIGINT or SIGTERM');
  process.exit(2);
}

function vitestLikeExit(received, code) {
  if (process.exitCode === undefined) {
    process.exitCode = code !== undefined ? 128 + code : 1;
  }
  process.exit();
}
process.once('SIGINT', vitestLikeExit);
process.once('SIGTERM', vitestLikeExit);
process.once('exit', vitestLikeExit);

const prefix = 'chrome-cdp-ex-vitest-';
const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith(prefix)));
await import('../../vitest.config.js');
const created = readdirSync(tmpdir()).filter(name => name.startsWith(prefix) && !before.has(name));
const out = process.env.CHROME_CDP_EX_SIGNAL_PROBE_OUT;
if (!out) {
  console.error('missing probe output env');
  process.exit(2);
}
writeFileSync(out, created.join('\n'));
process.emit(signal, signal, signal === 'SIGINT' ? 2 : 15);
