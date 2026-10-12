#!/usr/bin/env node
// Fails when a command a Next hint can name is missing from the run_command allowlist.
// The command set is derived from the runtime source (see next-emitted-commands.mjs).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MCP_RUN_COMMAND_ALLOWLIST, COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import {
  missingNextCommands,
  nextEmittedCommands,
  runtimeNextSources,
} from './lib/next-emitted-commands.mjs';

export function catalogCommands(surface = COMMAND_SURFACE) {
  return surface.commands.map(command => ({
    name: command.name,
    aliases: [...command.aliases],
  }));
}

export function nextCommandsMissingFromAllowlist({
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  allowlist = MCP_RUN_COMMAND_ALLOWLIST,
  surface = COMMAND_SURFACE,
} = {}) {
  const emitted = nextEmittedCommands({
    sources: runtimeNextSources(rootDir),
    commands: catalogCommands(surface),
  });
  return missingNextCommands(emitted, allowlist);
}

function main() {
  const missing = nextCommandsMissingFromAllowlist();
  if (missing.length === 0) {
    process.stdout.write('Next run_command allowlist OK\n');
    return;
  }
  process.stderr.write(
    `Next hint names commands run_command does not accept: ${missing.join(', ')}\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
