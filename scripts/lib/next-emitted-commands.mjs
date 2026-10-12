// Commands a Next hint can name, read from the runtime source.
// Literals come from Next carriers in the syntax tree. An interpolation in the
// command position is expanded from the code that fills it: suggestCommands
// (catalog names), commandUsageTemplate's switch, or actionFeedback calls.
// There is no handwritten list of command names.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as espree from 'espree';

const CARRIER_KEYS = new Set(['nextCommand', 'nextHint', 'run']);
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

function parse(source, name) {
  try {
    return espree.parse(source.text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      range: true,
    });
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit, next);
    } else walk(value, visit, next);
  }
}

function isFunction(node) {
  return node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression';
}

function propertyName(node) {
  if (!node || node.type !== 'Property' || node.computed) return null;
  if (node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

function snippet(source, node) {
  return source.text.slice(node.range[0], node.range[1]);
}

function cooked(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map(quasi => quasi.value.cooked ?? '').join('');
  }
  return '';
}

function isCommandString(node) {
  if (!node || typeof node.type !== 'string') return false;
  return (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral';
}

function suggestCommandsReturnsNames(ast, source) {
  let returnsNames = false;
  walk(ast, node => {
    if (node.type !== 'FunctionDeclaration' || node.id?.name !== 'suggestCommands') return;
    const text = snippet(source, node);
    returnsNames = text.includes('command.name') && text.includes('exact.name');
  });
  return returnsNames;
}

function actionFeedbackNames(ast, source) {
  const names = new Set();
  walk(ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'actionFeedback') return;
    const [first] = node.arguments;
    if (!first || first.type !== 'Literal' || typeof first.value !== 'string' || !COMMAND_NAME.test(first.value)) {
      throw new Error(`actionFeedback command is not a string literal (${source.name}: ${first ? snippet(source, first) : 'missing'})`);
    }
    names.add(first.value);
  });
  return names;
}

function literalWords(text) {
  return [...text.matchAll(/(?:^|[^A-Za-z0-9_-])cdp\s+([a-z][a-z0-9-]*)/g)].map(match => match[1]);
}

function commandExpressions(node) {
  if (node.type === 'Literal') return [];
  const expressions = [];
  node.quasis.forEach((quasi, index) => {
    if (/(?:^|[^A-Za-z0-9_-])cdp\s+$/.test(quasi.value.cooked ?? '') && node.expressions[index]) {
      expressions.push(node.expressions[index]);
    }
  });
  return expressions;
}

function caseLabel(test) {
  if (!test) return 'default';
  if (test.type === 'Literal' && typeof test.value === 'string') return test.value;
  throw new Error('commandUsageTemplate case is not a string');
}

function usageGroups(fn) {
  const groups = [];
  walk(fn, node => {
    if (node.type !== 'SwitchStatement') return;
    const argument = node.discriminant;
    if (argument.type !== 'Identifier' || argument.name !== 'cmd') return;
    let pending = [];
    for (const item of node.cases) {
      pending.push(caseLabel(item.test));
      const returned = item.consequent.find(statement => statement.type === 'ReturnStatement');
      if (!returned) continue;
      groups.push({ labels: pending, argument: returned.argument });
      pending = [];
    }
  });
  return groups;
}

function resolveExpression(expr, source, ctx) {
  const text = snippet(source, expr);
  if (expr.type === 'MemberExpression'
    && expr.object.type === 'Identifier'
    && expr.object.name === 'suggestions') {
    if (!ctx.suggestionNames) throw new Error('suggestCommands does not return catalog command names');
    return [...ctx.suggestionNames];
  }
  if (expr.type === 'LogicalExpression'
    && expr.operator === '||'
    && expr.left.type === 'Identifier'
    && expr.left.name === 'action'
    && expr.right.type === 'Literal'
    && typeof expr.right.value === 'string') {
    return [expr.right.value, ...ctx.actionNames];
  }
  if (ctx.usage && (text === 'cmd' || text.startsWith('cmd ') || text.startsWith('cmd||') || text.startsWith('cmd ||'))) {
    return ctx.usage;
  }
  throw new Error(`Unresolved Next command interpolation: ${text}`);
}

function addWords(emitted, words) {
  for (const word of words) emitted.add(word);
}

function emitNode(node, source, ctx, emitted) {
  if (!isCommandString(node)) return;
  addWords(emitted, literalWords(cooked(node)));
  for (const expr of commandExpressions(node)) {
    addWords(emitted, resolveExpression(expr, source, ctx));
  }
}

function boundInitializers(fn) {
  const declared = new Map();
  const carriers = [];
  function visit(node, nested) {
    if (!node || typeof node.type !== 'string') return;
    if (node !== fn && isFunction(node)) return;
    if (node.type === 'VariableDeclarator'
      && node.id.type === 'Identifier'
      && isCommandString(node.init)) {
      declared.set(node.id.name, node.init);
    }
    if (node.type === 'Property') {
      const key = propertyName(node);
      if (CARRIER_KEYS.has(key) && node.value.type === 'Identifier') {
        const init = declared.get(node.value.name);
        if (init) carriers.push(init);
      }
    }
    if (node.type === 'CallExpression'
      && node.callee.type === 'MemberExpression'
      && node.callee.object.type === 'Identifier'
      && node.callee.object.name === 'nextSteps'
      && !node.callee.computed
      && node.callee.property.type === 'Identifier'
      && node.callee.property.name === 'push') {
      carriers.push(...node.arguments.filter(isCommandString));
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, nested);
      } else visit(value, nested);
    }
  }
  visit(fn, false);
  return carriers;
}

function directCarriers(ast) {
  const carriers = [];
  walk(ast, (node, ancestors) => {
    if (!isCommandString(node)) return;
    const parent = ancestors.at(-1);
    const key = propertyName(parent);
    if (CARRIER_KEYS.has(key) && parent.value === node) carriers.push(node);
    if (parent?.type === 'ArrayExpression') {
      const grand = ancestors.at(-2);
      if (propertyName(grand) === 'nextSteps') carriers.push(node);
    }
    const text = cooked(node);
    if (/\bNext:/.test(text) && /\bcdp\s+/.test(text)) carriers.push(node);
  });
  return carriers;
}

function emitUsage(fn, source, commands, ctx, emitted) {
  const spellings = commands.flatMap(command => [command.name, ...command.aliases]);
  const caseLabels = new Set();
  const groups = usageGroups(fn);
  for (const group of groups) {
    for (const label of group.labels) if (label !== 'default') caseLabels.add(label);
  }
  for (const group of groups) {
    if (!group.argument || !isCommandString(group.argument)) continue;
    const labels = group.labels.includes('default')
      ? spellings.filter(spelling => !caseLabels.has(spelling))
      : group.labels;
    emitNode(group.argument, source, { ...ctx, usage: labels }, emitted);
  }
}

/**
 * @param {{ sources: { name: string, text: string }[], commands: { name: string, aliases?: string[] }[] }} input
 * @returns {string[]}
 */
export function nextEmittedCommands({ sources, commands }) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('sources are required');
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('commands are required');
  const emitted = new Set();
  const parsed = sources.map(source => ({ source, ast: parse(source, source.name) }));
  const suggestionNames = parsed.some(({ ast, source }) => suggestCommandsReturnsNames(ast, source))
    ? commands.map(command => command.name)
    : null;
  const actionNames = parsed.flatMap(({ ast, source }) => [...actionFeedbackNames(ast, source)]);
  const ctx = { suggestionNames, actionNames, usage: null };
  for (const { source, ast } of parsed) {
    const seen = new Set();
    const take = node => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      emitNode(node, source, ctx, emitted);
    };
    for (const node of directCarriers(ast)) take(node);
    walk(ast, node => {
      if (!isFunction(node)) return;
      for (const init of boundInitializers(node)) take(init);
      if (node.type === 'FunctionDeclaration' && node.id?.name === 'commandUsageTemplate') {
        emitUsage(node, source, commands, ctx, emitted);
      }
    });
  }
  if (emitted.size === 0) throw new Error('Next derivation found no commands');
  return [...emitted].sort();
}

export function missingNextCommands(emitted, allowlist) {
  const allowed = new Set(allowlist);
  return emitted.filter(command => !allowed.has(command));
}

export function runtimeNextSources(rootDir) {
  const scripts = join(rootDir, 'skills', 'chrome-cdp-ex', 'scripts');
  const files = [
    'cdp.mjs',
    ...readdirSync(join(scripts, 'lib'))
      .filter(name => name.endsWith('.mjs'))
      .map(name => join('lib', name)),
  ];
  return files.map(name => ({
    name,
    text: readFileSync(join(scripts, name), 'utf8'),
  }));
}
