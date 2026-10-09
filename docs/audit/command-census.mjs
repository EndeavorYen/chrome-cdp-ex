#!/usr/bin/env node
// Phase A audit census: every catalog command against every surface that teaches,
// exposes, routes to, or tests it. Read-only; prints TSV (default) or JSON (--json).
//   node docs/audit/command-census.mjs [--json]
// Columns and their sources are described in docs/audit/command-surface.md.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = join(root, 'skills/chrome-cdp-ex/scripts');
process.env.NODE_ENV = 'test';
const surface = await import(pathToFileURL(join(scriptsDir, 'lib/command-surface.mjs')).href);
const { __test__: T } = await import(pathToFileURL(join(scriptsDir, 'cdp.mjs')).href);

const read = rel => readFileSync(join(root, rel), 'utf8');
const lines = rel => read(rel).split(/\r?\n/);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = name => new RegExp(`(?<![A-Za-z0-9_-])${esc(name)}(?![A-Za-z0-9_-])`);
// Used as a command: after `cdp`, `cdp.mjs`, `chrome-cdp`, or an opening backtick.
const asCommand = name => new RegExp(`(?:\\bcdp(?:\\.mjs)?|chrome-cdp(?:\\.cmd)?|\`)\\s*${esc(name)}(?![A-Za-z0-9_-])`);
const hits = (arr, re) => arr.flatMap((line, i) => (re.test(line) ? [i + 1] : []));
const uniqSorted = values => [...new Set(values)].sort((a, b) => a - b);

const surfaceLines = lines('skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');
const cdpLines = lines('skills/chrome-cdp-ex/scripts/cdp.mjs');
const skill = lines('skills/chrome-cdp-ex/SKILL.md');
const refs = lines('skills/chrome-cdp-ex/references/commands.md');
const reference = lines('docs/reference.md');
const killer = lines('docs/examples/killer-path.md');
const card = T.helpStr();

// Runtime hints: string literals of the form `cdp <command> …` in shipped code.
const runtimeFiles = [
  'skills/chrome-cdp-ex/scripts/cdp.mjs',
  ...readdirSync(join(scriptsDir, 'lib')).map(f => `skills/chrome-cdp-ex/scripts/lib/${f}`),
];
const hintSites = new Map();
for (const rel of runtimeFiles) {
  lines(rel).forEach((line, index) => {
    for (const match of line.matchAll(/[`'"][^`'"]*?\bcdp ([a-z][a-z0-9-]*)/g)) {
      const record = surface.COMMAND_SURFACE.resolve(match[1]);
      if (!record) continue;
      if (!hintSites.has(record.name)) hintSites.set(record.name, []);
      hintSites.get(record.name).push(`${rel.replace('skills/chrome-cdp-ex/scripts/', '')}:${index + 1}`);
    }
  });
}

const testDir = join(root, 'tests');
const tests = readdirSync(testDir).filter(f => f.endsWith('.mjs'))
  .map(f => ({ f, text: readFileSync(join(testDir, f), 'utf8') }));

const survivors = new Set(surface.SURVIVOR_COMMANDS);
const allowlist = new Set(surface.MCP_RUN_COMMAND_ALLOWLIST);
const builderStart = cdpLines.findIndex(l => l.startsWith('const DAEMON_HANDLER_BUILDERS'));
const mainStart = cdpLines.findIndex(l => l.startsWith('async function main('));

const rows = surface.COMMAND_SURFACE.commands.map(c => {
  const names = [c.name, ...c.aliases];
  // Target commands: their DAEMON_HANDLER_BUILDERS entry. Targetless: their branch in main().
  const handlerLine = c.needsTarget
    ? cdpLines.findIndex((l, i) => i > builderStart && new RegExp(`^\\s+(?:'${esc(c.name)}'|${esc(c.name)}): `).test(l)) + 1
    : cdpLines.findIndex((l, i) => i > mainStart && l.includes(`cmd === '${c.name}'`)) + 1;
  const callShape = new RegExp(`(?:cmd:\\s*['"]|argv:\\s*\\[\\s*['"]|\\[\\s*['"])(?:${names.map(esc).join('|')})['"]\\s*[,\\]]`);
  return {
    name: c.name,
    aliases: c.aliases,
    target: c.needsTarget,
    kind: c.kind,
    formats: c.outputFormats,
    catalogLine: surfaceLines.findIndex(l => l.includes(`{"name":"${c.name}"`)) + 1,
    handlerLine,
    survivor: survivors.has(c.name),
    mcpTool: survivors.has(c.name) ? (c.mcp.toolName || '') : '',
    mcpToolHidden: !survivors.has(c.name) && c.mcp.toolName ? c.mcp.toolName : '',
    mcpRunCommand: names.some(n => allowlist.has(n)),
    onCard: names.some(n => word(n).test(card)),
    skillLines: uniqSorted(names.flatMap(n => hits(skill, word(n)))),
    refsLines: uniqSorted(names.flatMap(n => hits(refs, asCommand(n)))).length,
    referenceLines: uniqSorted(names.flatMap(n => hits(reference, asCommand(n)))).length,
    killerLines: uniqSorted(names.flatMap(n => hits(killer, asCommand(n)))),
    hintSites: hintSites.get(c.name) || [],
    testFiles: tests.filter(t => callShape.test(t.text)).length,
  };
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(['command', 'target', 'kind', 'formats', 'catalog', 'handler', 'survivor', 'mcpTool', 'runCommand', 'card',
    'skillLines', 'refs', 'reference', 'killer', 'hints', 'testFiles'].join('\t'));
  for (const r of rows) {
    console.log([
      r.name + (r.aliases.length ? ` (${r.aliases.join('|')})` : ''),
      r.target ? 'yes' : 'no', r.kind, r.formats.join('+'), r.catalogLine, r.handlerLine,
      r.survivor ? 'yes' : 'no', r.mcpTool || (r.mcpToolHidden ? `hidden:${r.mcpToolHidden}` : '-'),
      r.mcpRunCommand ? 'yes' : 'no', r.onCard ? 'yes' : 'no',
      r.skillLines.join(',') || '-', r.refsLines, r.referenceLines, r.killerLines.join(',') || '-',
      r.hintSites.length, r.testFiles,
    ].join('\t'));
  }
}
