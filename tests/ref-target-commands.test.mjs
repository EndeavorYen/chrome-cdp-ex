import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

// Second "command ignores @ref" bug, after fill (#633 was select and upload).
// The inventory is derived from command synopses. A new selector-taking command
// that does not resolve @ref fails this file without anyone extending a list.

const CDP_SOURCE = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
const CDP_AST = parse(CDP_SOURCE, { ecmaVersion: 'latest', sourceType: 'module' });

const RESOLVERS = new Set(['isRef', 'resolveRefNode', 'resolveRef']);

// A perceive @ref names one node that already exists. These commands take a
// selector for a different reason, so advertising @ref would be a lie.
const REF_EXEMPT = {
  // The element may not exist yet. An @ref only names a node perceive already
  // saw. `--gone` resolves an @ref; the thing you wait for is still CSS.
  waitfor: 'positional selector is an element that may not exist yet; an @ref only names a node perceive already saw',
  // Each click mutates the page and invalidates a perceive @ref, then the same
  // control has to be found again. Only a CSS selector survives that re-query.
  loadall: 're-queries the same control after each click until it disappears, which invalidates a perceive @ref',
  // Optional CSS fallback chain or scope (`main, [role=main]`), not one node.
  html: 'optional CSS fallback chain or scope, which an @ref cannot express',
  text: 'optional CSS fallback chain or --auto scope, which an @ref cannot express',
  // `--root` is a document query. `cascade` is the @ref path for one element.
  styles: 'CSS selector plus a --root document query; cascade is the @ref path for one element',
  // TABLE_SELECTOR and the scroll/load-more selectors are re-run as the table
  // scrolls or virtualizes. scroll --scroll-container already rejects a ref.
  table: 'CSS queries re-run while the table scrolls or virtualizes; an @ref does not survive that re-query',
};

const DERIVATION = [
  'Top-level synopsis placeholders (<...> and [...]; a group is consumed whole,',
  'so a <sel> nested inside a flag group is not a second target). A placeholder',
  'is an element target when a token is sel, selector, or @ref, or the token',
  'contains "selector" (TABLE_SELECTOR). Flag groups (inner text starts with -',
  'or --) are skipped. A bare --flag or -flag is not a placeholder, so its value',
  '(--scroll-container SELECTOR, --ready-selector sel) is not a target.',
].join(' ');

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, visit);
    } else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function propertyName(property) {
  if (!property || property.type !== 'Property') return null;
  if (property.key.type === 'Identifier' && property.computed !== true) return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  return null;
}

function functionBodies(ast) {
  const bodies = new Map();
  walk(ast, node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name && !bodies.has(node.id.name)) {
      bodies.set(node.id.name, node);
    }
  });
  return bodies;
}

function mentions(node, name) {
  let found = false;
  walk(node, item => {
    if (item.type === 'Identifier' && item.name === name) found = true;
  });
  return found;
}

function callees(node) {
  const names = [];
  walk(node, item => {
    if (item.type === 'CallExpression' && item.callee.type === 'Identifier') names.push(item.callee.name);
  });
  return names;
}

function handlerProperties(ast, names) {
  const wanted = new Set(names);
  const snippets = new Map(names.map(name => [name, []]));
  walk(ast, node => {
    const name = propertyName(node);
    if (!wanted.has(name) || !node.value) return;
    snippets.get(name).push(node.value);
  });
  return snippets;
}

function reachesResolver(nodes, bodies) {
  const queue = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!mentions(node, 'refMap') || !mentions(node, 'refState')) continue;
    for (const name of callees(node)) queue.push({ name, depth: 1 });
  }
  while (queue.length) {
    const { name, depth } = queue.shift();
    if (RESOLVERS.has(name)) return true;
    if (seen.has(name) || depth > 6) continue;
    seen.add(name);
    const body = bodies.get(name);
    if (!body) continue;
    for (const callee of callees(body)) queue.push({ name: callee, depth: depth + 1 });
  }
  return false;
}

function topLevelGroups(synopsis) {
  const groups = [];
  const openers = { '<': '>', '[': ']' };
  for (let i = 0; i < synopsis.length; i++) {
    const close = openers[synopsis[i]];
    if (!close) continue;
    let depth = 1;
    let j = i + 1;
    while (j < synopsis.length && depth > 0) {
      if (synopsis[j] === synopsis[i]) depth += 1;
      else if (synopsis[j] === close) depth -= 1;
      j += 1;
    }
    groups.push(synopsis.slice(i + 1, j - 1));
    i = j - 1;
  }
  return groups;
}

function groupTargetsElement(inner) {
  if (/^\s*-/.test(inner)) return false;
  const tokens = inner.split(/[\s|]+/).map(token => token.replace(/[^A-Za-z0-9_@-]/g, '')).filter(Boolean);
  return tokens.some(token => {
    const lower = token.toLowerCase();
    return lower === 'sel' || lower === 'selector' || lower === '@ref' || lower.includes('selector');
  });
}

function selectorCommands(surface) {
  return surface.commands
    .filter(command => topLevelGroups(command.help.synopsis).some(groupTargetsElement))
    .map(command => command.name);
}

describe('selector commands resolve perceive @refs', () => {
  const bodies = functionBodies(CDP_AST);
  const derived = selectorCommands(COMMAND_SURFACE);
  const snippets = handlerProperties(CDP_AST, derived.filter(name => !Object.hasOwn(REF_EXEMPT, name)));

  it('derives the element-target commands and requires each one to resolve @ref', () => {
    expect(callees(bodies.get('selectStr'))).toContain('isRef');
    expect(callees(bodies.get('uploadStr'))).toContain('isRef');
    expect(bodies.has('resolveRefNode')).toBe(true);

    expect(derived.length).toBeGreaterThan(0);
    for (const name of ['click', 'fill', 'select', 'upload', 'drag', 'hover', 'cascade', 'components']) {
      expect(derived, `derivation missed ${name}`).toContain(name);
    }
    // Derivation locks, not an inventory: these synopses must not count.
    for (const name of ['scroll', 'controls', 'open', 'press', 'type', 'clickxy', 'shot', 'frame']) {
      expect(derived, `${name} is not an element-target command`).not.toContain(name);
    }

    for (const [name, reason] of Object.entries(REF_EXEMPT)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(derived, `exemption ${name} is not a derived selector command`).toContain(name);
      const command = COMMAND_SURFACE.commands.find(item => item.name === name);
      expect(command.help.synopsis.includes('@ref'), `${name} is exempt, so its synopsis must not advertise @ref`).toBe(false);
    }

    const failures = [];
    for (const name of derived) {
      if (Object.hasOwn(REF_EXEMPT, name)) continue;
      const command = COMMAND_SURFACE.commands.find(item => item.name === name);
      const owned = snippets.get(name) || [];
      if (!command.help.synopsis.includes('@ref')) failures.push(`${name}: synopsis does not advertise @ref`);
      if (owned.length === 0) failures.push(`${name}: no handler property in cdp.mjs`);
      else if (!reachesResolver(owned, bodies)) {
        failures.push(`${name}: no handler property passes refMap and refState and reaches isRef/resolveRefNode/resolveRef`);
      }
    }
    expect(failures).toEqual([]);

    const report = [
      `derivation: ${DERIVATION}`,
      `commands: ${derived.join(', ')}`,
      `exemptions: ${Object.entries(REF_EXEMPT).map(([name, reason]) => `${name} (${reason})`).join('; ')}`,
    ].join('\n');
    console.log(report);
    expect(report).toContain('commands: ');
  });
});
