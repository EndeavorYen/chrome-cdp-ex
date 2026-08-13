import { describe, expect, it } from 'vitest';

import {
  commandApplicationSource,
  daemonReadHandlersSource,
  expectInventoryDriftOrReject,
  expectOverrideDriftOrReject,
  inventory,
  lifecycleAuthorityOwnerNames,
  mutate,
  source,
  tableArtifactsSource,
  tableContractSource,
  tableExtractionSource,
  tableSamplerSource,
} from './runtime-v3-table-policy-authority-helpers.mjs';

describe('Runtime v3 table policy authority owners', { timeout: 60_000 }, () => {
  it.each([
    () => daemonReadHandlersSource.replace(
      'export function createDaemonReadHandlers(input) {',
      'export function createDaemonReadHandlers(input) {\n  const parseTableArgs = () => ({ mode: \'observe\', format: \'text\', selector: null });',
    ),
    () => daemonReadHandlersSource.replace(
      'const request = parseTableArgs(snapshotArgs(context));',
      'const request = false ? parseTableArgs(snapshotArgs(context)) : { mode: \'observe\', format: \'text\', selector: null };',
    ),
  ])('rejects dead or shadowed daemon table parser ownership %#', mutation => {
    expect(() => inventory(source, { daemonReadHandlersSource: mutation() })).toThrow(/table policy authority/i);
  });

  it.each([
    () => tableContractSource.replace(
      "return parseTableArgs(input).mode === 'collect';",
      "return false && parseTableArgs(input).mode === 'collect';",
    ),
    () => tableContractSource.replace(
      "return parseTableArgs(input).mode === 'collect';",
      "parseTableArgs(input); return input.includes('--collect');",
    ),
  ])('rejects dead or substituted table-contract collect classification %#', mutation => {
    expect(() => inventory(source, { tableContractSource: mutation() })).toThrow(/table policy authority/i);
  });

  it.each([
    () => commandApplicationSource.replace('args: request.args,', 'args: [],'),
    () => commandApplicationSource.replace('args: request.args,', ''),
  ])('rejects command-application authorization without exact argv forwarding %#', mutation => {
    expect(() => inventory(source, { commandApplicationSource: mutation() })).toThrow(/table policy authority/i);
  });

  it('rejects a swapped catalog table policy before inventory projection', () => {
    const commandSurface = {
      resolve(name) {
        if (name !== 'table') return null;
        return {
          kind: 'read',
          authorization: 'standard',
          evidencePolicy: 'none',
          mutates: false,
          outputFormats: ['text', 'json'],
        };
      },
    };
    expect(() => inventory(source, { commandSurface })).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'table: capabilities => createDaemonReadHandlers(capabilities).table,',
      'table: capabilities => createDaemonReadHandlers(capabilities).text,',
    ),
    () => source.replace(
      'table: applicationPreflight.handlerBuilders.table(readCapabilities),',
      'table: applicationPreflight.handlerBuilders.text(readCapabilities),',
    ),
    () => source.replace(
      "table: async (request, execution) => request.mode === 'continue'\n      ? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)\n      : request.mode === 'collect'\n        ? tableCollectionStr(cdp, sessionId, request, execution, { store: tableArtifactStore, session: tableCollectorSession })\n        : tableObservationStr(cdp, sessionId, request),",
      "table: async request => request.mode === 'continue'\n      ? textStr(cdp, sessionId, request.continuation)\n      : tableStr(cdp, sessionId, request.selector),",
    ),
  ])('rejects substituted table handler and capability wiring %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => mutate(source,
      "import { createTableArtifactStore } from './lib/table-artifacts.mjs';",
      "import { createTableArtifactStore as createStore } from './lib/table-artifacts.mjs';"),
    () => mutate(source,
      'const tableArtifactStore = createTableArtifactStore({',
      'const tableArtifactStore = false && createTableArtifactStore({'),
    () => mutate(source,
      'cleanup: (_request, execution) => tableArtifactStore.rollbackRequest(execution),',
      'cleanup: () => {},'),
    () => mutate(source,
      'onFlushed: (_request, execution) => tableArtifactStore.releaseRequest(execution),',
      'onFlushed: () => {},'),
    () => mutate(source,
      'cleanupSession: () => tableArtifactStore.cleanupSession(),',
      'cleanupSession: () => {},'),
    () => mutate(source,
      "&& !isDeterministicTableContinuationResult(cmd, response.result)",
      "&& false && !isDeterministicTableContinuationResult(cmd, response.result)"),
    () => mutate(source,
      "? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)",
      "? JSON.stringify(await tableArtifactStore.readContinuation(request.argv[0]), null, 2)"),
  ])('rejects or drifts for artifact production lifecycle bypass %#', mutation => {
    expectInventoryDriftOrReject(mutation());
  });

  it.each([
    () => mutate(source,
      '} else if (successfulResponse) disposeAfterSuccessfulFlush(entry);',
      '} else if (successfulResponse || response?.ok === false) disposeAfterSuccessfulFlush(entry);'),
    () => mutate(source,
      `    try {
      if (cleanupSession() !== undefined) finalExitCode = 1;
    } catch {
      finalExitCode = 1;
    }
    try { getServer()?.close(); } catch {}
    if (!isWindows) try { unlinkSocket(socketPath); } catch {}
    try { closeCdp(); } catch {}`,
      `    try { getServer()?.close(); } catch {}
    if (!isWindows) try { unlinkSocket(socketPath); } catch {}
    try { closeCdp(); } catch {}
    try {
      if (cleanupSession() !== undefined) finalExitCode = 1;
    } catch {
      finalExitCode = 1;
    }`),
    () => mutate(source,
      "  if (cmd !== 'table' || typeof result !== 'string') return false;",
      "  if (cmd === 'table') return false; if (cmd !== 'table' || typeof result !== 'string') return false;"),
    () => mutate(source,
      '  if (hasResult) {',
      "  if (hasResult) { if (cmd === 'table') response.result = attachTargetResolutionDiagnostics(response.result, targetResolution);"),
  ])('rejects lifecycle or deterministic-emission owner bypass %#', mutation => {
    expectInventoryDriftOrReject(mutation());
  });

  it.each(lifecycleAuthorityOwnerNames.flatMap(name => ([
    [`${name} shadow`, () => mutate(source,
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      `async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) { const ${name} = () => {};`)],
    [`${name} duplicate`, () => mutate(source,
      `function ${name}(`,
      `function ${name}() {}\nfunction ${name}(`)],
    [`${name} write`, () => mutate(source,
      `function ${name}(`,
      `${name} = () => {};\nfunction ${name}(`)],
  ])))('rejects lifecycle owner scope bypass: %s', (_label, mutation) => {
    expect(() => inventory(mutation())).toThrow(/table policy authority|Parsing error/i);
  });

  it.each([
    () => mutate(tableContractSource,
      'const CONTINUATION_TOKEN_RE = /^ct1\\.([0-9a-f]{32})\\.(0|[1-9][0-9]{0,4})$/;',
      'const CONTINUATION_TOKEN_RE = /^ct1\\.([0-9a-f]{32})\\.(0|[1-9][0-9]{0,5})$/;'),
    () => mutate(tableContractSource,
      'parseTableContinuationToken(continuation);',
      'if (false) parseTableContinuationToken(continuation);'),
  ])('rejects or drifts for continuation parser bypass %#', mutation => {
    expectOverrideDriftOrReject({ tableContractSource: mutation() });
  });

  it.each([
    () => mutate(tableExtractionSource,
      'exportBundles.set(bundle, Object.freeze({ manifest, rowsTsv }));',
      'if (false) exportBundles.set(bundle, Object.freeze({ manifest, rowsTsv }));'),
    () => mutate(tableExtractionSource,
      'const trusted = exportBundles.get(bundle);',
      'const trusted = bundle;'),
  ])('rejects or drifts for trusted export bundle bypass %#', mutation => {
    expectOverrideDriftOrReject({ tableExtractionSource: mutation() });
  });

  it.each([
    () => mutate(source,
      "import { buildTableSamplerExpression, parseTableSamplerResult } from './lib/table-sampler.mjs';",
      "import { buildTableSamplerExpression as buildSampler, parseTableSamplerResult } from './lib/table-sampler.mjs';"),
    () => mutate(source,
      '  addTableSampleBatch,\n  buildTableExportBundle,\n  canonicalizeTableCells,',
      '  addTableSampleBatch as admitBatch,\n  buildTableExportBundle,\n  canonicalizeTableCells,'),
    () => mutate(source,
      '    grantUniveralAccess: false,',
      '    grantUniveralAccess: true,'),
    () => mutate(source,
      '    returnByValue: true,\n    awaitPromise: false,',
      '    returnByValue: false,\n    awaitPromise: true,'),
    () => mutate(source,
      '  const admission = addTableSampleBatch(accumulator, admitted);',
      '  const admission = addTableSampleBatch(accumulator, []);'),
    () => mutate(source,
      "? boundedTableObservationEmissionJson(output)\n        : boundedTableObservationEmissionText(output);",
      '? output\n        : output;'),
  ])('rejects observation source ownership bypass %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table (?:policy|observation) authority/i);
  });

  it.each([
    () => mutate(tableSamplerSource,
      'export function buildTableSamplerExpression(selector = \'table\') {',
      'export function buildTableSamplerExpression(selector = \'table\') { if (false) return \'{}\';'),
    () => mutate(tableExtractionSource,
      'export function addTableSampleBatch(accumulator, samples) {',
      'export function addTableSampleBatch(accumulator, samples) { if (false) return { admitted: true };'),
  ])('drifts for complete sampler or extraction source changes %#', mutation => {
    const mutated = mutation();
    const override = mutated.includes('buildTableSamplerExpression')
      ? { tableSamplerSource: mutated }
      : { tableExtractionSource: mutated };
    expectOverrideDriftOrReject(override);
  });

  it.each([
    () => mutate(tableArtifactsSource,
      "if (state.platform === 'win32') {",
      "if (false && state.platform === 'win32') {"),
    () => mutate(tableArtifactsSource,
      "return error?.code === 'ESRCH';",
      'return true;'),
    () => mutate(tableArtifactsSource,
      'export function createTableArtifactStore(input) {',
      'export function createTableArtifactStore(input, dependencies = DEFAULT_DEPENDENCIES) {'),
    () => mutate(tableArtifactsSource,
      'return makeStore(input, DEFAULT_DEPENDENCIES);',
      'return makeStore(input, dependencies);'),
    () => mutate(tableArtifactsSource,
      'sweepCrashResidue: () => sweepCrashResidue(state),',
      'sweepCrashResidue() {},'),
  ])('rejects or drifts for artifact store safety bypass %#', mutation => {
    expectOverrideDriftOrReject({ tableArtifactsSource: mutation() });
  });
});
