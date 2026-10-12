import { readFileSync } from 'node:fs';

// cdp.mjs plus the modules split out of it (#688), in the original source order. Tests that read
// runtime source text use this instead of cdp.mjs alone.
export const RUNTIME_SOURCE_FILES = Object.freeze([
  'cdp.mjs',
  'lib/cdp-base.mjs',
  'lib/cdp-core.mjs',
  'lib/cdp-browser.mjs',
  'lib/cdp-page.mjs',
  'lib/cdp-action-result.mjs',
  'lib/cdp-session-report.mjs',
  'lib/cdp-perceive.mjs',
  'lib/cdp-input.mjs',
  'lib/cdp-page-commands.mjs',
  'lib/cdp-flow.mjs',
  'lib/cdp-doctor.mjs',
  'lib/cdp-daemon.mjs',
  'lib/cdp-cli.mjs',
  'lib/cdp-main.mjs',
]);

export function runtimeSources() {
  return RUNTIME_SOURCE_FILES.map(name => ({
    name,
    text: readFileSync(new URL(`../skills/chrome-cdp-ex/scripts/${name}`, import.meta.url), 'utf8'),
  }));
}

// The `export` prefix the split added is dropped, so text checks see declarations as they
// were written in the single file (`\nfunction name(`).
export function runtimeSource() {
  return runtimeSources()
    .map(source => source.text.replace(/^export (?=(?:async )?function|const |let |class )/gm, ''))
    .join('\n');
}
