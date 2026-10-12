// Wall-clock tests that flake on a shared runner. Each entry is one
// `it.skipIf(quarantined(issue))` call. `issue` names the flake; issue #693 tracks un-quarantining.
export const QUARANTINE = [
  {
    issue: 518,
    file: 'tests/issue-503-quoted-secret-tail.test.mjs',
    test: 'redacts 256 KB of ${name} in linear time',
  },
  {
    issue: 518,
    file: 'tests/issue-511-escaped-json-and-netlog-bodies.test.mjs',
    test: 'redacts 256 KB of ${name} in linear time',
  },
  {
    issue: 687,
    file: 'tests/issue-518-linear-timing-helper.test.mjs',
    test: 'catches a quadratic scan',
  },
];

// True when this process should skip a listed test. `issue` is the tracker number
// at the call site. CI (any truthy value) skips unless CDP_RUN_QUARANTINED is exactly "1".
export function quarantined(issue) {
  return typeof issue === 'number'
    && Boolean(process.env.CI)
    && process.env.CDP_RUN_QUARANTINED !== '1';
}
