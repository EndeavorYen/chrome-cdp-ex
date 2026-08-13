#!/usr/bin/env node

import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Linter } from 'eslint';

import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const mcpAdapterPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const daemonReadHandlersPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs');
const tableArtifactsPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs');
const tableContractPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-contract.mjs');
const tableExtractionPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs');
const tableSamplerPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-sampler.mjs');
const commandApplicationPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/lib/command-application.mjs');
const packageVersion = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;
const fixturePath = resolve(rootDir, `docs/contracts/v${packageVersion}/runtime-dispatch.v1.json`);
const PROTOCOL_COMMANDS = new Set(['list', 'list_raw', 'meta', 'stop']);
const TABLE_POLICY_HELPERS = Object.freeze([
  'authorizeDaemonApplicationCommand',
  'daemonRequestMayHaveSideEffects',
  'isBatchParallelUnsafeCommand',
]);
const TABLE_CONTRACT_HELPERS = Object.freeze([
  'isTableCollectArgs',
  'parseTableArgs',
  'parseTableContinuationToken',
]);
const TABLE_OBSERVATION_OWNERS = Object.freeze([
  'sampleRootFrameTables',
  'validAriaIdentity',
  'observedTableEntry',
  'tableObservationModel',
  'boundedTableObservationJson',
  'boundedTableObservationText',
  'boundedTableObservationEmissionJson',
  'boundedTableObservationEmissionText',
  'tableObservationStr',
  'emitTargetCommandResponse',
]);

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

function bindingEntries(sourceCode, name) {
  const entries = [];
  for (const scope of sourceCode.scopeManager.scopes) {
    for (const variable of scope.variables) {
      if (variable.name === name) entries.push({ scope, variable });
    }
  }
  return entries;
}

function requireUniqueBinding(sourceCode, name, {
  definitionType,
  importSource = null,
  topLevel = true,
  allowInitializationWrite = false,
} = {}, fail) {
  const entries = bindingEntries(sourceCode, name);
  if (entries.length !== 1) fail(`${name} must resolve to one unique trusted binding`);
  const [{ scope, variable }] = entries;
  if (topLevel && scope.type !== 'module') fail(`${name} must be bound at module scope`);
  if (variable.defs.length !== 1 || variable.defs[0].type !== definitionType) {
    fail(`${name} must retain its reviewed ${definitionType} binding`);
  }
  const definition = variable.defs[0];
  if (definitionType === 'ImportBinding') {
    if (definition.node?.type !== 'ImportSpecifier'
      || definition.node.imported?.name !== name
      || definition.node.local?.name !== name
      || definition.parent?.source?.value !== importSource) {
      fail(`${name} must use one direct named import from ${importSource}`);
    }
  }
  for (const reference of variable.references) {
    if (reference.isWrite() && !(allowInitializationWrite && reference.init === true)) {
      fail(`${name} must not be reassigned`);
    }
  }
  return variable;
}

function requireUnshadowedGlobalReference(sourceCode, identifier, name, fail) {
  const reference = sourceCode.scopeManager.scopes
    .flatMap(scope => scope.references)
    .find(candidate => candidate.identifier === identifier);
  if (!reference || identifier.name !== name
    || (reference.resolved !== null && reference.resolved.defs.length !== 0)) {
    fail(`${name} must resolve to the unshadowed global binding`);
  }
}

function verifyWithRule(source, ruleName, rule, fail) {
  const messages = new Linter().verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { inventory: { rules: { [ruleName]: rule } } },
    rules: { [`inventory/${ruleName}`]: 'error' },
  });
  if (messages.length) fail(messages.map(message => message.message).join('\n'));
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

function collectMcpTablePolicyAuthority(source, fail) {
  let sourceCode = null;
  let importSource = null;
  let argsRequireConfirmSource = null;
  let buildMcpToolCommandSource = null;
  let requireConfirmSource = null;
  let runCommandBinding = null;
  const parserCalls = [];
  const confirmationCalls = [];
  const rule = {
    create(context) {
      sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          if (node.source?.value !== './table-contract.mjs') return;
          if (importSource !== null) fail('MCP table-contract import must be unique');
          if (node.specifiers.length !== 1
            || node.specifiers[0].type !== 'ImportSpecifier'
            || node.specifiers[0].imported?.name !== 'parseTableRunCommandArgs'
            || node.specifiers[0].local?.name !== 'parseTableRunCommandArgs') {
            fail('MCP must directly import only parseTableRunCommandArgs from table-contract');
          }
          importSource = sourceCode.getText(node);
        },
        FunctionDeclaration(node) {
          if (node.id?.name === 'buildMcpToolCommand') {
            if (buildMcpToolCommandSource !== null) fail('MCP buildMcpToolCommand must be unique');
            buildMcpToolCommandSource = sourceCode.getText(node);
          }
          if (node.id?.name === 'requireConfirm') {
            if (requireConfirmSource !== null) fail('MCP requireConfirm must be unique');
            if (node.params.map(parameter => sourceCode.getText(parameter)).join('\0') !== 'args\0action') {
              fail('MCP requireConfirm must retain its confirmation parameters');
            }
            requireConfirmSource = sourceCode.getText(node);
          }
          if (node.id?.name === 'argsRequireConfirm') {
            if (argsRequireConfirmSource !== null) fail('MCP argsRequireConfirm must be unique');
            if (node.params.map(parameter => sourceCode.getText(parameter)).join('\0') !== 'commandName\0args = []') {
              fail('MCP argsRequireConfirm must retain its argv-aware parameters');
            }
            argsRequireConfirmSource = sourceCode.getText(node);
          }
        },
        IfStatement(node) {
          if (namedFunctionOwner(sourceCode, node) !== 'argsRequireConfirm') return;
          const statement = sourceCode.getText(node);
          if (!statement.startsWith("if (command.name === 'table')")) return;
          if (runCommandBinding !== null) fail('MCP table confirmation branch must be unique');
          if (statement !== "if (command.name === 'table') return parseTableRunCommandArgs(args).request.mode === 'collect';") {
            fail('MCP table confirmation must directly return the canonical collect classification');
          }
          runCommandBinding = statement;
        },
        CallExpression(node) {
          if (node.callee?.type !== 'Identifier') return;
          const owner = namedFunctionOwner(sourceCode, node);
          const callSource = sourceCode.getText(node);
          if (node.callee.name === 'parseTableRunCommandArgs') {
            parserCalls.push({ owner, source: callSource });
          } else if (node.callee.name === 'argsRequireConfirm') {
            confirmationCalls.push({ owner, source: callSource });
          }
        },
        'Program:exit'() {
          requireUniqueBinding(sourceCode, 'parseTableRunCommandArgs', {
            definitionType: 'ImportBinding',
            importSource: './table-contract.mjs',
          }, fail);
          requireUniqueBinding(sourceCode, 'argsRequireConfirm', { definitionType: 'FunctionName' }, fail);
          requireUniqueBinding(sourceCode, 'buildMcpToolCommand', { definitionType: 'FunctionName' }, fail);
          requireUniqueBinding(sourceCode, 'requireConfirm', { definitionType: 'FunctionName' }, fail);
        },
      };
    },
  };
  verifyWithRule(source, 'mcp-table-policy', rule, fail);
  if (!importSource || !argsRequireConfirmSource || !buildMcpToolCommandSource
    || !requireConfirmSource || !runCommandBinding) {
    fail('MCP table confirmation authority was not found');
  }
  if (JSON.stringify(parserCalls) !== JSON.stringify([{
    owner: 'argsRequireConfirm',
    source: 'parseTableRunCommandArgs(args)',
  }])) {
    fail('MCP parseTableRunCommandArgs call must be live and unique in argsRequireConfirm');
  }
  if (JSON.stringify(confirmationCalls) !== JSON.stringify([{
    owner: 'buildMcpToolCommand',
    source: 'argsRequireConfirm(commandName, extra)',
  }])) {
    fail('MCP run_command must consult argsRequireConfirm with the exact argv');
  }
  return {
    // The confirmation path begins at hostile MCP input snapshotting. Bind the
    // complete adapter module so edits to snapshot/proxy/import dependencies,
    // confirmation helpers, or post-confirm argv handling always drift.
    source,
    binding: [runCommandBinding, ...parserCalls.map(call => call.source), ...confirmationCalls.map(call => call.source)].join('\0'),
  };
}

function collectDaemonTablePolicyAuthority(source, fail) {
  let sourceCode = null;
  let importSource = null;
  let factorySource = null;
  let tableHandlerSource = null;
  const parserCalls = [];
  const rule = {
    create(context) {
      sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          if (node.source?.value !== './table-contract.mjs') return;
          if (importSource !== null) fail('daemon read-handler table-contract import must be unique');
          if (node.specifiers.length !== 1
            || node.specifiers[0].type !== 'ImportSpecifier'
            || node.specifiers[0].imported?.name !== 'parseTableArgs'
            || node.specifiers[0].local?.name !== 'parseTableArgs') {
            fail('daemon read handler must directly import only parseTableArgs from table-contract');
          }
          importSource = sourceCode.getText(node);
        },
        FunctionDeclaration(node) {
          if (node.id?.name !== 'createDaemonReadHandlers') return;
          if (factorySource !== null) fail('createDaemonReadHandlers must be unique');
          if (node.params.length !== 1 || sourceCode.getText(node.params[0]) !== 'input') {
            fail('createDaemonReadHandlers must retain its input parameter');
          }
          factorySource = sourceCode.getText(node);
        },
        Property(node) {
          if (node.computed || (node.key.name || node.key.value) !== 'table') return;
          const ancestors = sourceCode.getAncestors(node);
          const implementations = [...ancestors].reverse().find(ancestor => ancestor.type === 'VariableDeclarator'
            && ancestor.id?.type === 'Identifier' && ancestor.id.name === 'implementations');
          const factory = [...ancestors].reverse().find(ancestor => ancestor.type === 'FunctionDeclaration'
            && ancestor.id?.name === 'createDaemonReadHandlers');
          if (!implementations || !factory) return;
          if (tableHandlerSource !== null) fail('daemon read-handler table implementation must be unique');
          tableHandlerSource = sourceCode.getText(node);
        },
        CallExpression(node) {
          if (node.callee?.type !== 'Identifier' || node.callee.name !== 'parseTableArgs') return;
          const ancestors = sourceCode.getAncestors(node);
          const declarator = ancestors.at(-1);
          const declaration = ancestors.at(-2);
          const block = ancestors.at(-3);
          const arrow = ancestors.at(-4);
          const property = ancestors.at(-5);
          const direct = declarator?.type === 'VariableDeclarator'
            && declarator.id?.type === 'Identifier'
            && declarator.id.name === 'request'
            && declarator.init === node
            && declaration?.type === 'VariableDeclaration'
            && declaration.kind === 'const'
            && declaration.declarations.length === 1
            && block?.type === 'BlockStatement'
            && block.body[0] === declaration
            && arrow?.type === 'ArrowFunctionExpression'
            && arrow.body === block
            && property?.type === 'Property'
            && !property.computed
            && (property.key.name || property.key.value) === 'table';
          parserCalls.push({
            direct,
            owner: namedFunctionOwner(sourceCode, node),
            source: sourceCode.getText(node),
          });
        },
        'Program:exit'() {
          requireUniqueBinding(sourceCode, 'parseTableArgs', {
            definitionType: 'ImportBinding',
            importSource: './table-contract.mjs',
          }, fail);
          requireUniqueBinding(sourceCode, 'createDaemonReadHandlers', { definitionType: 'FunctionName' }, fail);
        },
      };
    },
  };
  verifyWithRule(source, 'daemon-table-policy', rule, fail);
  if (!importSource || !factorySource || !tableHandlerSource) {
    fail('daemon table read-handler authority was not found');
  }
  if (JSON.stringify(parserCalls) !== JSON.stringify([{
    direct: true,
    owner: 'table',
    source: 'parseTableArgs(snapshotArgs(context))',
  }])) {
    fail('daemon table parser must be one direct first statement in the table handler');
  }
  return {
    source: [importSource, factorySource].join('\0'),
    binding: [tableHandlerSource, parserCalls[0].source].join('\0'),
  };
}

function collectTableContractAuthority(source, fail) {
  let sourceCode = null;
  const functionSources = new Map();
  const parserCalls = [];
  const tokenParserCalls = [];
  let collectBinding = null;
  let tokenRegexSource = null;
  const trustedFunctions = [
    'isTableCollectArgs', 'parseSnapshot', 'parseTableArgs',
    'parseTableContinuationToken', 'parseTableRunCommandArgs',
  ];
  const rule = {
    create(context) {
      sourceCode = context.sourceCode;
      return {
        VariableDeclarator(node) {
          if (node.id?.type !== 'Identifier' || node.id.name !== 'CONTINUATION_TOKEN_RE') return;
          if (tokenRegexSource !== null) fail('CONTINUATION_TOKEN_RE must be unique in table-contract');
          tokenRegexSource = sourceCode.getText(node);
        },
        FunctionDeclaration(node) {
          const name = node.id?.name;
          if (!trustedFunctions.includes(name)) return;
          if (functionSources.has(name)) fail(`${name} must be unique in table-contract`);
          functionSources.set(name, sourceCode.getText(node));
          if (name !== 'isTableCollectArgs') return;
          if (node.params.length !== 1 || sourceCode.getText(node.params[0]) !== 'input'
            || node.body.body.length !== 1
            || node.body.body[0].type !== 'ReturnStatement') {
            fail('isTableCollectArgs must be one direct parser-backed return');
          }
          const statement = sourceCode.getText(node.body.body[0]);
          if (statement !== "return parseTableArgs(input).mode === 'collect';") {
            fail('isTableCollectArgs must directly return canonical parser mode collect');
          }
          collectBinding = statement;
        },
        CallExpression(node) {
          if (node.callee?.type !== 'Identifier') return;
          const target = node.callee.name === 'parseTableArgs'
            ? parserCalls
            : node.callee.name === 'parseTableContinuationToken'
              ? tokenParserCalls
              : null;
          if (!target) return;
          target.push({
            owner: namedFunctionOwner(sourceCode, node),
            source: sourceCode.getText(node),
          });
        },
        'Program:exit'() {
          for (const name of trustedFunctions) {
            requireUniqueBinding(sourceCode, name, { definitionType: 'FunctionName' }, fail);
          }
        },
      };
    },
  };
  verifyWithRule(source, 'table-contract-policy', rule, fail);
  if (trustedFunctions.some(name => !functionSources.has(name)) || !collectBinding || !tokenRegexSource) {
    fail('canonical table-contract helper authority was not found');
  }
  if (JSON.stringify(parserCalls) !== JSON.stringify([{
    owner: 'isTableCollectArgs',
    source: 'parseTableArgs(input)',
  }])) {
    fail('isTableCollectArgs must delegate exactly once to parseTableArgs(input)');
  }
  if (JSON.stringify(tokenParserCalls) !== JSON.stringify([{
    owner: 'parseSnapshot',
    source: 'parseTableContinuationToken(continuation)',
  }])) {
    fail('parseSnapshot must delegate exactly once to parseTableContinuationToken(continuation)');
  }
  return {
    source: [tokenRegexSource, ...trustedFunctions.map(name => functionSources.get(name))].join('\0'),
    binding: [collectBinding, parserCalls[0].source, tokenParserCalls[0].source].join('\0'),
  };
}

function collectCommandApplicationTableAuthority(source, fail) {
  let sourceCode = null;
  let executeSource = null;
  let authorizationBinding = null;
  let calls = 0;
  const expectedProperties = {
    command: 'spec.name',
    args: 'request.args',
    policy: 'spec.authorization',
    mutates: 'spec.mutates',
    targetBound: 'request.targetBound',
  };
  const rule = {
    create(context) {
      sourceCode = context.sourceCode;
      return {
        FunctionDeclaration(node) {
          if (node.id?.name !== 'executeCommand') return;
          if (executeSource !== null) fail('command-application executeCommand must be unique');
          executeSource = sourceCode.getText(node);
        },
        CallExpression(node) {
          if (node.callee?.type !== 'MemberExpression'
            || node.callee.computed
            || node.callee.object?.name !== 'contextValue'
            || node.callee.property?.name !== 'authorize') return;
          calls += 1;
          if (namedFunctionOwner(sourceCode, node) !== 'executeCommand') {
            fail('command-application authorizer call must belong to executeCommand');
          }
          const freezeCall = node.arguments[0];
          const object = freezeCall?.type === 'CallExpression'
            && freezeCall.callee?.type === 'MemberExpression'
            && !freezeCall.callee.computed
            && freezeCall.callee.object?.name === 'Object'
            && freezeCall.callee.property?.name === 'freeze'
            && freezeCall.arguments.length === 1
            ? freezeCall.arguments[0]
            : null;
          if (object?.type !== 'ObjectExpression') {
            fail('command-application authorizer must receive one frozen request envelope');
          }
          const actual = Object.create(null);
          for (const property of object.properties) {
            if (property.type !== 'Property' || property.computed || property.kind !== 'init') {
              fail('command-application authorization envelope must contain static data properties');
            }
            actual[property.key.name || property.key.value] = sourceCode.getText(property.value);
          }
          if (JSON.stringify(actual) !== JSON.stringify(expectedProperties)) {
            fail('command-application authorization envelope must forward exact request argv and policy');
          }
          authorizationBinding = sourceCode.getText(node);
        },
        'Program:exit'() {
          requireUniqueBinding(sourceCode, 'executeCommand', { definitionType: 'FunctionName' }, fail);
        },
      };
    },
  };
  verifyWithRule(source, 'command-application-table-policy', rule, fail);
  if (!executeSource || !authorizationBinding || calls !== 1) {
    fail('command-application authorizer must be bound exactly once');
  }
  return {
    source: executeSource,
    binding: authorizationBinding,
  };
}

function collectTableArtifactAuthority(source, tableExtractionSource, fail) {
  let sourceCode = null;
  let productionFactorySource = null;
  let testFactorySource = null;
  const safetyFunctions = new Map();
  const requiredFunctions = [
    'publish', 'readContinuation', 'rollbackRequest', 'releaseRequest', 'cleanupSession',
    'sweepCrashResidue', 'provenDeadProcess', 'validateBundle',
  ];
  const rule = {
    create(context) {
      sourceCode = context.sourceCode;
      return {
        FunctionDeclaration(node) {
          const name = node.id?.name;
          if (name === 'createTableArtifactStore') {
            if (productionFactorySource !== null) fail('createTableArtifactStore must be unique');
            if (node.params.length !== 1 || sourceCode.getText(node.params[0]) !== 'input') {
              fail('production table artifact factory must accept only input');
            }
            productionFactorySource = sourceCode.getText(node);
          }
          if (name === 'createTableArtifactStoreWithDependencies') {
            if (testFactorySource !== null) fail('table artifact test factory must be unique');
            testFactorySource = sourceCode.getText(node);
          }
          if (!requiredFunctions.includes(name)) return;
          if (safetyFunctions.has(name)) fail(`${name} must be unique in table-artifacts`);
          safetyFunctions.set(name, sourceCode.getText(node));
        },
        'Program:exit'() {
          requireUniqueBinding(sourceCode, 'createTableArtifactStore', { definitionType: 'FunctionName' }, fail);
          requireUniqueBinding(sourceCode, 'createTableArtifactStoreWithDependencies', { definitionType: 'FunctionName' }, fail);
          for (const name of requiredFunctions) {
            requireUniqueBinding(sourceCode, name, { definitionType: 'FunctionName' }, fail);
          }
        },
      };
    },
  };
  verifyWithRule(source, 'table-artifact-authority', rule, fail);
  if (!productionFactorySource || !testFactorySource
    || requiredFunctions.some(name => !safetyFunctions.has(name))) {
    fail('table artifact factory and lifecycle authority was not found');
  }
  if (!productionFactorySource.includes('return makeStore(input, DEFAULT_DEPENDENCIES);')) {
    fail('production table artifact factory must use only default dependencies');
  }
  if (!source.includes("if (state.platform === 'win32')")) {
    fail('table artifact Windows fail-closed gate was not found');
  }
  if (!safetyFunctions.get('provenDeadProcess').includes("return error?.code === 'ESRCH';")) {
    fail('table artifact liveness proof must require ESRCH');
  }
  const extractionBindings = [
    'const exportBundles = new WeakMap();',
    'export function buildTableExportBundle(accumulator, options)',
    'exportBundles.set(bundle, Object.freeze({ manifest, rowsTsv }));',
    'export function inspectTableExportBundle(bundle)',
    'const trusted = exportBundles.get(bundle);',
  ];
  if (extractionBindings.some(binding => !tableExtractionSource.includes(binding))) {
    fail('trusted table export bundle authority was not found');
  }
  return {
    source: [source, tableExtractionSource].join('\0'),
    binding: [
      productionFactorySource,
      testFactorySource,
      ...requiredFunctions.map(name => safetyFunctions.get(name)),
      ...extractionBindings,
    ].join('\0'),
  };
}

function collectTableObservationAuthority(source, tableSamplerSource, tableExtractionSource, fail) {
  const supportOwners = [
    'boundedTableRuntimeDiagnostic',
    'orderedTableObservationEnvelope',
    'trimTrailingTableObservationPreview',
  ];
  const allOwners = [...TABLE_OBSERVATION_OWNERS, ...supportOwners];
  const functionSources = new Map();
  let samplerImport = null;
  let extractionImport = null;
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          const importSource = node.source?.value;
          if (importSource !== './lib/table-sampler.mjs'
            && importSource !== './lib/table-extraction.mjs') return;
          const names = node.specifiers.map(specifier => {
            if (specifier.type !== 'ImportSpecifier'
              || specifier.imported?.type !== 'Identifier'
              || specifier.local?.name !== specifier.imported.name) {
              fail('table observation imports must be direct named imports without aliases');
            }
            return specifier.imported.name;
          });
          if (importSource === './lib/table-sampler.mjs') {
            if (samplerImport !== null) fail('table sampler import must be unique');
            if (JSON.stringify([...names].sort()) !== JSON.stringify([
              'buildTableSamplerExpression', 'parseTableSamplerResult',
            ])) {
              fail('table sampler import must bind the exact observation helpers');
            }
            samplerImport = sourceCode.getText(node);
            return;
          }
          if (extractionImport !== null) fail('table extraction import must be unique');
          if (JSON.stringify([...names].sort()) !== JSON.stringify([
            'TABLE_EXTRACTION_LIMITS',
            'addTableSampleBatch',
            'canonicalizeTableCells',
            'createTableAccumulator',
            'finalizeTableExtraction',
          ].sort())) {
            fail('table extraction import must bind the exact observation bridge');
          }
          extractionImport = sourceCode.getText(node);
        },
        FunctionDeclaration(node) {
          const name = node.id?.name;
          if (!allOwners.includes(name)) return;
          const ancestors = sourceCode.getAncestors(node);
          if (ancestors.length !== 1 || ancestors[0]?.type !== 'Program') {
            fail(`${name} must be one unique top-level observation owner`);
          }
          if (functionSources.has(name)) fail(`${name} observation owner must be unique`);
          functionSources.set(name, sourceCode.getText(node));
        },
        'Program:exit'() {
          for (const name of ['buildTableSamplerExpression', 'parseTableSamplerResult']) {
            requireUniqueBinding(sourceCode, name, {
              definitionType: 'ImportBinding',
              importSource: './lib/table-sampler.mjs',
            }, fail);
          }
          for (const name of [
            'TABLE_EXTRACTION_LIMITS',
            'addTableSampleBatch',
            'canonicalizeTableCells',
            'createTableAccumulator',
            'finalizeTableExtraction',
          ]) {
            requireUniqueBinding(sourceCode, name, {
              definitionType: 'ImportBinding',
              importSource: './lib/table-extraction.mjs',
            }, fail);
          }
          for (const name of allOwners) {
            requireUniqueBinding(sourceCode, name, { definitionType: 'FunctionName' }, fail);
          }
        },
      };
    },
  };
  verifyWithRule(source, 'table-observation-authority', rule, fail);
  if (!samplerImport || !extractionImport
    || allOwners.some(name => !functionSources.has(name))) {
    fail('complete table observation owner set was not found');
  }

  const samplerBindings = [
    'export function parseTableObservationSelector(value)',
    'export function parseTableSamplerResult(value)',
    "export function buildTableSamplerExpression(selector = 'table')",
    'const MAX_SELECTOR_COMPONENTS = 32;',
    'const MAX_SELECTOR_VALUE_BYTES = 256;',
    'maxClassScanUnits: 4096,',
    'const selectorSpecLiteral = JSON.stringify(parseTableObservationSelector(selector));',
    'const matchesTableSelector = value => {',
    "const hasAttribute = getOwnPropertyDescriptor(elementProto, 'hasAttribute').value;",
    "pageTruncationReason = 'selector-evaluation-limit';",
    "invalid(`${name} truncation reason loses precedence to row-limit`);",
    "invalid(`${name} data rows violate the producer header prefix`);",
    "invalid('sample sample-byte-limit provenance loses precedence to table-limit');",
  ];
  if (samplerBindings.some(binding => !tableSamplerSource.includes(binding))) {
    fail('bounded table sampler/parser authority was not found');
  }
  const extractionBindings = [
    'export const TABLE_EXTRACTION_LIMITS = Object.freeze({',
    'export function createTableAccumulator(options)',
    'export function addTableSampleBatch(accumulator, samples)',
    'export function finalizeTableExtraction(accumulator, options)',
    'export function canonicalizeTableCells(cells)',
  ];
  if (extractionBindings.some(binding => !tableExtractionSource.includes(binding))) {
    fail('Task-1 table extraction authority was not found');
  }

  const sampleOwner = functionSources.get('sampleRootFrameTables');
  const exactSampleBindings = [
    "const expression = buildTableSamplerExpression(selector || 'table');",
    'cdpDomains(cdp).Page.getFrameTree({}, sid)',
    `cdpDomains(cdp).Page.createIsolatedWorld({
    frameId,
    worldName: 'chrome-cdp-ex-table-sampler-v1',
    grantUniveralAccess: false,
  }, sid)`,
    `cdpDomains(cdp).Runtime.evaluate({
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: false,
  }, sid)`,
    'return parseTableSamplerResult(evaluated.result.value);',
  ];
  const isolatedWorldDenied = 'grantUniveralAccess: false,';
  const evaluateByValueNoAwait = '    returnByValue: true,\n    awaitPromise: false,';
  if (exactSampleBindings.some(binding => !sampleOwner.includes(binding))
    || (sampleOwner.match(/cdpDomains\(cdp\)\./g) || []).length !== 3
    || sampleOwner.indexOf(exactSampleBindings[0]) > sampleOwner.indexOf(exactSampleBindings[1])
    || source.split(isolatedWorldDenied).length !== 4
    || source.includes('grantUniveralAccess: true')
    || source.split(evaluateByValueNoAwait).length !== 3
    || source.includes('    returnByValue: false,\n    awaitPromise: true,')) {
    fail('root-frame sampler must validate first and retain the exact three-call CDP sequence');
  }

  const entryOwner = functionSources.get('observedTableEntry');
  const bridgeBindings = [
    'const accumulator = createTableAccumulator({',
    'const canonical = canonicalizeTableCells(row.cells);',
    'const admission = addTableSampleBatch(accumulator, admitted);',
    'const result = finalizeTableExtraction(accumulator, {',
  ];
  if (bridgeBindings.some(binding => !entryOwner.includes(binding))
    || (entryOwner.match(/addTableSampleBatch\(/g) || []).length !== 1) {
    fail('observation must use exactly one trusted Task-1 batch bridge');
  }

  const jsonOwner = functionSources.get('boundedTableObservationJson');
  const textOwner = functionSources.get('boundedTableObservationText');
  const emissionJsonOwner = functionSources.get('boundedTableObservationEmissionJson');
  const emissionTextOwner = functionSources.get('boundedTableObservationEmissionText');
  const tableOwner = functionSources.get('tableObservationStr');
  const emitterOwner = functionSources.get('emitTargetCommandResponse');
  if (!jsonOwner.includes("Buffer.byteLength(output, 'utf8') > 16384")
    || !textOwner.includes("Buffer.byteLength(output, 'utf8') > 8192")
    || !emissionJsonOwner.includes('return boundedTableObservationJson(model);')
    || !emissionTextOwner.includes("Buffer.byteLength(result, 'utf8') <= 8192")
    || !tableOwner.includes("sampleRootFrameTables(cdp, sid, request.selector || 'table')")
    || !tableOwner.includes("request.format === 'json'")
    || !emitterOwner.includes('attachTargetResolutionDiagnostics(response.result, targetResolution)')
    || !emitterOwner.includes('? boundedTableObservationEmissionJson(output)')
    || !emitterOwner.includes(': boundedTableObservationEmissionText(output)')) {
    fail('table formatter and final emission budget authority was not found');
  }

  const ownerSource = allOwners.map(name => functionSources.get(name)).join('\0');
  const bindingSource = [
    samplerImport,
    extractionImport,
    ...exactSampleBindings,
    ...bridgeBindings,
    ...samplerBindings,
    ...extractionBindings,
  ].join('\0');
  return {
    owners: [...TABLE_OBSERVATION_OWNERS],
    sourceDigest: digest([ownerSource, tableSamplerSource, tableExtractionSource].join('\0')),
    bindingDigest: digest(bindingSource),
    samplerSourceDigest: digest(tableSamplerSource),
    extractionSourceDigest: digest(tableExtractionSource),
    source: [ownerSource, tableSamplerSource, tableExtractionSource].join('\0'),
    binding: bindingSource,
  };
}

function collectTablePolicyAuthority(source, {
  commandApplicationSource,
  commandSurface,
  daemonReadHandlersSource,
  mcpAdapterSource,
  tableArtifactsSource,
  tableContractSource,
  tableExtractionSource,
  tableSamplerSource,
}) {
  const table = commandSurface.resolve('table');
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
  let tableArtifactImport = null;
  let authorizeBinding = null;
  let tableCapabilityBinding = null;
  let tableArtifactConstructionBinding = null;
  let tableRollbackBinding = null;
  let tableReleaseBinding = null;
  let tableSessionCleanupBinding = null;
  const deterministicContinuationBindings = new Map();
  let batchUnsafeBinding = null;
  let transportSideEffectBinding = null;
  let daemonBuilderBinding = null;
  let applicationHandlerBinding = null;
  const frozenWiringBindings = new Map();
  let runDaemonAuthoritySource = null;
  let sendCommandAuthoritySource = null;
  const lifecycleOwnerNames = [
    'createDaemonRequestConnection',
    'createDaemonShutdown',
    'emitTargetCommandResponse',
    'isDeterministicTableContinuationResult',
  ];
  const lifecycleOwnerSources = new Map();
  const failTable = message => { throw new Error(`table policy authority: ${message}`); };
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        ImportDeclaration(node) {
          if (node.source?.value === './lib/table-artifacts.mjs') {
            if (tableArtifactImport) failTable('table artifact factory import must be unique');
            if (node.specifiers.length !== 1
              || node.specifiers[0].type !== 'ImportSpecifier'
              || node.specifiers[0].imported?.name !== 'createTableArtifactStore'
              || node.specifiers[0].local?.name !== 'createTableArtifactStore') {
              failTable('table artifact factory must use one direct named production import');
            }
            tableArtifactImport = sourceCode.getText(node);
            return;
          }
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
          if (lifecycleOwnerNames.includes(name)) {
            const ancestors = sourceCode.getAncestors(node);
            if (ancestors.length !== 1 || ancestors[0]?.type !== 'Program') {
              failTable(`${name} must be one unique top-level lifecycle owner`);
            }
            if (lifecycleOwnerSources.has(name)) {
              failTable(`${name} lifecycle owner must be unique`);
            }
            lifecycleOwnerSources.set(name, sourceCode.getText(node));
          }
          if (name === 'runDaemon') {
            if (runDaemonAuthoritySource !== null) failTable('runDaemon table policy owner must be unique');
            runDaemonAuthoritySource = sourceCode.getText(node);
          }
          if (name === 'sendCommand') {
            if (sendCommandAuthoritySource !== null) failTable('sendCommand table policy owner must be unique');
            sendCommandAuthoritySource = sourceCode.getText(node);
          }
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
          if (name === 'unsafe' && namedFunctionOwner(sourceCode, node) === 'batch') {
            const binding = sourceCode.getText(node);
            if (binding !== 'unsafe = commands.filter(command => isBatchParallelUnsafeCommand(command.cmd, command.args || []))') {
              failTable('batch unsafe selection must directly classify each command with its argv');
            }
            if (batchUnsafeBinding) failTable('batch unsafe selection must be bound exactly once');
            batchUnsafeBinding = binding;
          }
          if (name === 'DAEMON_HANDLER_BUILDERS') {
            const object = node.init?.type === 'CallExpression'
              && node.init.callee?.type === 'MemberExpression'
              && !node.init.callee.computed
              && node.init.callee.object?.name === 'Object'
              && node.init.callee.property?.name === 'freeze'
              && node.init.arguments.length === 1
              ? node.init.arguments[0]
              : null;
            const properties = object?.type === 'ObjectExpression'
              ? object.properties.filter(property => property.type === 'Property'
                && !property.computed && (property.key.name || property.key.value) === 'table')
              : [];
            if (properties.length !== 1) failTable('DAEMON_HANDLER_BUILDERS.table must be bound exactly once');
            const binding = sourceCode.getText(properties[0]);
            if (binding !== 'table: capabilities => createDaemonReadHandlers(capabilities).table') {
              failTable('DAEMON_HANDLER_BUILDERS.table must own the daemon table read handler');
            }
            if (daemonBuilderBinding) failTable('DAEMON_HANDLER_BUILDERS.table must be unique');
            daemonBuilderBinding = binding;
          }
          if (name === 'applicationHandlers' && namedFunctionOwner(sourceCode, node) === 'runDaemon') {
            const properties = node.init?.type === 'ObjectExpression'
              ? node.init.properties.filter(property => property.type === 'Property'
                && !property.computed && (property.key.name || property.key.value) === 'table')
              : [];
            if (properties.length !== 1) failTable('applicationHandlers.table must be bound exactly once');
            const binding = sourceCode.getText(properties[0]);
            if (binding !== 'table: applicationPreflight.handlerBuilders.table(readCapabilities)') {
              failTable('applicationHandlers.table must use the table builder and reviewed capabilities');
            }
            if (applicationHandlerBinding) failTable('applicationHandlers.table must be unique');
            applicationHandlerBinding = binding;
          }
          if (name === 'tableArtifactStore' && namedFunctionOwner(sourceCode, node) === 'runDaemon') {
            const binding = sourceCode.getText(node);
            const expected = "tableArtifactStore = createTableArtifactStore({\n    runtimeDir: RUNTIME_DIR,\n    targetId,\n    sessionId: randomBytes(16).toString('hex'),\n    platform: process.platform,\n  })";
            if (binding !== expected) failTable('table artifact store must be one production construction');
            if (tableArtifactConstructionBinding) failTable('table artifact store construction must be unique');
            tableArtifactConstructionBinding = binding;
          }
          if (name !== 'readCapabilities') return;
          const properties = node.init?.type === 'ObjectExpression'
            ? node.init.properties.filter(property => property.type === 'Property'
              && !property.computed
              && (property.key.name || property.key.value) === 'table')
            : [];
          if (properties.length !== 1) failTable('readCapabilities.table must be bound exactly once');
          const binding = sourceCode.getText(properties[0]);
          const expected = "table: async request => request.mode === 'continue'\n      ? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)\n      : tableObservationStr(cdp, sessionId, request)";
          if (binding !== expected) {
            failTable('readCapabilities.table must bind continuation to the private store and full observation request delivery');
          }
          if (tableCapabilityBinding) failTable('readCapabilities.table must be bound exactly once');
          tableCapabilityBinding = binding;
        },
        AssignmentExpression(node) {
          const left = node.left;
          if (left?.type === 'MemberExpression'
            && !left.computed
            && left.object?.name === 'Object'
            && left.property?.name === 'freeze') {
            failTable('global Object.freeze must not be reassigned');
          }
          if (left?.type === 'MemberExpression'
            && ['readCapabilities', 'applicationHandlers'].includes(left.object?.name)) {
            failTable(`${left.object.name} must not be reassigned after construction`);
          }
        },
        Property(node) {
          if (node.computed) return;
          const owner = namedFunctionOwner(sourceCode, node);
          const name = node.key.name || node.key.value;
          const insideRunDaemon = sourceCode.getAncestors(node).some(ancestor => (
            ancestor.type === 'FunctionDeclaration' && ancestor.id?.name === 'runDaemon'
          ));
          if (insideRunDaemon) {
            const binding = sourceCode.getText(node);
            if (name === 'cleanup' && binding.includes('tableArtifactStore.rollbackRequest')) {
              if (binding !== 'cleanup: (_request, execution) => tableArtifactStore.rollbackRequest(execution)') {
                failTable('request rollback must directly call the artifact store');
              }
              if (tableRollbackBinding) failTable('request rollback binding must be unique');
              tableRollbackBinding = binding;
            } else if (name === 'onFlushed' && binding.includes('tableArtifactStore.releaseRequest')) {
              if (binding !== 'onFlushed: (_request, execution) => tableArtifactStore.releaseRequest(execution)') {
                failTable('successful flush release must directly call the artifact store');
              }
              if (tableReleaseBinding) failTable('successful flush release binding must be unique');
              tableReleaseBinding = binding;
            } else if (name === 'cleanupSession' && binding.includes('tableArtifactStore.cleanupSession')) {
              if (binding !== 'cleanupSession: () => tableArtifactStore.cleanupSession()') {
                failTable('shutdown cleanup must directly call the artifact store');
              }
              if (tableSessionCleanupBinding) failTable('shutdown cleanup binding must be unique');
              tableSessionCleanupBinding = binding;
            }
          }
          if (owner === 'sendCommand' && name === 'mayHaveSideEffects') {
            const binding = sourceCode.getText(node);
            if (binding !== 'mayHaveSideEffects: daemonRequestMayHaveSideEffects(req)') {
              failTable('sendCommand must directly bind daemonRequestMayHaveSideEffects(req)');
            }
            if (transportSideEffectBinding) failTable('sendCommand side-effect classifier must be bound exactly once');
            transportSideEffectBinding = binding;
            return;
          }
          if (functionName(sourceCode, node) !== 'runDaemon' || name !== 'authorize') return;
          const binding = sourceCode.getText(node);
          if (binding !== 'authorize: authorizeDaemonApplicationCommand') {
            failTable('daemon dispatcher must directly bind authorizeDaemonApplicationCommand');
          }
          if (authorizeBinding) failTable('daemon authorizer must be bound exactly once');
          authorizeBinding = binding;
        },
        CallExpression(node) {
          if (node.callee?.type === 'MemberExpression'
            && !node.callee.computed
            && node.callee.object?.name === 'Object'
            && node.callee.property?.name === 'freeze'
            && node.arguments.length === 1
            && node.arguments[0]?.type === 'Identifier'
            && ['readCapabilities', 'applicationHandlers'].includes(node.arguments[0].name)) {
            const target = node.arguments[0].name;
            requireUnshadowedGlobalReference(sourceCode, node.callee.object, 'Object', failTable);
            if (namedFunctionOwner(sourceCode, node) !== 'runDaemon'
              || sourceCode.getText(node) !== `Object.freeze(${target})`) {
              failTable(`${target} must be frozen directly in runDaemon`);
            }
            if (frozenWiringBindings.has(target)) failTable(`${target} must be frozen exactly once`);
            frozenWiringBindings.set(target, sourceCode.getText(node));
            return;
          }
          if (node.callee?.type === 'MemberExpression'
            && !node.callee.computed
            && ['Object', 'Reflect'].includes(node.callee.object?.name)
            && ['assign', 'defineProperties', 'defineProperty', 'set', 'setPrototypeOf'].includes(node.callee.property?.name)
            && node.arguments[0]?.type === 'Identifier'
            && ['readCapabilities', 'applicationHandlers'].includes(node.arguments[0].name)) {
            failTable(`${node.arguments[0].name} must not be reflectively mutated after construction`);
          }
          const name = node.callee?.type === 'Identifier' ? node.callee.name : null;
          if (name === 'isDeterministicTableContinuationResult') {
            const call = sourceCode.getText(node);
            const conditional = sourceCode.getAncestors(node).findLast(ancestor => (
              ancestor.type === 'ConditionalExpression'
            ));
            const guard = sourceCode.getAncestors(node).findLast(ancestor => (
              ancestor.type === 'IfStatement'
            ));
            if (namedFunctionOwner(sourceCode, node) !== 'emitTargetCommandResponse'
              || call !== 'isDeterministicTableContinuationResult(cmd, response.result)'
              || (!conditional && !guard)) {
              failTable('deterministic continuation emission must use the reviewed result');
            }
            const role = conditional ? 'target-diagnostics' : 'table-budget';
            if (deterministicContinuationBindings.has(role)) {
              failTable(`deterministic continuation ${role} binding must be unique`);
            }
            deterministicContinuationBindings.set(
              role,
              sourceCode.getText(conditional || guard.test),
            );
          }
          if (!calls.has(name)) return;
          calls.get(name).push({
            owner: namedFunctionOwner(sourceCode, node),
            source: sourceCode.getText(node),
          });
        },
        'Program:exit'() {
          for (const name of TABLE_POLICY_HELPERS) {
            requireUniqueBinding(sourceCode, name, { definitionType: 'FunctionName' }, failTable);
          }
          for (const name of TABLE_CONTRACT_HELPERS) {
            requireUniqueBinding(sourceCode, name, {
              definitionType: 'ImportBinding',
              importSource: './lib/table-contract.mjs',
            }, failTable);
          }
          requireUniqueBinding(sourceCode, 'tableObservationStr', { definitionType: 'FunctionName' }, failTable);
          requireUniqueBinding(sourceCode, 'createTableArtifactStore', {
            definitionType: 'ImportBinding',
            importSource: './lib/table-artifacts.mjs',
          }, failTable);
          requireUniqueBinding(sourceCode, 'parseTableContinuationToken', {
            definitionType: 'ImportBinding',
            importSource: './lib/table-contract.mjs',
          }, failTable);
          requireUniqueBinding(sourceCode, 'isDeterministicTableContinuationResult', {
            definitionType: 'FunctionName',
          }, failTable);
          for (const name of lifecycleOwnerNames) {
            requireUniqueBinding(sourceCode, name, { definitionType: 'FunctionName' }, failTable);
          }
          requireUniqueBinding(sourceCode, 'readCapabilities', {
            definitionType: 'Variable',
            topLevel: false,
            allowInitializationWrite: true,
          }, failTable);
          requireUniqueBinding(sourceCode, 'applicationHandlers', {
            definitionType: 'Variable',
            topLevel: false,
            allowInitializationWrite: true,
          }, failTable);
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
  if (!tableContractImport || !tableArtifactImport) failTable('table contract/artifact imports were not found');
  if (TABLE_POLICY_HELPERS.some(name => !declarations.has(name))) {
    failTable('all policy helpers must be declared exactly once');
  }
  if (!runDaemonAuthoritySource || !sendCommandAuthoritySource) {
    failTable('runDaemon and sendCommand table policy owners must be present');
  }
  if (lifecycleOwnerNames.some(name => !lifecycleOwnerSources.has(name))) {
    failTable('all table artifact lifecycle owners must be present');
  }
  const expectedCalls = {
    isTableCollectArgs: [
      { owner: 'daemonRequestMayHaveSideEffects', source: 'isTableCollectArgs(request.args || [])' },
      { owner: 'isBatchParallelUnsafeCommand', source: 'isTableCollectArgs(args)' },
    ],
    parseTableArgs: [
      { owner: 'authorizeDaemonApplicationCommand', source: 'parseTableArgs(args)' },
      { owner: 'createDaemonRequestExecutionContext', source: 'parseTableArgs(request.args || [])' },
      { owner: 'validateDaemonProtocolRequest', source: 'parseTableArgs(frozenRequest.args)' },
    ],
    parseTableContinuationToken: [
      { owner: 'isDeterministicTableContinuationResult', source: 'parseTableContinuationToken(model.continuation.token)' },
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
  if (!tableCapabilityBinding) failTable('table continuation capability binding was not found');
  if (!tableArtifactConstructionBinding || !tableRollbackBinding || !tableReleaseBinding
    || !tableSessionCleanupBinding || deterministicContinuationBindings.size !== 2) {
    failTable(`table artifact construction/lifecycle/emission authority was not found: ${JSON.stringify({
      construction: Boolean(tableArtifactConstructionBinding),
      rollback: Boolean(tableRollbackBinding),
      release: Boolean(tableReleaseBinding),
      cleanupSession: Boolean(tableSessionCleanupBinding),
      emission: [...deterministicContinuationBindings.keys()].sort(),
    })}`);
  }
  if (!batchUnsafeBinding) failTable('batch unsafe argv binding was not found');
  if (!transportSideEffectBinding) failTable('transport side-effect binding was not found');
  if (!daemonBuilderBinding) failTable('daemon table handler builder binding was not found');
  if (!applicationHandlerBinding) failTable('application table handler binding was not found');
  for (const target of ['readCapabilities', 'applicationHandlers']) {
    if (!frozenWiringBindings.has(target)) failTable(`${target} freeze binding was not found`);
  }
  const batchPolicySource = declarations.get('isBatchParallelUnsafeCommand');
  if (!batchPolicySource.includes('return isTableCollectArgs(args);')) {
    failTable('batch table classification must directly return isTableCollectArgs(args)');
  }
  const transportPolicySource = declarations.get('daemonRequestMayHaveSideEffects');
  if (!transportPolicySource.includes('return isTableCollectArgs(request.args || []);')) {
    failTable('transport table classification must directly return isTableCollectArgs(request.args || [])');
  }
  const authorizationSource = declarations.get('authorizeDaemonApplicationCommand');
  const authorizationBindings = [
    "const tablePolicyMatches = command === 'table' && policy === 'conditional' && mutates === false;",
    'if (tablePolicyMatches) parseTableArgs(args);',
    "['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot'].includes(command)",
    '|| tablePolicyMatches',
  ];
  if (authorizationBindings.some(binding => !authorizationSource.includes(binding))
    || (authorizationSource.match(/command === ['"]table['"]/g) || []).length !== 1
    || (authorizationSource.match(/\|\| tablePolicyMatches/g) || []).length !== 1) {
    failTable('daemon authorization must keep table parsing outside the generic conditional allowlist');
  }
  const mcpAuthority = collectMcpTablePolicyAuthority(mcpAdapterSource, failTable);
  const daemonReadAuthority = collectDaemonTablePolicyAuthority(daemonReadHandlersSource, failTable);
  const tableContractAuthority = collectTableContractAuthority(tableContractSource, failTable);
  const tableArtifactAuthority = collectTableArtifactAuthority(
    tableArtifactsSource,
    tableExtractionSource,
    failTable,
  );
  const tableObservationAuthority = collectTableObservationAuthority(
    source,
    tableSamplerSource,
    tableExtractionSource,
    failTable,
  );
  const commandApplicationAuthority = collectCommandApplicationTableAuthority(commandApplicationSource, failTable);
  const helperSources = TABLE_POLICY_HELPERS.map(name => declarations.get(name));
  return {
    policy: expectedPolicy,
    helpers: [...TABLE_POLICY_HELPERS],
    sourceDigest: digest([
      tableContractImport,
      tableArtifactImport,
      ...helperSources,
      runDaemonAuthoritySource,
      sendCommandAuthoritySource,
      ...lifecycleOwnerNames.map(name => lifecycleOwnerSources.get(name)),
      mcpAuthority.source,
      daemonReadAuthority.source,
      tableContractAuthority.source,
      tableArtifactAuthority.source,
      tableObservationAuthority.source,
      commandApplicationAuthority.source,
    ].join('\0')),
    bindingDigest: digest([
      authorizeBinding,
      tableCapabilityBinding,
      tableArtifactConstructionBinding,
      tableRollbackBinding,
      tableReleaseBinding,
      tableSessionCleanupBinding,
      ...[...deterministicContinuationBindings.entries()]
        .sort()
        .map(([role, binding]) => `${role}:${binding}`),
      batchUnsafeBinding,
      transportSideEffectBinding,
      daemonBuilderBinding,
      applicationHandlerBinding,
      ...[...frozenWiringBindings.entries()].sort().map(([target, binding]) => `${target}:${binding}`),
      mcpAuthority.binding,
      daemonReadAuthority.binding,
      tableContractAuthority.binding,
      tableArtifactAuthority.binding,
      tableObservationAuthority.binding,
      commandApplicationAuthority.binding,
      ...Object.values(expectedCalls).flat().map(call => `${call.owner}:${call.source}`).sort(),
    ].join('\0')),
    artifactSourceDigest: digest(tableArtifactsSource),
    observation: {
      owners: tableObservationAuthority.owners,
      sourceDigest: tableObservationAuthority.sourceDigest,
      bindingDigest: tableObservationAuthority.bindingDigest,
      samplerSourceDigest: tableObservationAuthority.samplerSourceDigest,
      extractionSourceDigest: tableObservationAuthority.extractionSourceDigest,
    },
  };
}

export function buildRuntimeDispatchInventory(source = readFileSync(cdpPath, 'utf8'), {
  commandApplicationSource = readFileSync(commandApplicationPath, 'utf8'),
  commandSurface = COMMAND_SURFACE,
  daemonReadHandlersSource = readFileSync(daemonReadHandlersPath, 'utf8'),
  mcpAdapterSource = readFileSync(mcpAdapterPath, 'utf8'),
  tableArtifactsSource = readFileSync(tableArtifactsPath, 'utf8'),
  tableContractSource = readFileSync(tableContractPath, 'utf8'),
  tableExtractionSource = readFileSync(tableExtractionPath, 'utf8'),
  tableSamplerSource = readFileSync(tableSamplerPath, 'utf8'),
} = {}) {
  const applicationAuthority = collectApplicationCommands(source);
  const tablePolicyAuthority = collectTablePolicyAuthority(source, {
    commandApplicationSource,
    commandSurface,
    daemonReadHandlersSource,
    mcpAdapterSource,
    tableArtifactsSource,
    tableContractSource,
    tableExtractionSource,
    tableSamplerSource,
  });
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
