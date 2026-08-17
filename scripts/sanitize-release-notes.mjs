#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Zero-width space after @ matches the live v2.16.0 notes edit: still reads as
// `@ref` but GitHub does not treat it as a user mention.
export const MENTION_BREAK = '\u200B';

// CLI tokens that GitHub's @mention scanner would treat as usernames.
// `@ref` / `@refs` / `@fN` / `@fN:M` / `@f1` / `@f1:3`. Real people mentions
// such as `@EndeavorYen` are left untouched.
const CLI_AT_TOKEN = /(^|[^\w\u200B])@(refs?|f(?:N|\d+)(?::(?:M|\d+))?)(?![A-Za-z0-9-])/g;

export function sanitizeReleaseNotes(markdown) {
  return String(markdown).replace(
    CLI_AT_TOKEN,
    (_match, prefix, token) => `${prefix}@${MENTION_BREAK}${token}`,
  );
}

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node scripts/sanitize-release-notes.mjs <notes.md>');
    process.exitCode = 1;
    return;
  }

  const notesPath = resolve(args[0]);
  writeFileSync(notesPath, sanitizeReleaseNotes(readFileSync(notesPath, 'utf8')));
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main(process.argv.slice(2));
