#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Linter } from 'eslint';

import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const packageVersion = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;
const fixturePath = resolve(rootDir, `docs/contracts/v${packageVersion}/runtime-dispatch.v1.json`);
const PROTOCOL_COMMANDS = new Set(['list', 'list_raw', 'meta', 'stop']);
const TABLE_POLICY_HELPERS = Object.freeze([
  'authorizeDaemonApplicationCommand',
  'daemonRequestMayHaveSideEffects',
  'isBatchParallelUnsafeCommand',
]);
const TABLE_CONTRACT_HELPERS = Object.freeze(['isTableCollectArgs', 'parseTableArgs']);

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

function namedFunctionOwner(sourceCode, node) {
  const ancestors = sourceCode.getAncestors(node);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor.type === 'FunctionDeclaration' && ancestor.id?.name) return ancestor.id.name;
    if (ancestor.type !== 'FunctionExpression' && ancestor.type !== 'ArrowFunctionExpression') continue;
    const parent = ancestors[index - 1];
    if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
    if (parent?.type === 'Property' && !parent.computed) return parent.key.name || parent.key.value;
  }
  return '<anonymous>';
}

function collectApplicationCommands(source) {
  let commands = null;
  let buildersSource = null;
  let preflightSource = null;
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        VariableDeclarator(node) {
          if (node.id?.type !== 'Identifier' || node.id.name !== 'DAEMON_HANDLER_BUILDERS') return;
          const ancestors = sourceCode.getAncestors(node);
          const declaration = ancestors.at(-1);
          const program = ancestors.at(-2);
          if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const'
            || declaration.declarations.length !== 1 || program?.type !== 'Program') {
            throw new Error(`${node.id.name} must be one unique top-level const declaration`);
          }
          if (buildersSource !== null) throw new Error('DAEMON_HANDLER_BUILDERS must be declared exactly once');
          buildersSource = sourceCode.getText(node);
          const call = node.init;
          const object = call?.type === 'CallExpression'
            && call.callee?.type === 'MemberExpression'
            && call.callee.object?.name === 'Object'
            && call.callee.property?.name === 'freeze'
            ? call.arguments[0]
            : null;
          if (object?.type !== 'ObjectExpression') {
            throw new Error('DAEMON_HANDLER_BUILDERS must freeze one literal object');
          }
          commands = object.properties.map((property, index) => {
            if (property?.type !== 'Property' || property.kind !== 'init' || property.method
              || property.computed && property.key?.type !== 'Literal') {
              throw new Error(`DAEMON_HANDLER_BUILDERS[${index}] must be one static data property`);
            }
            if (property.key?.type === 'Identifier') return property.key.name;
            if (property.key?.type === 'Literal' && typeof property.key.value === 'string') {
              return property.key.value;
            }
            throw new Error(`DAEMON_HANDLER_BUILDERS[${index}] must have a static string key`);
          });
        },
        FunctionDeclaration(node) {
          if (node.id?.name !== 'preflightDaemonApplication') return;
          const ancestors = sourceCode.getAncestors(node);
          if (ancestors.length !== 1 || ancestors[0]?.type !== 'Program') {
            throw new Error('preflightDaemonApplication must be one unique top-level function');
          }
          if (preflightSource !== null) {
            throw new Error('preflightDaemonApplication must be declared exactly once');
          }
          preflightSource = sourceCode.getText(node);
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
  if (!commands) throw new Error('DAEMON_HANDLER_BUILDERS was not found');
  if (!buildersSource) throw new Error('DAEMON_HANDLER_BUILDERS was not found');
  if (!preflightSource) throw new Error('preflightDaemonApplication was not found');
  if (new Set(commands).size !== commands.length) throw new Error('DAEMON_HANDLER_BUILDERS contains duplicates');
  const expected = COMMAND_SURFACE.commands
    .filter(command => command.needsTarget)
    .map(command => command.name)
    .sort();
  const actual = [...commands].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`DAEMON_HANDLER_BUILDERS must exactly cover all ${expected.length} target commands`);
  }
  return {
    commands: new Set(commands),
    authorityDigest: digest(`${buildersSource}\0${preflightSource}`),
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
    'responsiveAuditBuilder',
    'scriptCapabilities',
    'actionCapabilities',
    'workflowCapabilities',
    'applicationHandlers',
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
          if (!['executeDaemonApplicationRoute', 'handleCommand'].includes(node.callee.name)) return;
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
            if (node.callee.name === 'executeDaemonApplicationRoute') genericApplicationCalls += 1;
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

function collectTablePolicyAuthority(source) {
  const table = COMMAND_SURFACE.resolve('table');
  const expectedPolicy = {
    kind: 'conditional-mutation',
    authorization: 'conditional',
    evidencePolicy: 'none',
    mutates: false,
    outputFormats: ['text', 'json'],
  };
  const actualPolicy = table && {
    kind: table.kind,
    authorization: table.authorization,
    evidencePolicy: table.evidencePolicy,
    mutates: table.mutates,
    outputFormats: [...table.outputFormats],
  };
  if (JSON.stringify(actualPolicy) !== JSON.stringify(expectedPolicy)) {
    throw new Error('table policy authority: catalog policy must remain conditional-mutation/conditional with text+json');
  }

  const declarations = new Map();
  const calls = new Map([...TABLE_POLICY_HELPERS, ...TABLE_CONTRACT_HELPERS].map(name => [name, []]));
  let tableContractImport = null;
  let authorizeBinding = null;
  let tableCapabilityBinding = null;
  const failTable = message => { throw new Error(`table policy authority: ${message}`); };
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          if (node.source?.value !== './lib/table-contract.mjs') return;
          if (tableContractImport) failTable('table-contract helpers must have one unique import');
          const names = node.specifiers.map(specifier => {
            if (specifier.type !== 'ImportSpecifier'
              || specifier.imported?.type !== 'Identifier'
              || specifier.local?.name !== specifier.imported.name) {
              failTable('table-contract helpers must use direct named imports without aliases');
            }
            return specifier.imported.name;
          }).sort();
          if (JSON.stringify(names) !== JSON.stringify([...TABLE_CONTRACT_HELPERS].sort())) {
            failTable(`table-contract import must exactly bind ${TABLE_CONTRACT_HELPERS.join(', ')}`);
          }
          tableContractImport = sourceCode.getText(node);
        },
        FunctionDeclaration(node) {
          const name = node.id?.name;
          if (![...TABLE_POLICY_HELPERS, ...TABLE_CONTRACT_HELPERS].includes(name)) return;
          if (TABLE_CONTRACT_HELPERS.includes(name)) failTable(`${name} must not be shadowed`);
          const ancestors = sourceCode.getAncestors(node);
          if (ancestors.length !== 1 || ancestors[0]?.type !== 'Program') {
            failTable(`${name} must be one unique top-level function`);
          }
          if (declarations.has(name)) failTable(`${name} must be declared exactly once`);
          const parameters = node.params.map(parameter => sourceCode.getText(parameter));
          const expectedParameters = {
            authorizeDaemonApplicationCommand: ['{ command, args = [], policy, mutates, targetBound }'],
            daemonRequestMayHaveSideEffects: ['request = {}'],
            isBatchParallelUnsafeCommand: ['cmd', 'args = []'],
          }[name];
          if (JSON.stringify(parameters) !== JSON.stringify(expectedParameters)) {
            failTable(`${name} must retain its argv-aware parameter contract`);
          }
          declarations.set(name, sourceCode.getText(node));
        },
        VariableDeclarator(node) {
          const name = node.id?.type === 'Identifier' ? node.id.name : null;
          if ([...TABLE_POLICY_HELPERS, ...TABLE_CONTRACT_HELPERS].includes(name)) {
            failTable(`${name} must not be shadowed by a variable`);
          }
          if (name !== 'readCapabilities') return;
          const properties = node.init?.type === 'ObjectExpression'
            ? node.init.properties.filter(property => property.type === 'Property'
              && !property.computed
              && (property.key.name || property.key.value) === 'table')
            : [];
          if (properties.length !== 1) failTable('readCapabilities.table must be bound exactly once');
          const binding = sourceCode.getText(properties[0]);
          if (binding !== 'table: request => tableStr(cdp, sessionId, request.selector)') {
            failTable('readCapabilities.table must pass only the parsed selector to the legacy page bridge');
          }
          if (tableCapabilityBinding) failTable('readCapabilities.table must be bound exactly once');
          tableCapabilityBinding = binding;
        },
        Property(node) {
          if (functionName(sourceCode, node) !== 'runDaemon' || node.computed) return;
          if ((node.key.name || node.key.value) !== 'authorize') return;
          const binding = sourceCode.getText(node);
          if (binding !== 'authorize: authorizeDaemonApplicationCommand') {
            failTable('daemon dispatcher must directly bind authorizeDaemonApplicationCommand');
          }
          if (authorizeBinding) failTable('daemon authorizer must be bound exactly once');
          authorizeBinding = binding;
        },
        CallExpression(node) {
          const name = node.callee?.type === 'Identifier' ? node.callee.name : null;
          if (!calls.has(name)) return;
          calls.get(name).push({
            owner: namedFunctionOwner(sourceCode, node),
            source: sourceCode.getText(node),
          });
        },
      };
    },
  };
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { 'table-policy': rule } } },
    rules: { 'inventory/table-policy': 'error' },
  });
  if (messages.length) failTable(messages.map(message => message.message).join('\n'));
  if (!tableContractImport) failTable('table-contract helper import was not found');
  if (TABLE_POLICY_HELPERS.some(name => !declarations.has(name))) {
    failTable('all policy helpers must be declared exactly once');
  }
  const expectedCalls = {
    isTableCollectArgs: [
      { owner: 'daemonRequestMayHaveSideEffects', source: 'isTableCollectArgs(request.args || [])' },
      { owner: 'isBatchParallelUnsafeCommand', source: 'isTableCollectArgs(args)' },
    ],
    parseTableArgs: [
      { owner: 'authorizeDaemonApplicationCommand', source: 'parseTableArgs(args)' },
    ],
    isBatchParallelUnsafeCommand: [
      { owner: 'batch', source: 'isBatchParallelUnsafeCommand(command.cmd, command.args || [])' },
    ],
    daemonRequestMayHaveSideEffects: [
      { owner: 'sendCommand', source: 'daemonRequestMayHaveSideEffects(req)' },
    ],
    authorizeDaemonApplicationCommand: [],
  };
  for (const [name, expected] of Object.entries(expectedCalls)) {
    const actual = calls.get(name).sort((left, right) => left.source.localeCompare(right.source));
    const sortedExpected = [...expected].sort((left, right) => left.source.localeCompare(right.source));
    if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
      failTable(`${name} calls must exactly match the reviewed argv-aware bindings`);
    }
  }
  if (!authorizeBinding) failTable('daemon authorizer binding was not found');
  if (!tableCapabilityBinding) failTable('legacy table capability binding was not found');
  const helperSources = TABLE_POLICY_HELPERS.map(name => declarations.get(name));
  return {
    policy: expectedPolicy,
    helpers: [...TABLE_POLICY_HELPERS],
    sourceDigest: digest([tableContractImport, ...helperSources].join('\0')),
    bindingDigest: digest([
      authorizeBinding,
      tableCapabilityBinding,
      ...Object.values(expectedCalls).flat().map(call => `${call.owner}:${call.source}`).sort(),
    ].join('\0')),
  };
}

export function buildRuntimeDispatchInventory(source = readFileSync(cdpPath, 'utf8')) {
  const applicationAuthority = collectApplicationCommands(source);
  const tablePolicyAuthority = collectTablePolicyAuthority(source);
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
    const applicationCallCount = directCalls.filter(call => call === 'executeDaemonApplicationRoute').length;
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
    productVersion: packageVersion,
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
    tablePolicyAuthority,
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
