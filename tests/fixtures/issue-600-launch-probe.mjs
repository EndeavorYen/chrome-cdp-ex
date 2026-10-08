import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const direct = Boolean(process.argv[1])
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const stdin = process.env.PROBE_READ_STDIN === '1' ? readFileSync(0, 'utf8') : '';
const payload = JSON.stringify({
  argv: process.argv,
  direct,
  stdin,
});
if (process.env.PROBE_HOLD === '1') {
  // The ready file is written after the handler, so a slow machine does not
  // signal the process before it can catch SIGINT.
  process.on('SIGINT', () => process.exit(0));
  writeFileSync(process.env.PROBE_OUT, payload);
  setInterval(() => {}, 1000);
} else {
  writeFileSync(process.env.PROBE_OUT, payload);
  process.exit(Number(process.env.PROBE_CODE || 0));
}
