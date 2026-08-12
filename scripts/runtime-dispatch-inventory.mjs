#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Linter } from 'eslint';

import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const fixturePath = resolve(rootDir, 'docs/contracts/v2.15.0/runtime-dispatch.v1.json');
const PROTOCOL_COMMANDS = new Set(['list', 'list_raw', 'meta', 'stop']);

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function functionName(sourceCode, node) {
  const ancestors = sourceCode.getAncestors(node);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor.type === 'FunctionDeclaration') return ancestor.id?.name || '<anonymous>';
    if (ancestor.type === 'FunctionExpression' || ancestor.type === 'ArrowFunctionExpression') {
      const parent = ancestors[index - 1];
      return parent?.id?.name || parent?.key?.name || '<anonymous>';
    }
  }
  return '<top>';
}

function collectApplicationCommands(source) {
  let commands = null;
  let migratedSource = null;
  let buildersSource = null;
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        VariableDeclarator(node) {
          if (node.id?.type !== 'Identifier') return;
          if (!['DAEMON_HANDLER_BUILDERS', 'MIGRATED_DAEMON_COMMANDS'].includes(node.id.name)) return;
          const ancestors = sourceCode.getAncestors(node);
          const declaration = ancestors.at(-1);
          const program = ancestors.at(-2);
          if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const'
            || declaration.declarations.length !== 1 || program?.type !== 'Program') {
            throw new Error(`${node.id.name} must be one unique top-level const declaration`);
          }
          if (node.id.name === 'DAEMON_HANDLER_BUILDERS') {
            if (buildersSource !== null) throw new Error('DAEMON_HANDLER_BUILDERS must be declared exactly once');
            buildersSource = sourceCode.getText(node);
            return;
          }
          if (migratedSource !== null) throw new Error('MIGRATED_DAEMON_COMMANDS must be declared exactly once');
          migratedSource = sourceCode.getText(node);
          const call = node.init;
          const array = call?.type === 'CallExpression'
            && call.callee?.type === 'MemberExpression'
            && call.callee.object?.name === 'Object'
            && call.callee.property?.name === 'freeze'
            ? call.arguments[0]
            : null;
          if (array?.type !== 'ArrayExpression') throw new Error('MIGRATED_DAEMON_COMMANDS must freeze one literal array');
          commands = array.elements.map((element, index) => {
            if (element?.type !== 'Literal' || typeof element.value !== 'string') {
              throw new Error(`MIGRATED_DAEMON_COMMANDS[${index}] must be a string literal`);
            }
            return element.value;
          });
        },
      };
    },
  };
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { applications: rule } } },
    rules: { 'inventory/applications': 'error' },
  });
  if (messages.length) throw new Error(messages.map(message => message.message).join('\n'));
  if (!commands) throw new Error('MIGRATED_DAEMON_COMMANDS was not found');
  if (!buildersSource) throw new Error('DAEMON_HANDLER_BUILDERS was not found');
  const canonical = new Set(COMMAND_SURFACE.commands.map(command => command.name));
  if (new Set(commands).size !== commands.length) throw new Error('MIGRATED_DAEMON_COMMANDS contains duplicates');
  const unknown = commands.filter(command => !canonical.has(command));
  if (unknown.length) throw new Error(`MIGRATED_DAEMON_COMMANDS contains unknown commands: ${unknown.join(', ')}`);
  return {
    commands: new Set(commands),
    authorityDigest: digest(`${migratedSource}\0${buildersSource}`),
  };
}

function collectDaemonGroups(source) {
  let groups = null;
  let functionNode = null;
  let dispatchNode = null;
  const directCallsByCaseLine = new Map();
  const workflowCalls = new Map();
  let genericApplicationCalls = 0;
  const applicationWiring = Object.create(null);
  const applicationWiringNames = [
    'readCapabilities',
    'recordActionsBuilder',
    'exportPlaywrightBuilder',
    'dismissModalBuilder',
    'verifyClickBuilder',
    'diffShotBuilder',
    'scriptCapabilities',
    'actionCapabilities',
    'workflowCapabilities',
    'phase4Handlers',
  ];
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        FunctionDeclaration(node) {
          if (node.id?.name !== 'handleCommand') return;
          functionNode = node;
        },
        VariableDeclarator(node) {
          if (functionName(sourceCode, node) !== 'runDaemon' || node.id?.type !== 'Identifier') return;
          if (!applicationWiringNames.includes(node.id.name)) return;
          const ancestors = sourceCode.getAncestors(node);
          const declaration = ancestors.at(-1);
          const body = ancestors.at(-2);
          const owner = ancestors.at(-3);
          if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const'
            || declaration.declarations.length !== 1 || body?.type !== 'BlockStatement'
            || owner?.type !== 'FunctionDeclaration' || owner.id?.name !== 'runDaemon') {
            throw new Error(`${node.id.name} must be one direct runDaemon const declaration`);
          }
          if (applicationWiring[node.id.name]) {
            throw new Error(`${node.id.name} must be declared exactly once in runDaemon`);
          }
          applicationWiring[node.id.name] = sourceCode.getText(node);
        },
        SwitchStatement(node) {
          if (functionName(sourceCode, node) !== 'handleCommand'
            || node.discriminant.type !== 'Identifier'
            || node.discriminant.name !== 'cmd') return;
          if (groups) throw new Error('multiple handleCommand dispatch switches found');
          dispatchNode = node;
          const result = [];
          let labels = [];
          for (const branch of node.cases) {
            if (branch.test === null) {
              result.push({
                labels: ['<default>'],
                line: branch.loc.start.line,
                endLine: branch.loc.end.line,
                sourceDigest: digest(sourceCode.getText(branch)),
              });
              continue;
            }
            if (branch.test.type !== 'Literal' || typeof branch.test.value !== 'string') {
              throw new Error(`handleCommand case at line ${branch.loc.start.line} is not a string literal`);
            }
            labels.push(branch.test.value);
            if (branch.consequent.length === 0) continue;
            result.push({
              labels,
              line: branch.loc.start.line,
              endLine: branch.loc.end.line,
              sourceDigest: digest(labels.join('\0') + '\0' + branch.consequent.map(value => sourceCode.getText(value)).join('\n')),
              consequentSource: branch.consequent.map(value => sourceCode.getText(value)).join('\n'),
            });
            labels = [];
          }
          if (labels.length) throw new Error(`unterminated handleCommand cases: ${labels.join(', ')}`);
          groups = result;
        },
        CallExpression(node) {
          if (node.callee.type !== 'Identifier') return;
          if (!['executePhase4DaemonRoute', 'handleCommand'].includes(node.callee.name)) return;
          const ancestors = sourceCode.getAncestors(node);
          const workflowDeclarator = [...ancestors].reverse().find(ancestor => ancestor.type === 'VariableDeclarator'
            && ancestor.id?.type === 'Identifier' && ancestor.id.name === 'workflowCapabilities');
          if (node.callee.name === 'handleCommand' && workflowDeclarator) {
            const property = [...ancestors].reverse().find(ancestor => ancestor.type === 'Property'
              && ancestor.parent === workflowDeclarator.init);
            if (!property || property.computed || property.kind !== 'init') {
              throw new Error('workflow recursive call must belong to one direct capability property');
            }
            const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
            const calls = workflowCalls.get(name) || { count: 0, source: sourceCode.getText(property), line: property.loc.start.line };
            calls.count += 1;
            workflowCalls.set(name, calls);
            return;
          }
          const branch = [...sourceCode.getAncestors(node)].reverse().find(ancestor => ancestor.type === 'SwitchCase');
          const owner = [...sourceCode.getAncestors(node)].reverse().find(ancestor => ancestor.type === 'FunctionDeclaration');
          if (owner?.id?.name !== 'handleCommand') return;
          if (!branch) {
            if (node.callee.name === 'executePhase4DaemonRoute') genericApplicationCalls += 1;
            return;
          }
          const calls = directCallsByCaseLine.get(branch.loc.start.line) || [];
          calls.push(node.callee.name);
          directCallsByCaseLine.set(branch.loc.start.line, calls);
        },
      };
    },
  };
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { dispatch: rule } } },
    rules: { 'inventory/dispatch': 'error' },
  });
  if (messages.length) throw new Error(messages.map(message => message.message).join('\n'));
  if (!groups) throw new Error('handleCommand dispatch switch was not found');
  if (!functionNode || !dispatchNode) throw new Error('handleCommand wrapper was not found');
  if (applicationWiringNames.some(name => !applicationWiring[name])) {
    throw new Error('runDaemon application capability/handler wiring was not found');
  }
  if (genericApplicationCalls !== 1) {
    throw new Error(`handleCommand must contain exactly one general application dispatch call, received ${genericApplicationCalls}`);
  }
  const defaultBranch = dispatchNode.cases.find(branch => branch.test === null);
  if (!defaultBranch) throw new Error('handleCommand default branch was not found');
  const wrapper = {
    line: functionNode.loc.start.line,
    endLine: functionNode.loc.end.line,
    preludeDigest: digest(source.slice(functionNode.range[0], dispatchNode.range[0])),
    envelopeDigest: digest(source.slice(dispatchNode.range[1], functionNode.range[1])),
    defaultDigest: digest(source.slice(defaultBranch.range[0], defaultBranch.range[1])),
    applicationDispatchCalls: genericApplicationCalls,
    applicationWiringDigest: digest(
      applicationWiringNames.map(name => applicationWiring[name]).join('\0'),
    ),
  };
  const recursiveEdges = ['batch', 'flow', 'repeat', 'replay'].map(name => {
    const call = workflowCalls.get(name);
    if (!call || call.count !== 1) {
      throw new Error(`workflow capability ${name} must call handleCommand exactly once`);
    }
    return {
      from: name,
      to: 'handleCommand',
      line: call.line,
      sourceDigest: digest(call.source),
    };
  });
  const unexpectedWorkflowCalls = [...workflowCalls.keys()].filter(name => !['batch', 'flow', 'repeat', 'replay'].includes(name));
  if (unexpectedWorkflowCalls.length) {
    throw new Error(`unexpected recursive workflow capabilities: ${unexpectedWorkflowCalls.join(', ')}`);
  }
  return {
    groups: groups.map(group => ({
      ...group,
      directCalls: [...(directCallsByCaseLine.get(group.line) || [])],
    })),
    wrapper,
    recursiveEdges,
  };
}

function cmdLabelsFromCondition(node) {
  if (!node) return [];
  if (node.type === 'LogicalExpression') {
    return [...cmdLabelsFromCondition(node.left), ...cmdLabelsFromCondition(node.right)];
  }
  if (node.type === 'BinaryExpression' && ['===', '=='].includes(node.operator)) {
    if (node.left.type === 'Identifier' && node.left.name === 'cmd'
      && node.right.type === 'Literal' && typeof node.right.value === 'string') return [node.right.value];
    if (node.right.type === 'Identifier' && node.right.name === 'cmd'
      && node.left.type === 'Literal' && typeof node.left.value === 'string') return [node.left.value];
  }
  if (node.type === 'UnaryExpression' && node.operator === '!'
    && node.argument.type === 'Identifier' && node.argument.name === 'cmd') return ['<no-command>'];
  return [];
}

function collectMainBranches(source) {
  const branches = [];
  let guardLine = null;
  let mainFunction = null;
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        FunctionDeclaration(node) {
          if (node.id?.name === 'main') mainFunction = node;
        },
        IfStatement(node) {
          if (functionName(sourceCode, node) !== 'main') return;
          if (sourceCode.getText(node.test) === '!NEEDS_TARGET.has(cmd)') guardLine = node.loc.start.line;
          const labels = [...new Set(cmdLabelsFromCondition(node.test))];
          if (!labels.length) return;
          branches.push({
            labels,
            line: node.loc.start.line,
            endLine: node.consequent.loc.end.line,
            sourceDigest: digest(sourceCode.getText(node.test) + '\0' + sourceCode.getText(node.consequent)),
          });
        },
      };
    },
  };
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { main: rule } } },
    rules: { 'inventory/main': 'error' },
  });
  if (messages.length) throw new Error(messages.map(message => message.message).join('\n'));
  if (!guardLine) throw new Error('CLI target-command guard was not found');
  if (!mainFunction) throw new Error('main CLI function was not found');
  return {
    branches: branches.map(branch => ({
      ...branch,
      owner: branch.line < guardLine ? 'cli-direct' : 'target-argument-adapter',
    })),
    spine: {
      line: mainFunction.loc.start.line,
      endLine: mainFunction.loc.end.line,
      sourceDigest: digest(source.slice(mainFunction.range[0], mainFunction.range[1])),
    },
  };
}

export function buildRuntimeDispatchInventory(source = readFileSync(cdpPath, 'utf8')) {
  const applicationAuthority = collectApplicationCommands(source);
  const applicationCommandSet = applicationAuthority.commands;
  const bySpelling = new Map();
  for (const command of COMMAND_SURFACE.commands) {
    for (const spelling of [command.name, ...command.aliases]) bySpelling.set(spelling, command);
  }
  const { groups: rawDaemonGroups, wrapper: daemonWrapper, recursiveEdges } = collectDaemonGroups(source);
  if (JSON.stringify(recursiveEdges.map(edge => edge.from).sort())
    !== JSON.stringify(['batch', 'flow', 'repeat', 'replay'])) {
    throw new Error('recursive daemon routes must be exact direct handleCommand calls');
  }
  for (const group of rawDaemonGroups) {
    const count = group.directCalls.filter(call => call === 'handleCommand').length;
    if (count !== 0) throw new Error(`daemon branch ${group.labels.join('/')} must not call handleCommand directly`);
  }
  const daemonGroups = rawDaemonGroups.map(({ consequentSource: _consequentSource, directCalls, ...group }) => {
    if (group.labels[0] === '<default>') return { ...group, owner: 'unknown-command', commands: [] };
    const resolved = group.labels.map(label => bySpelling.get(label)).filter(Boolean);
    const unresolved = group.labels.filter(label => !bySpelling.has(label) && !PROTOCOL_COMMANDS.has(label));
    if (unresolved.length) throw new Error(`daemon branch has unknown route labels: ${unresolved.join(', ')}`);
    const canonical = [...new Set(resolved.map(command => command.name))];
    const protocolLabels = group.labels.filter(label => PROTOCOL_COMMANDS.has(label));
    if (protocolLabels.length && protocolLabels.length !== group.labels.length) {
      throw new Error(`daemon protocol route mixed with public commands: ${group.labels.join(', ')}`);
    }
    const protocol = protocolLabels.length === group.labels.length;
    if (!protocol && canonical.length !== 1) {
      throw new Error(`daemon branch ${group.labels.join('/')} does not resolve to one command`);
    }
    const applicationCallCount = directCalls.filter(call => call === 'executePhase4DaemonRoute').length;
    const expectedApplicationCalls = canonical.some(name => applicationCommandSet.has(name)) ? 1 : 0;
    if (applicationCallCount !== expectedApplicationCalls) {
      throw new Error(`daemon branch ${group.labels.join('/')} application ownership is invalid`);
    }
    const hasApplicationCall = applicationCallCount === 1;
    const owner = protocol
      ? 'daemon-protocol'
      : hasApplicationCall
        ? 'application-handler'
        : 'legacy-daemon-branch';
    const command = canonical.length === 1 ? bySpelling.get(group.labels.find(label => bySpelling.has(label))) : null;
    return {
      ...group,
      owner,
      commands: canonical,
      ...(command ? {
        policy: {
          kind: command.kind,
          authorization: command.authorization,
          evidencePolicy: command.evidencePolicy,
          outputFormats: [...command.outputFormats],
          needsTarget: command.needsTarget,
        },
      } : {}),
    };
  });

  const daemonLabels = daemonGroups.flatMap(group => group.labels).filter(label => label !== '<default>');
  const duplicateLabels = [...new Set(daemonLabels.filter((label, index) => daemonLabels.indexOf(label) !== index))];
  if (duplicateLabels.length) throw new Error(`duplicate daemon route labels: ${duplicateLabels.join(', ')}`);

  const targetCommands = COMMAND_SURFACE.commands.filter(command => command.needsTarget);
  const daemonCanonical = new Set([
    ...daemonGroups.flatMap(group => group.commands),
    ...applicationCommandSet,
  ]);
  const missingTargetCommands = targetCommands
    .map(command => command.name)
    .filter(name => !daemonCanonical.has(name));
  if (missingTargetCommands.length) {
    throw new Error(`target commands missing daemon routes: ${missingTargetCommands.join(', ')}`);
  }
  const requiredTargetSpellings = targetCommands.flatMap(command => [command.name, ...command.aliases]);
  const missingTargetSpellings = requiredTargetSpellings.filter(spelling => {
    const command = bySpelling.get(spelling);
    return !applicationCommandSet.has(command.name) && !daemonLabels.includes(spelling);
  });
  if (missingTargetSpellings.length) {
    throw new Error(`target command spellings missing daemon routes: ${missingTargetSpellings.join(', ')}`);
  }

  const { branches: mainBranches, spine: mainSpine } = collectMainBranches(source);
  const directLabels = mainBranches
    .filter(branch => branch.owner === 'cli-direct')
    .flatMap(branch => branch.labels);
  const duplicateDirectLabels = [...new Set(directLabels.filter((label, index) => directLabels.indexOf(label) !== index))];
  if (duplicateDirectLabels.length) throw new Error(`duplicate direct CLI route labels: ${duplicateDirectLabels.join(', ')}`);
  const targetless = COMMAND_SURFACE.commands
    .filter(command => !command.needsTarget)
    .map(command => ({
      name: command.name,
      aliases: [...command.aliases],
      kind: command.kind,
      authorization: command.authorization,
      evidencePolicy: command.evidencePolicy,
      outputFormats: [...command.outputFormats],
      owner: 'cli-direct',
    }));
  const expectedDirectLabels = [...new Set([
    ...targetless.flatMap(command => [command.name, ...command.aliases]),
    '<no-command>', '_daemon', '--help', '-h', 'wait',
  ])].sort();
  if (JSON.stringify([...directLabels].sort()) !== JSON.stringify(expectedDirectLabels)) {
    throw new Error('direct CLI routes do not exactly match targetless commands and bootstrap routes');
  }
  for (const branch of mainBranches.filter(value => value.owner === 'target-argument-adapter')) {
    for (const label of branch.labels) {
      const command = bySpelling.get(label);
      if (!command?.needsTarget) throw new Error(`unknown target-argument adapter route: ${label}`);
    }
  }
  const legacyCommands = [...new Set(daemonGroups
    .filter(group => group.owner === 'legacy-daemon-branch')
    .flatMap(group => group.commands))].sort();
  const applicationCommands = [...applicationCommandSet].sort();

  return {
    schema: 'chrome-cdp-ex.runtime-dispatch.v1',
    productVersion: '2.15.0',
    counts: {
      commands: COMMAND_SURFACE.commands.length,
      aliases: COMMAND_SURFACE.commands.flatMap(command => command.aliases).length,
      targetCommands: targetCommands.length,
      targetlessCommands: targetless.length,
      applicationCommands: applicationCommands.length,
      legacyDaemonCommands: legacyCommands.length,
      daemonGroups: daemonGroups.length,
    },
    applicationCommands,
    applicationAuthorityDigest: applicationAuthority.authorityDigest,
    targetless,
    mainBranches,
    mainSpine,
    daemonWrapper,
    daemonGroups,
    recursiveEdges,
    deletionAllowlist: legacyCommands.map(name => ({
      name,
      allowedDeletion: 'handleCommand switch branch only after application-handler parity',
    })),
    retainedAuthorities: [
      'command-surface catalog and projections',
      'command-application authorization/result/evidence contracts',
      'daemon protocol meta/list/list_raw/stop controls',
      'daemon state, event buffers, parsers, renderers, and browser operations',
      'BrowserSupervisor and per-tab daemon topology',
      'CLI targetless adapters and target-resolution adapter',
      'typed CDP domains and authorized raw gateway',
    ],
  };
}

function main(args) {
  const inventory = buildRuntimeDispatchInventory();
  const rendered = `${JSON.stringify(inventory, null, 2)}\n`;
  if (args.length === 1 && args[0] === '--write') {
    writeFileSync(fixturePath, rendered, { mode: 0o600 });
    process.stdout.write(`Wrote ${fixturePath}\n`);
    return;
  }
  if (args.length !== 0 && !(args.length === 1 && args[0] === '--check')) {
    throw new Error('Usage: node scripts/runtime-dispatch-inventory.mjs [--check|--write]');
  }
  const expected = readFileSync(fixturePath, 'utf8');
  if (expected !== rendered) throw new Error('Runtime dispatch fixture is stale; review the diff before --write');
  process.stdout.write(`Runtime dispatch OK: ${inventory.counts.commands} commands, ${inventory.counts.daemonGroups} daemon groups\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
