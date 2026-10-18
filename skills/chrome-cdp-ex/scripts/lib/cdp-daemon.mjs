// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { actionFailureMessage, classifyActionFailure, formatActionFailure, isClassifiedActionFailureText, isExpectedClipboardNoChange, looksLikeClipboardControl } from './action-recovery.mjs';
import { captureClickDownload } from './click-download.mjs';
import { commandResult } from './command-application.mjs';
import { createCommandDispatcher } from './command-dispatch.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { createDaemonActionHandlers } from './daemon-action-handlers.mjs';
import { createDaemonReadHandlers } from './daemon-read-handlers.mjs';
import { claimDaemonEndpoint, connectToDaemon, daemonEndpointForPlatform, daemonEndpointTooLongError, probeDaemonEndpoint, requestDaemon, watchDaemonSocket } from './daemon-transport.mjs';
import { createNetlogRequestStore, parseNetlogArgs } from './netlog.mjs';
import { formatPerceptionJson } from './perception-model.mjs';
import { assertSecretName, loadSecrets, unknownSecretError, withoutSecretEnv } from './secrets.mjs';
import { createContentBoundaryNonce, createMainFrameNavigationLog, createRequestPolicyState, guardDaemonCommand, originLabel } from './session-policy.mjs';
import { createSourceMapResolver } from './source-maps.mjs';
import { createTableArtifactStore } from './table-artifacts.mjs';
import { isTableCollectArgs } from './table-contract.mjs';
import { distinctTargets } from './target-binding.mjs';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { lstatSync, readFileSync, statSync, unlinkSync } from 'fs';
import net from 'net';
import { resolve } from 'path';
import { actionDomDiffShowsChange, actionObservationPerceiveOpts, actionSettleObserveOpts, applyActionObservationDelta, buildLocatedActionObservationDelta, createActionObservationBaseline, describeFailedActionRequests, formatActionNavigationDiff, formatActionText, locateObservedEntries, noBaselineActionDiff, parseVerifyClickArgs, resolveActionSettleBaseline, shouldSkipActionDomSettle, shouldTrackActionNetworkRequest } from './cdp-action-result.mjs';
import { BATCH_BLOCKED, COMMANDS, DAEMON_CONNECT_DELAY, DAEMON_CONNECT_RETRIES, DAEMON_IDLE_EXIT_GRACE_MS, DAEMON_IDLE_EXIT_MARGIN_MS, DAEMON_PAGE_LIST_PROBE_TIMEOUT_MS, DAEMON_SIDE_EFFECT_AUTHORIZATIONS, DEFAULT_CDP_HOST, ENDPOINT_ABSENT_CODES, FAILED_REQUEST_BODY_TIMEOUT_MS, FIRE_AND_FORGET_KEEPALIVE, FOREGROUND_ACTIVATE_COMMAND, IDLE_TIMEOUT, MIN_TARGET_PREFIX_LEN, PRESS_SEARCH_SUBMIT_FLAG, REVEAL_POLL_TIMEOUT_MS, RUNTIME_DIR, SECRET_FILL_COMMANDS, SOURCE_MAP_LATE_REPLY_TIMEOUT_MS, STOP_KILL_POLLS, STOP_KILL_POLL_MS, STOP_PROBE_TIMEOUT_MS, STOP_REQUEST_TIMEOUT_MS, TYPE_SECRET_UNSUPPORTED, VERIFY_CLICK_REQUEST_WAIT_MS, VERIFY_CLICK_SETTLE_MS, daemonPolicyStorage, daemonRequestStorage, sleep } from './cdp-base.mjs';
import { CDP, _browserInfo, assessDaemonFreshness, buildQaSummaryModel, collectDaemonMetadata, formatDaemonStartFailure, formatJson, formatQaSummaryText, formatStaleDaemonMessage, getDisplayPrefixLength, getWsUrl, isolatedOnlyEnabled, listDaemonSockets, livePageIdentity, parseCompactFormatArgs, parseDaemonMetadataResult, parseDelayMs, parseFormatArgs, parseQaModeArgs, rememberLiveCdpEndpointFromSession, resolvePrefix, takeUnsafeFullArg, truncateTextLines, waitStr } from './cdp-browser.mjs';
import { argsWithoutFormat, authorizeDaemonApplicationCommand, createApplicationCommandRegistry, createClickCommandHandler, createEvalrawCommandHandler, executeDaemonApplicationRoute, parseFillArgs, sameStringArray, snapshotApplicationDataObject, targetPrefixForDisplay, typeTextNamesSecret } from './cdp-cli.mjs';
import { RingBuffer, applySavedNetworkControls, armDaemonRestartNotice, consoleDocumentEntries, consoleEntryFromEvent, createDaemonIdleTimer, createDaemonNetworkObserver, createDaemonRequestConnection, createDaemonShutdown, createEarlyResponseStatusStore, daemonBackgroundMode, enforceDaemonTableCollectionGate, ensureRuntimeDir, environmentRestoreOutcome, exceptionEntryFromEvent, explicitBackgroundChoice, idleTrackedDaemonRequestHandler, installDaemonCrashRecorder, listDaemonRecords, readDaemonCrashReport, readDaemonRecord, readTabEnvironment, rememberTabObservation, removeDaemonRecord, removeOwnDaemonRecord, restoreTabObservation, savedDialogAccepts, sockPath, withObservationNotice, writeDaemonRecord } from './cdp-core.mjs';
import { dismissModalStr, overlayStr } from './cdp-doctor.mjs';
import { autoActionJsonArgs, cascadeStr, closetabStr, createNavigationCancelWatch, flowStr, formatBatchResults, historyNavStr, injectStr, isBatchParallelUnsafeCommand, navActionDispatch, observeNavPage, observeReloadPage, parseBatchArgs, parseClosetabArgs, parseFlowSteps, parseRecordArgs, parseRepeatArgs, parseReplayArgs, policyCompositeSteps, probePageCondition, recordStr, repeatStr, replayActionsStr, runBatchCommands, settleFlow } from './cdp-flow.mjs';
import { applyFillValueState, applyLateClickDownload, batchCommandLookahead, clickStr, clickXyStr, dispatchHoverWithLeftoverPolicy, dragStr, evalPageHref, fillStr, formControlStateChanged, formatActionControlStateDiff, jsClickStr, jsclickFeedbackPolicy, markSensitiveFillTarget, namedClickActionTarget, normalizeScrollArgs, openerUnusableError, parseActionabilityWaitArgs, parseClickOpenedTab, parseDragArgs, parsePressArgs, pointerClickStr, pressFeedbackPolicy, pressSearchSubmitPlan, pressStr, pressUsageError, probePageVisibility, probeSearchSubmit, reloadActionDispatch, rememberSessionTarget, runWithBatchLookahead, scrollActionTarget, scrollFeedbackPolicy, scrollStr, selectStr, shouldSnapshotFormControlState, snapshotFormControlState, stuckOpenerBeforeClick, typeStr, waitForSearchSubmitProbe, waitForStr } from './cdp-input.mjs';
import { annotshotStr, callStr, cdpDomains, collectPageHealth, diffShotStr, elshotStr, emulateStr, evalBase64Decode, evalFireAndForgetStr, evalStr, formatPageList, formatPdfViewerOutput, fullshotStr, getPages, htmlStr, isPdfViewerContentType, netStr, parseConsoleArgs, parseDiffShotArgs, parseEvalArgs, parseShotArgs, pdfViewerHandoffModel, resetScreenshotTier, runtimeMetricsStr, scanshotStr, setBackgroundCaptureGuard, shotStr, snapshotStr, webVitalsModelOrUnavailable } from './cdp-page.mjs';
import { actionNetworkQuietOptions, appendPendingActionNetworkEntries, checkpointSessionEvent, checkpointStr, clearObservationBuffers, clockStr, componentsStr, cookieDelStr, cookieSetStr, cookiesStr, createJavaScriptDialogSession, dismissedDecisionDialogSince, errorYieldingToDismissedDialog, evalRawStr, handleMockRequestPaused, handleOpeningJavaScriptDialog, loadAllStr, mockStr, nativeDialogDismissedError, nativeDialogShouldAccept, netlogRequestStr, netlogStr, observeAfterActionGuardingDialogs, parseCheckpointArgs, parseCookieArgs, parseLoadAllArgs, readNetlogResponseBody, redactExternalInputActionError, redactRestoreActionError, redactRestoreCommandArgs, rememberViewportReadback, restoreCheckpointStr, setDialogMode, shouldSkipActionPageEvaluate, stylesStr, tableCollectionStr, tableObservationStr, takeAcceptDialogFlag, textStr, throttleStr, uploadStr, viewportStr, waitForActionNetworkQuiet } from './cdp-page-commands.mjs';
import { attachSelectorFrameMiss, controlsStr, ensurePerceiveTargetReady, frameRefFromActionTarget, framesStr, invalidateSessionRefs, isRef, parseControlsArgs, parseElshotArgs, parseFrameArgs, parsePerceiveArgs, perceiveDiffModel, perceiveModel, perceiveStr, resolveSinceActionPerceiveOpts, waitForSettle } from './cdp-perceive.mjs';
import { appendSessionActionLog, appendSessionEventLog, appendSessionScreenshot, buildConsoleModel, buildSemanticInteractionModel, buildStatusModel, clearConsoleBaseline, clickDownloadBrowser, consoleStr, countNetworkFailures, createDaemonExitLog, createDaemonFillCapability, createRuntimePruneScheduler, createSessionState, currentSessionActionSequence, ensureSessionScreenshotDir, formatActionWorkflowCommandOutput, clearRecordedActions, formatExportPlaywright, formatRecordActions, formatSemanticInteractionResult, parseRecordActionsArgs, formatSessionReport, initializeSessionLog, markSessionActionsPolicyFailed, nextSessionScreenshotPath, pageContainsText, pageInfoModel, parseExportPlaywrightArgs, parseReportArgs, pruneDaemonRuntimeArtifacts, qaPageStr, responsiveAuditStr, runActionWithFeedback, runDaemonRequestScope, selectConsoleEntries, sessionDownloadDir, statusStr, summaryModel, summaryStr } from './cdp-session-report.mjs';

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

export const DAEMON_HANDLER_BUILDERS = Object.freeze({
  perceive: context => createPerceiveCommandHandler(context),
  click: context => createClickCommandHandler(context),
  report: context => createReportCommandHandler(context.session, context),
  evalraw: context => createEvalrawCommandHandler(context),
  html: capabilities => createDaemonReadHandlers(capabilities).html,
  text: capabilities => createDaemonReadHandlers(capabilities).text,
  table: capabilities => createDaemonReadHandlers(capabilities).table,
  net: capabilities => createDaemonReadHandlers(capabilities).net,
  status: capabilities => createDaemonReadHandlers(capabilities).status,
  summary: capabilities => createDaemonReadHandlers(capabilities).summary,
  snap: capabilities => createDaemonReadHandlers(capabilities).snap,
  controls: capabilities => createDaemonReadHandlers(capabilities).controls,
  frame: capabilities => createDaemonReadHandlers(capabilities).frame,
  overlay: capabilities => createDaemonReadHandlers(capabilities).overlay,
  styles: capabilities => createDaemonReadHandlers(capabilities).styles,
  components: capabilities => createDaemonReadHandlers(capabilities).components,
  'record-actions': capabilities => createDaemonReadHandlers(capabilities)['record-actions'],
  'export-playwright': capabilities => createDaemonReadHandlers(capabilities)['export-playwright'],
  wait: capabilities => createDaemonReadHandlers(capabilities).wait,
  waitfor: capabilities => createDaemonReadHandlers(capabilities).waitfor,
  cascade: capabilities => createDaemonReadHandlers(capabilities).cascade,
  checkpoint: capabilities => createDaemonReadHandlers(capabilities).checkpoint,
  cookies: capabilities => createDaemonReadHandlers(capabilities).cookies,
  fill: capabilities => createDaemonActionHandlers(capabilities).fill,
  hover: capabilities => createDaemonActionHandlers(capabilities).hover,
  press: capabilities => createDaemonActionHandlers(capabilities).press,
  scroll: capabilities => createDaemonActionHandlers(capabilities).scroll,
  select: capabilities => createDaemonActionHandlers(capabilities).select,
  clickxy: capabilities => createDaemonActionHandlers(capabilities).clickxy,
  'dismiss-modal': capabilities => createDaemonActionHandlers(capabilities)['dismiss-modal'],
  drag: capabilities => createDaemonActionHandlers(capabilities).drag,
  jsclick: capabilities => createDaemonActionHandlers(capabilities).jsclick,
  type: capabilities => createDaemonActionHandlers(capabilities).type,
  'verify-click': capabilities => createDaemonActionHandlers(capabilities)['verify-click'],
  back: capabilities => createDaemonActionHandlers(capabilities).back,
  forward: capabilities => createDaemonActionHandlers(capabilities).forward,
  nav: capabilities => createDaemonActionHandlers(capabilities).nav,
  reload: capabilities => createDaemonActionHandlers(capabilities).reload,
  clock: capabilities => createDaemonActionHandlers(capabilities).clock,
  mock: capabilities => createDaemonActionHandlers(capabilities).mock,
  throttle: capabilities => createDaemonActionHandlers(capabilities).throttle,
  emulate: capabilities => createDaemonActionHandlers(capabilities).emulate,
  viewport: capabilities => createDaemonActionHandlers(capabilities).viewport,
  cookiedel: capabilities => createDaemonActionHandlers(capabilities).cookiedel,
  cookieset: capabilities => createDaemonActionHandlers(capabilities).cookieset,
  dialog: capabilities => createDaemonActionHandlers(capabilities).dialog,
  keepalive: capabilities => createDaemonActionHandlers(capabilities).keepalive,
  netlog: capabilities => createDaemonActionHandlers(capabilities).netlog,
  eval: capabilities => async ({ args }) => capabilities.eval(args),
  eval64: capabilities => async ({ args }) => capabilities.eval64(args),
  call: capabilities => async ({ args }) => capabilities.call(args),
  console: capabilities => createDaemonReadHandlers(capabilities).console,
  record: capabilities => createDaemonReadHandlers(capabilities).record,
  batch: capabilities => async ({ args }) => commandResult(await capabilities.batch(args), null),
  flow: capabilities => async ({ args }) => commandResult(await capabilities.flow(args), null),
  repeat: capabilities => async ({ args }) => commandResult(await capabilities.repeat(args), null),
  replay: capabilities => async ({ args }) => commandResult(
    await capabilities.replay(args),
    { kind: 'action-receipt' },
  ),
  inject: capabilities => createDaemonActionHandlers(capabilities).inject,
  restore: capabilities => createDaemonActionHandlers(capabilities).restore,
  upload: capabilities => createDaemonActionHandlers(capabilities).upload,
  shot: capabilities => createDaemonReadHandlers(capabilities).shot,
  'diff-shot': capabilities => createDaemonReadHandlers(capabilities)['diff-shot'],
  elshot: capabilities => createDaemonReadHandlers(capabilities).elshot,
  fullshot: capabilities => createDaemonReadHandlers(capabilities).fullshot,
  scanshot: capabilities => createDaemonReadHandlers(capabilities).scanshot,
  qa: capabilities => createDaemonActionHandlers(capabilities).qa,
  'responsive-audit': capabilities => createDaemonActionHandlers(capabilities)['responsive-audit'],
  closetab: capabilities => createDaemonActionHandlers(capabilities).closetab,
  loadall: capabilities => createDaemonActionHandlers(capabilities).loadall,
});
export const DAEMON_APPLICATION_COMMANDS = Object.freeze(Object.keys(DAEMON_HANDLER_BUILDERS).sort());
export function preflightDaemonApplication(input = {}) {
  const options = snapshotApplicationDataObject(input, 'application preflight options');
  const allowedOptions = new Set(['commands', 'handlerBuilders']);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new Error(`application preflight options.${key}: is not allowed`);
  }
  const commands = Object.hasOwn(options, 'commands') ? options.commands : COMMANDS;
  const handlerBuilders = Object.hasOwn(options, 'handlerBuilders')
    ? options.handlerBuilders
    : DAEMON_HANDLER_BUILDERS;
  const registry = createApplicationCommandRegistry(commands);
  const builders = snapshotApplicationDataObject(handlerBuilders, 'handlerBuilders');
  const builderNames = Object.keys(builders).sort();
  const expectedNames = registry.list()
    .filter(command => command.needsTarget)
    .map(command => command.name)
    .sort();
  if (!sameStringArray(builderNames, expectedNames)) {
    throw new Error(`handlerBuilders: must exactly own all ${expectedNames.length} target application commands`);
  }
  for (const name of expectedNames) {
    if (typeof builders[name] !== 'function') throw new Error(`handlerBuilders.${name}: handler factory is required`);
    if (!registry.resolve(name)) throw new Error(`handlerBuilders.${name}: command is missing from registry`);
  }
  if (registry.list().length !== COMMAND_SURFACE.commands.length) {
    throw new Error('commands: application registry must own the complete command surface');
  }
  const routeOwners = Object.freeze(Object.fromEntries(
    registry.list().map(command => [command.name, command.needsTarget ? 'application' : 'adapter']),
  ));
  return Object.freeze({
    registry,
    routeOwners,
    handlerBuilders: Object.freeze(builders),
  });
}
export async function enableDaemonDomains(cdp, sessionId) {
  try { await cdpDomains(cdp).Runtime.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).Page.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).DOM.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).CSS.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).Network.enable( {}, sessionId); } catch {}
}
// Reads a script or a source map for the daemon's source-map resolver (#470). A script comes
// from the frame's resource cache; a map loads through the frame's network stack with the
// page's credentials, the way DevTools loads maps. Network.loadNetworkResource runs no page
// script, needs no Debugger domain (no pause on `debugger;`), and emits no requestWillBeSent,
// so it never shows up in an action's network delta. Returns null past maxBytes or on an HTTP
// error; throws on a transient failure.
export async function loadSourceMapText(cdp, sid, url, { kind = 'map', maxBytes, timeoutMs } = {}) {
  const { frameTree } = await cdpDomains(cdp).Page.getFrameTree( {}, sid, timeoutMs);
  const frameId = frameTree?.frame?.id;
  if (!frameId) return null;
  if (kind === 'script') {
    try {
      const res = await cdpDomains(cdp).Page.getResourceContent( { frameId, url }, sid, timeoutMs);
      const text = res.base64Encoded
        ? Buffer.from(String(res.content || ''), 'base64').toString('utf8')
        : String(res.content ?? '');
      return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
    } catch {
      // Not in this frame's resource tree (child frame, evicted); load it like a map.
    }
  }
  // The CDP request may outlive our own `timeoutMs`, so a reply that lands after we gave up is
  // still seen and its browser-side stream closed instead of leaking until detach.
  const request = cdpDomains(cdp).Network.loadNetworkResource( {
    frameId,
    url,
    options: { disableCache: false, includeCredentials: true },
  }, sid, SOURCE_MAP_LATE_REPLY_TIMEOUT_MS);
  let timer;
  const gaveUp = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timeout: Network.loadNetworkResource')), timeoutMs);
    timer.unref?.();
  });
  let reply;
  try {
    reply = await Promise.race([request, gaveUp]);
  } catch (error) {
    request.then((late) => {
      const lateHandle = late?.resource?.stream;
      if (lateHandle) cdpDomains(cdp).IO.close( { handle: lateHandle }, sid).catch(() => {});
    }, () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const resource = reply?.resource;
  if (!resource?.success || !resource.stream) {
    // An HTTP error is a definitive miss; a network error (aborted by a navigation, server not
    // up yet) is transient, so the resolver retries on the next output instead of caching it.
    if (Number(resource?.httpStatusCode) >= 400) return null;
    throw new Error(`Network.loadNetworkResource failed: ${resource?.netErrorName || 'no stream'}`);
  }
  const handle = resource.stream;
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await cdpDomains(cdp).IO.read( { handle, size: 1024 * 1024 }, sid, timeoutMs);
      const data = Buffer.from(String(chunk.data || ''), chunk.base64Encoded ? 'base64' : 'utf8');
      bytes += data.length;
      if (bytes > maxBytes) return null;
      chunks.push(data);
      if (chunk.eof || data.length === 0) break;
    }
  } finally {
    await cdpDomains(cdp).IO.close( { handle }, sid, timeoutMs).catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function attachDaemonTarget(cdp, targetId, { background = false } = {}) {
  // Wake up the tab first (avoids timeouts on suspended/inactive background tabs).
  // Background mode (#415) skips it: activating the tab raises the window over the user's work.
  if (!background) await cdpDomains(cdp).Target.activateTarget( { targetId }).catch(() => {});
  const res = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true });
  return res.sessionId;
}
export function foregroundActivationRequest(env = process.env) {
  return explicitBackgroundChoice(env) === false ? { cmd: FOREGROUND_ACTIVATE_COMMAND, args: [] } : null;
}
export async function revealHiddenTab(cdp, sid, targetId, {
  state = null,
  timeoutMs = REVEAL_POLL_TIMEOUT_MS,
  pollMs = 50,
  sleep: wait = sleep,
  now = Date.now,
} = {}) {
  const before = await probePageVisibility(cdp, sid);
  if (before === 'visible') {
    if (state) state.activationIneffective = false;
    return { activated: false, visibility: before };
  }
  await cdpDomains(cdp).Target.activateTarget( { targetId }, undefined, 5000);
  // An activation that did not make the tab visible (a window covered by other windows: Windows does
  // not let Chrome raise itself) will not do better on the next call, so later calls skip the wait.
  if (state?.activationIneffective) return { activated: true, visibility: before, polled: false };
  const deadline = now() + timeoutMs;
  let visibility = await probePageVisibility(cdp, sid);
  while (visibility !== 'visible' && now() < deadline) {
    await wait(pollMs);
    visibility = await probePageVisibility(cdp, sid);
  }
  if (state) state.activationIneffective = visibility !== 'visible';
  return { activated: true, visibility, polled: true };
}
// Command failures that runActionWithFeedback has not already printed. A selector
// miss is probed for frames here; classified text already includes that sentence.
function errorSourceFrom(err) {
  if (!err || typeof err !== 'object') return null;
  const source = {};
  if (err.pageException === true) source.pageException = true;
  if (err.navigationFailure === true) source.navigationFailure = true;
  if (err.usage === true) source.usage = true;
  if (err.code === 'usage') source.code = 'usage';
  if (err.selectorMiss === true) source.selectorMiss = true;
  if (err.unknownFrame === true) source.unknownFrame = true;
  if (err.hoverCovered === true) source.hoverCovered = true;
  return Object.keys(source).length ? source : null;
}
export async function daemonCommandCatchResult(e, {
  cdp,
  sessionId,
  cmd,
  args,
  targetId,
  session,
  dialogBuf,
  dialogSince,
  jsDialogs,
}) {
  if (jsDialogs.hasPending()) await jsDialogs.waitForPending(1500).catch(() => {});
  const commandMeta = COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd));
  const isMutatingCommand = commandMeta?.mutates === true;
  const lastAction = session.lastAction || {};
  const context = {
    action: isMutatingCommand && lastAction.action ? lastAction.action : cmd,
    target: isMutatingCommand && lastAction.target ? lastAction.target : { targetId, input: args?.[0], label: args?.[0] },
  };
  // click-no-change is thrown after dispatch returns. The dialog buffer still
  // shows the confirm that click opened, so the --accept-dialog Next stays.
  // A new binding: ESLint no-ex-assign forbids writing the catch parameter.
  const actionError = errorYieldingToDismissedDialog(e, {
    dialogBuf,
    sinceSeq: dialogSince,
    action: context.action,
    target: context.target,
  });
  const rawError = actionFailureMessage(actionError);
  const alreadyClassified = isClassifiedActionFailureText(rawError);
  if (!alreadyClassified) await attachSelectorFrameMiss(cdp, sessionId, actionError, context.target, session?.refs);
  const failure = classifyActionFailure(actionError, context);
  // #717: this usage refusal must stay a classified action failure. Other usage
  // errors stay raw so the CLI can name help; this one would otherwise become
  // Kind: unknown / Next: cdp status.
  const crossSiteAction = Boolean(actionError?.crossSiteFrameAction)
    || /actions inside cross-site frames are not supported yet/i.test(rawError);
  const error = alreadyClassified || failure.kind === 'native-dialog' || crossSiteAction || (isMutatingCommand && failure.kind !== 'unknown' && failure.kind !== 'usage')
    ? formatActionFailure(actionError, context)
    : rawError;
  const errorSource = errorSourceFrom(actionError);
  return errorSource ? { ok: false, error, errorSource } : { ok: false, error };
}
export async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {
  const exitLog = { current: null };
  installDaemonCrashRecorder(targetId, {
    onCrash: (kind, error) => exitLog.current?.onCrash(kind, error),
  });
  resetScreenshotTier();
  const sp = sockPath(targetId);
  const daemonMetadata = {
    ...collectDaemonMetadata(),
    requestedTargetId: targetId,
    boundTargetId: targetId,
  };
  if (await daemonAlreadyServes(sp)) process.exit(0);

  const cdp = new CDP();
  try {
    const wsUrl = await getWsUrl();
    await cdp.connect(wsUrl);
    // Lets a CLI call reuse this daemon's page list only for the same endpoint (#419).
    daemonMetadata.cdpEndpoint = cdpEndpointFromWsUrl(wsUrl);
    try { await rememberLiveCdpEndpointFromSession(cdp); } catch {}
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  const background = daemonBackgroundMode(targetId);
  setBackgroundCaptureGuard(background);
  try {
    sessionId = await attachDaemonTarget(cdp, targetId, { background });
    rememberSessionTarget(sessionId, targetId);
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  const session = createSessionState({ targetId, sessionId });
  session.runtimeDir = RUNTIME_DIR;
  exitLog.current = createDaemonExitLog(session);
  // Whether the last `_activate` left the tab hidden (#488).
  const revealState = { activationIneffective: false };
  const tableArtifactStore = createTableArtifactStore({
    runtimeDir: RUNTIME_DIR,
    targetId,
    sessionId: randomBytes(16).toString('hex'),
    platform: process.platform,
  });
  const tableCollectorSession = { collector: null };
  ensureSessionScreenshotDir(session);

  // --- Background observation ---
  const consoleBuf = new RingBuffer(200);
  const exceptionBuf = new RingBuffer(50);
  const navBuf = new RingBuffer(10);
  const netReqBuf = new RingBuffer(100); // network request/response pairs
  // #466: committed main-frame URLs for the CDP_ALLOWED_ORIGINS check after each command, and
  // this daemon's CDP_CONTENT_BOUNDARIES nonce. The nonce never reaches the page.
  const mainFrameNavigationLog = createMainFrameNavigationLog();
  const contentBoundaryNonce = createContentBoundaryNonce();
  const pendingReqs = session.pendingRequests; // requestId → {method, url, ts}
  const networkStatusByRequest = createEarlyResponseStatusStore(); // ExtraInfo statuses that arrived before their request
  const netRequestStore = createNetlogRequestStore({
    shouldTrack: shouldTrackActionNetworkRequest,
    onChange: () => rememberTabObservation(session),
  });
  let lastReadSeq = { console: 0, exception: 0 };

  // --- Ref system & perceive diff state ---
  const refMap = session.refs.map;              // ref number → backendDOMNodeId
  const lastPerceiveStore = session.lastPerceive; // stores last perceive output for diff
  const refState = session.refs;                // ref lifecycle for stale @ref errors
  session.buffers = {
    console: consoleBuf,
    exception: exceptionBuf,
    navigation: navBuf,
    network: netReqBuf,
  };
  session.netRequestStore = netRequestStore;
  // Before any CDP event, so a replayed navigation cannot hide the saved netlog (#606).
  restoreTabObservation(session);

  // Enable domains for background collection and ref resolution
  await enableDaemonDomains(cdp, sessionId);

  // Source maps resolve lazily, only when console/status/an action receipt prints a frame (#470).
  const sourceMaps = createSourceMapResolver({
    loadText: (url, opts) => loadSourceMapText(cdp, sessionId, url, opts),
  });
  const locateSourceFrames = entries => sourceMaps.locateEntries(entries);

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    consoleBuf.push(consoleEntryFromEvent(params));
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    exceptionBuf.push(exceptionEntryFromEvent(params));
  });

  cdp.onEvent('Page.frameNavigated', (params) => {
    if (!params.frame.parentId) { // main frame only
      // A reload can serve a rebuilt bundle under the same URL; maps are re-read on demand.
      sourceMaps.clear();
      navBuf.push({ url: params.frame.url, ts: Date.now() });
      mainFrameNavigationLog.record(params.frame.url);
      // Top-level navigation (or Vite HMR full reload) invalidates all @refs.
      session.pageGeneration += 1;
      invalidateSessionRefs(session, 'navigation');
      if (session.daemonReady && session.restoredNetlogHold) {
        session.restoredNetlogHold = false;
        rememberTabObservation(session);
      }
    }
  });

  // --- Network request/response tracking ---
  // Per-request detail behind `netlog --id N` (#467), fed by its own listeners.
  for (const [event, handler] of Object.entries(netRequestStore.handlers)) cdp.onEvent(event, handler);
  const networkObserver = createDaemonNetworkObserver({ pendingReqs, netReqBuf, networkStatusByRequest, session });
  for (const [event, handler] of Object.entries(networkObserver)) cdp.onEvent(event, handler);

  cdp.onEvent('Fetch.requestPaused', (params) => {
    handleMockRequestPaused(cdp, sessionId, session, params).catch(() => {
      cdpDomains(cdp).Fetch.continueRequest( { requestId: params.requestId }, sessionId).catch(() => {});
    });
  });

  // --- Dialog handling (alert/confirm/prompt/beforeunload) ---
  const dialogBuf = new RingBuffer(20);
  session.buffers.dialog = dialogBuf;
  // Dismiss by default (confirm → Cancel, prompt → null, beforeunload → stay) so a dialog
  // cannot lock the page and a confirm() cannot run its OK branch (#658). `dialog <target> accept`
  // or `--accept-dialog` on the triggering command is required to accept. Action receipts report
  // each answer (#460). The saved mode is applied here, before any request, and before throttle
  // and mocks are replayed. Network replay waits until this process owns the socket so a loser
  // does not emulate over the daemon that won it (#575).
  const savedEnvironment = readTabEnvironment(targetId);
  const dialogAutoAcceptRef = { value: savedDialogAccepts(savedEnvironment) };
  session.dialogMode = dialogAutoAcceptRef.value ? 'accept' : 'dismiss';
  let commandAcceptDialog = false;
  session.environmentRestore = withObservationNotice(environmentRestoreOutcome(savedEnvironment), session);
  let environmentReady = Promise.resolve();
  const jsDialogs = createJavaScriptDialogSession();
  cdp.onEvent('Page.javascriptDialogOpening', (params, msg) => {
    jsDialogs.track(handleOpeningJavaScriptDialog(cdp, sessionId, params, msg, {
      accept: nativeDialogShouldAccept({
        commandAccept: commandAcceptDialog,
        savedAccept: dialogAutoAcceptRef.value,
      }),
      dialogBuf,
    }));
  });

  // Shutdown helpers
  let server = null;
  const requestConnections = new Set();
  const endpointLifecycle = createDaemonEndpointLifecycle({
    targetId,
    socketPath: sp,
    requestConnections,
    getServer: () => server,
    cleanupSession: () => tableArtifactStore.cleanupSession(),
    closeCdp: () => cdp.close(),
    beforeExit: info => exitLog.current.beforeExit(info),
  });
  const shutdown = endpointLifecycle.shutdown;

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown(0, { reason: 'target-destroyed' });
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown(0, { reason: 'target-detached' });
  });
  cdp.onClose(() => shutdown(0, { reason: 'browser-disconnect' }));
  process.on('SIGTERM', () => shutdown(0, { reason: 'signal', signal: 'SIGTERM' }));
  process.on('SIGINT', () => shutdown(0, { reason: 'signal', signal: 'SIGINT' }));

  // Idle timer
  const idleTimer = createDaemonIdleTimer({ timeoutMs: IDLE_TIMEOUT, onIdle: () => shutdown(0, { reason: 'idle-timeout' }) });
  // Other tabs' old runtime artifacts (#462), pruned after the first answered request.
  const runtimePrune = createRuntimePruneScheduler({ run: () => pruneDaemonRuntimeArtifacts(session, targetId) });
  function resetIdle() {
    idleTimer.reset();
  }
  function extendKeepalive(ms) {
    const keepaliveUntil = idleTimer.extendKeepalive(ms);
    return `Daemon keepalive extended for ${ms}ms (until ${new Date(keepaliveUntil).toISOString()})`;
  }

  // Action feedback: wait for DOM to settle, then return structured evidence.
  async function observeActionDiffForTarget(target = {}, baselineOutput = null, baselineOpts = null, { captureFailed = false } = {}) {
    const targetFrameRef = frameRefFromActionTarget(target);
    await waitForSettle(cdp, sessionId);
    if (!baselineOutput) {
      const after = await perceiveStr(
        cdp,
        sessionId,
        consoleBuf,
        exceptionBuf,
        refMap,
        lastPerceiveStore,
        actionObservationPerceiveOpts(targetId, {
          ...(targetFrameRef ? { frameRef: targetFrameRef } : {}),
        }),
        refState,
      );
      return noBaselineActionDiff(after, { captureFailed });
    }
    const snapshot = actionSettleObserveOpts(targetId, target, baselineOutput, baselineOpts);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      snapshot,
      refState
    );
  }
  async function observeFullPerceive() {
    await waitForSettle(cdp, sessionId);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      actionObservationPerceiveOpts(targetId),
      refState,
    );
  }
  async function actionFeedback(action, actionDispatch, target = {}, feedbackPolicy = 'settle-diff', observe = null, format = 'text', captureActionResult = null) {
    const dispatch = typeof actionDispatch === 'function' ? actionDispatch : async () => actionDispatch;
    const actionTarget = target && typeof target === 'object'
      ? { ...target, targetId }
      : { input: String(target || ''), label: String(target || ''), targetId };
    if (action === 'click' || action === 'jsclick' || action === 'clickxy') {
      const alreadyStuck = await stuckOpenerBeforeClick(cdp, sessionId);
      if (alreadyStuck) {
        return runActionWithFeedback({
          action,
          target: actionTarget,
          dispatch: async () => { throw openerUnusableError(alreadyStuck); },
          dispatchMethod: actionTarget.dispatchMethod || action,
          feedbackPolicy: 'none',
          observe: async () => '',
          format,
          cdp,
          sid: sessionId,
          refState,
        });
      }
    }
    const pageGeneration = () => session.pageGeneration;
    const settleBaseline = await resolveActionSettleBaseline({
      cdp,
      sid: sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      refState,
      lastPerceiveStore,
      targetId,
      action,
      actionTarget,
      feedbackPolicy,
      observe,
      pageGeneration,
    });
    const baselineOutput = settleBaseline.output;
    const baselineOpts = settleBaseline.opts;
    if (settleBaseline.baselineStale) actionTarget.baselineStale = true;
    const observationBaseline = createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf, dialogBuf });
    const actionStartedAt = Date.now();
    const observeAfterAction = observe || (() => observeActionDiffForTarget(actionTarget, baselineOutput, baselineOpts, {
      captureFailed: settleBaseline.captureFailed === true,
    }));
    let postActionPageHealth = null;
    const watchNavigation = action === 'click' || action === 'jsclick' || action === 'clickxy';
    let beforePage = actionTarget.page || { title: '', url: '', contentType: '' };
    const pageInfoPromise = pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) })
      .then((page) => {
        beforePage = {
          title: page?.title || beforePage.title || '',
          url: page?.url || beforePage.url || '',
          contentType: page?.contentType || beforePage.contentType || '',
        };
        actionTarget.page = beforePage;
        return beforePage;
      })
      .catch(() => actionTarget.page || beforePage);
    // Live fill state is a dispatch channel, not target metadata: keep it out of logs/receipts.
    const fillValueState = actionTarget.fillValueState || null;
    delete actionTarget.fillValueState;
    const dragState = actionTarget.dragState || null;
    delete actionTarget.dragState;
    // Effects the dispatch itself observed (click --expect-download, #472), merged into the result.
    const dispatchEffects = actionTarget.actionEffects || null;
    delete actionTarget.actionEffects;
    const wrappedDispatch = async () => {
      try {
        const snapshotControls = shouldSnapshotFormControlState(action, actionTarget);
        const beforeControl = snapshotControls
          ? await snapshotFormControlState(cdp, sessionId, actionTarget.input, refMap, refState)
          : null;
        const text = await dispatch();
        // actionFeedback shallow-copies the target before dispatch. The readback
        // lives on the session until it is copied onto that clone (#578).
        if (action === 'viewport') rememberViewportReadback(actionTarget, session);
        if (jsDialogs.hasPending()) await jsDialogs.waitForPending(1500);
        const dismissedDialog = dismissedDecisionDialogSince(dialogBuf, observationBaseline.dialog);
        if (dismissedDialog) throw nativeDialogDismissedError(dismissedDialog, { action, target: actionTarget });
        if (shouldSkipActionPageEvaluate(jsDialogs)) {
          actionTarget.dialogBlocked = true;
          actionTarget.dispatchText = String(text || '');
          return text;
        }
        if (snapshotControls) {
          const afterControl = await snapshotFormControlState(cdp, sessionId, actionTarget.input, refMap, refState);
          if (formControlStateChanged(beforeControl, afterControl)) {
            actionTarget.controlStateChanged = true;
            actionTarget.controlStateDiff = formatActionControlStateDiff(cdp, sessionId, actionTarget.input, refState, beforeControl, afterControl);
          }
        }
        actionTarget.dispatchText = String(text || '');
        if (action === 'fill') applyFillValueState(actionTarget, fillValueState);
        // #471: a sortable reorder changes sibling order, which the AX diff does not show.
        if (action === 'drag' && dragState?.orderChange) {
          actionTarget.controlStateChanged = true;
          actionTarget.controlStateDiff = dragState.orderChange;
          actionTarget.stateChangeLabel = 'Order changed';
        }
        if (looksLikeClipboardControl(text) || isExpectedClipboardNoChange(actionTarget, text)) {
          actionTarget.expectedOutcome = 'clipboard-no-change';
        }
        if (action === 'dismiss-modal' && /no visible modal\/dialog detected/i.test(String(text || ''))) {
          actionTarget.expectedOutcome = 'no-modal';
        }
        if (action === 'press' || actionTarget.resolvedBy === 'key') {
          actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'press-no-change';
        }
        if (watchNavigation) {
          await pageInfoPromise;
          const afterUrl = await evalPageHref(cdp, sessionId);
          const beforeUrl = beforePage.url || '';
          if (shouldSkipActionDomSettle(beforeUrl, afterUrl)) {
            actionTarget.navigated = true;
            actionTarget.pageHrefBefore = beforeUrl;
            actionTarget.pageHrefAfter = afterUrl;
          }
        }
        return text;
      } catch (error) {
        if (action === 'fill') markSensitiveFillTarget(actionTarget, fillValueState);
        await jsDialogs.waitForPending(1500).catch(() => {});
        if (shouldSkipActionPageEvaluate(jsDialogs)) {
          actionTarget.dialogBlocked = true;
        }
        await pageInfoPromise;
        // A confirm opened by this click, fill, or press means the input was delivered.
        throw errorYieldingToDismissedDialog(error, {
          dialogBuf,
          sinceSeq: observationBaseline.dialog,
          action,
          target: actionTarget,
        });
      }
    };
    const observeThenFlush = async () => {
      if (actionTarget.expectedOutcome === 'clipboard-no-change') {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return 'No changes detected (clipboard action).';
      }
      if (actionTarget.expectedOutcome === 'no-modal') {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return 'No changes detected (no modal).';
      }
      if (actionTarget.navigated) {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        const quietOpts = actionNetworkQuietOptions(action, { navigated: true });
        if (quietOpts) await waitForActionNetworkQuiet(pendingReqs, quietOpts);
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        postActionPageHealth = await collectPageHealth(cdp, sessionId, { changed: true }).catch(() => null);
        return formatActionNavigationDiff(actionTarget.pageHrefBefore, actionTarget.pageHrefAfter);
      }
      // #437: the link's page is in another tab; this tab's AX diff is not the evidence.
      const openedTab = watchNavigation ? parseClickOpenedTab(actionTarget.dispatchText) : null;
      if (openedTab) {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return `Opened ${openedTab.existing ? 'in tab' : 'new tab'} ${openedTab.targetPrefix}: ${openedTab.url}`;
      }
      let text = await observeAfterActionGuardingDialogs(jsDialogs, observeAfterAction);
      if (actionTarget.dialogBlocked || shouldSkipActionPageEvaluate(jsDialogs)) {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return text;
      }
      if (actionTarget.controlStateChanged) {
        const note = `${actionTarget.stateChangeLabel || 'Control state changed'}: ${actionTarget.controlStateDiff}`;
        text = actionDomDiffShowsChange(text) ? `${note}\n${text}` : note;
      }
      const quietOpts = actionNetworkQuietOptions(action);
      if (quietOpts) await waitForActionNetworkQuiet(pendingReqs, quietOpts);
      appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
      postActionPageHealth = await collectPageHealth(cdp, sessionId, {
        changed: actionDomDiffShowsChange(text) || Boolean(actionTarget.controlStateChanged),
      }).catch(() => null);
      return text;
    };
    session.lastAction = { action, target: actionTarget, feedbackPolicy, ts: actionStartedAt, baselineOutput, baselineOpts };
    return runActionWithFeedback({
      action,
      target: actionTarget,
      dispatch: wrappedDispatch,
      dispatchMethod: actionTarget.dispatchMethod || action,
      feedbackPolicy,
      observe: observeThenFlush,
      cdp,
      sid: sessionId,
      refState,
      enrichActionResult: async (actionResult) => {
        await pageInfoPromise;
        applyActionObservationDelta(actionResult, await buildLocatedActionObservationDelta(
          { consoleBuf, exceptionBuf, netReqBuf, dialogBuf },
          observationBaseline,
          locateSourceFrames,
        ));
        const failedRequests = await describeFailedActionRequests(netReqBuf.since(observationBaseline.network || 0), {
          store: netRequestStore,
          readBody: detail => readNetlogResponseBody(cdp, sessionId, detail, { timeoutMs: FAILED_REQUEST_BODY_TIMEOUT_MS }),
        });
        if (failedRequests.length) actionResult.effects.failedRequests = failedRequests;
        if (dispatchEffects) Object.assign(actionResult.effects, dispatchEffects);
        await applyLateClickDownload(cdp, actionResult);
        if (postActionPageHealth) actionResult.effects.pageHealth = postActionPageHealth;
        else if (actionTarget.page && (actionTarget.page.title || actionTarget.page.url)) {
          actionResult.effects.pageHealth = actionResult.effects.pageHealth || {
            status: 'populated',
            isBlank: false,
            evidence: {
              url: actionTarget.page.url || '',
              title: actionTarget.page.title || '',
            },
          };
        }
        if (actionTarget.navigated) {
          actionResult.effects.navigation = {
            from: actionTarget.pageHrefBefore,
            to: actionTarget.pageHrefAfter,
            changed: true,
          };
        }
        const livePage = livePageIdentity({
          page: actionTarget.page || {},
          pageHealth: actionResult.effects.pageHealth,
          navigation: actionResult.effects.navigation,
        });
        if (livePage.url || livePage.title) {
          const contentType = actionResult.effects.navigation?.changed
            ? ''
            : actionTarget.page?.contentType;
          actionResult.effects.page = contentType ? { ...livePage, contentType } : livePage;
        } else if (actionTarget.page) actionResult.effects.page = actionTarget.page;
        return actionResult;
      },
      onActionResult: (actionResult) => {
        appendSessionActionLog(session, actionResult, { ts: session.lastAction.ts });
        captureActionResult?.(actionResult);
      },
      format,
    });
  }

  const applicationRegistry = applicationPreflight.registry;
  const readCapabilities = {
    cascade: args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return cascadeStr(cdp, sessionId, fopts.args[0], fopts.args[1], refMap, refState, {
        format: fopts.format,
        targetPrefix: targetPrefixForDisplay(targetId),
      });
    },
    checkpoint: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const copts = parseCheckpointArgs(fopts.args);
      if (copts.args.length) throw new Error(`checkpoint: unknown argument ${copts.args[0]}`);
      const output = await checkpointStr(cdp, sessionId, {
        format: fopts.format,
        unsafeFullCapture: copts.unsafeFullCapture,
      });
      appendSessionEventLog(session, checkpointSessionEvent(output));
      return output;
    },
    components: args => componentsStr(cdp, sessionId, args, refMap, refState),
    console: async args => {
      const opts = parseConsoleArgs(args);
      if (opts.mode === 'clear') {
        const model = clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq);
        return opts.format === 'json' ? formatJson(model) : model.message;
      }
      if (opts.format === 'json') {
        const selected = selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, opts.mode);
        const located = await locateObservedEntries(locateSourceFrames, selected.entries, selected.exceptions);
        const output = formatJson(buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, opts.mode, located, { unsafeFull: opts.unsafeFull }));
        if (opts.mode === 'new') {
          lastReadSeq.console = consoleBuf.latest();
          lastReadSeq.exception = exceptionBuf.latest();
        }
        return output;
      }
      return consoleStr(consoleBuf, exceptionBuf, lastReadSeq, opts.mode, { locate: locateSourceFrames, unsafeFull: opts.unsafeFull });
    },
    controls: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const copts = parseControlsArgs(fopts.args);
      return controlsStr(cdp, sessionId, { ...copts, format: fopts.format });
    },
    cookies: args => cookiesStr(cdp, sessionId, parseCookieArgs(args)),
    'diff-shot': args => diffShotStr(cdp, sessionId, session, parseDiffShotArgs(args)),
    elshot: args => {
      const { selector, filePath } = parseElshotArgs(args);
      return elshotStr(cdp, sessionId, selector, targetId, refMap, refState, filePath);
    },
    'export-playwright': args => formatExportPlaywright(session, parseExportPlaywrightArgs(args)),
    frame: async args => framesStr(cdp, sessionId, parseFrameArgs(args)),
    fullshot: args => fullshotStr(cdp, sessionId, args, targetId, { refMap, refState }),
    html: args => htmlStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    text: args => textStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    table: async (request, execution) => request.mode === 'continue'
      ? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)
      : request.mode === 'collect'
        ? tableCollectionStr(cdp, sessionId, request, execution, { store: tableArtifactStore, session: tableCollectorSession })
        : tableObservationStr(cdp, sessionId, request),
    net: () => netStr(cdp, sessionId),
    overlay: args => overlayStr(cdp, sessionId, targetId, args, refMap, refState),
    record: args => recordStr(cdp, sessionId, args, refMap),
    'record-actions': args => {
      const opts = parseRecordActionsArgs(args);
      if (opts.clear) return clearRecordedActions(session, { format: opts.format });
      return formatRecordActions(session, { format: opts.format });
    },
    scanshot: () => scanshotStr(cdp, sessionId, targetId),
    shot: async args => {
      if (args[0] === '--annotate' || args[0] === '-a') {
        const output = await annotshotStr(cdp, sessionId, targetId, refMap);
        appendSessionScreenshot(session, {
          kind: 'annotshot',
          path: output.split('\n')[0],
          note: 'annotated refs',
        });
        return output;
      }
      const sopts = parseShotArgs(args);
      const filePath = sopts.filePath || nextSessionScreenshotPath(session, 'shot');
      if (!sopts.filePath) ensureSessionScreenshotDir(session);
      const output = await shotStr(cdp, sessionId, filePath, targetId, { quiet: sopts.quiet, verbose: sopts.verbose });
      appendSessionScreenshot(session, {
        kind: 'shot',
        path: output.split('\n')[0],
        note: sopts.filePath ? 'custom path' : 'session screenshot',
      });
      return output;
    },
    snap: args => snapshotStr(cdp, sessionId, args[0] !== '--full', { targetPrefix: targetPrefixForDisplay(targetId) }),
    status: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const lifted = takeUnsafeFullArg(fopts.args);
      if (fopts.format === 'json') {
        const runtime = lifted.args.includes('--runtime')
          ? await runtimeMetricsStr(cdp, sessionId).catch(e => ({ unavailable: e.message }))
          : null;
        const vitals = lifted.args.includes('--vitals') ? await webVitalsModelOrUnavailable(cdp, sessionId) : null;
        const page = await pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) });
        const located = await locateObservedEntries(
          locateSourceFrames,
          consoleBuf.since(lastReadSeq.console),
          exceptionBuf.since(lastReadSeq.exception),
        );
        const output = formatJson(buildStatusModel({
          targetId,
          page: { title: page.title, url: page.url },
          consoleBuf,
          exceptionBuf,
          navBuf,
          lastReadSeq,
          runtime,
          vitals,
          diagnostic: page.diagnostic || null,
          located,
          unsafeFull: lifted.unsafeFull,
        }));
        lastReadSeq.console = consoleBuf.latest();
        lastReadSeq.exception = exceptionBuf.latest();
        return output;
      }
      return statusStr(cdp, sessionId, consoleBuf, exceptionBuf, navBuf, lastReadSeq, {
        runtime: lifted.args.includes('--runtime'),
        vitals: lifted.args.includes('--vitals'),
        targetPrefix: targetPrefixForDisplay(targetId),
        locate: locateSourceFrames,
        unsafeFull: lifted.unsafeFull,
      });
    },
    styles: args => stylesStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    summary: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const lifted = takeUnsafeFullArg(fopts.args);
      const extra = { targetPrefix: targetPrefixForDisplay(targetId), unsafeFull: lifted.unsafeFull };
      return fopts.format === 'json'
        ? formatJson(await summaryModel(cdp, sessionId, consoleBuf, exceptionBuf, extra))
        : summaryStr(cdp, sessionId, consoleBuf, exceptionBuf, extra);
    },
    wait: args => waitStr(args[0]),
    waitfor: args => waitForStr(cdp, sessionId, args, refMap, refState),
  };
  Object.freeze(readCapabilities);
  const recordActionsBuilder = applicationPreflight.handlerBuilders['record-actions'];
  const exportPlaywrightBuilder = applicationPreflight.handlerBuilders['export-playwright'];
  const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];
  const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];
  const diffShotBuilder = applicationPreflight.handlerBuilders['diff-shot'];
  const responsiveAuditBuilder = applicationPreflight.handlerBuilders['responsive-audit'];
  const scriptCapabilities = {
    eval: async args => {
      const eopts = parseEvalArgs(args);
      let value;
      if (eopts.fireAndForget) {
        value = await evalFireAndForgetStr(cdp, sessionId, eopts.expression, true);
        value += `\n${extendKeepalive(FIRE_AND_FORGET_KEEPALIVE)} (fire-and-forget default)`;
      } else {
        value = await evalStr(cdp, sessionId, eopts.expression, true, { raw: eopts.raw, pageException: true });
      }
      return commandResult(value, null);
    },
    eval64: async args => commandResult(
      await evalStr(cdp, sessionId, evalBase64Decode(args[0]), true, { pageException: true }),
      null,
    ),
    call: async args => commandResult(await callStr(cdp, sessionId, args.join(' ')), null),
  };
  const actionCapabilities = {
    back: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('back', () => historyNavStr(cdp, sessionId, -1), { input: 'back', resolvedBy: 'history', label: 'back', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    clickxy: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('clickxy', () => clickXyStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: `${fopts.args[0]},${fopts.args[1]}`, resolvedBy: 'coordinates', label: `${fopts.args[0]},${fopts.args[1]}`, commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    clock: async args => commandResult(
      await clockStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    closetab: async args => commandResult(
      await closetabStr(cdp, targetId, parseClosetabArgs(args)),
      { kind: 'action-receipt' },
    ),
    cookiedel: async args => commandResult(
      await cookieDelStr(cdp, sessionId, args[0]),
      { kind: 'action-receipt' },
    ),
    cookieset: async args => commandResult(
      await cookieSetStr(cdp, sessionId, args[0]),
      { kind: 'action-receipt' },
    ),
    dialog: async args => commandResult(
      setDialogMode(dialogBuf, dialogAutoAcceptRef, session, args[0]),
      null,
    ),
    'dismiss-modal': async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('dismiss-modal', () => dismissModalStr(cdp, sessionId), { input: 'modal', resolvedBy: 'dialog', label: 'modal', commandArgs: [] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    drag: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const opts = parseDragArgs(fopts.args);
      // dragStr records a sibling-order change here; actionFeedback turns it into receipt state.
      const dragState = {};
      const value = await actionFeedback('drag', () => dragStr(cdp, sessionId, opts, refMap, refState, dragState), { input: opts.from, resolvedBy: 'selector-or-ref', label: `${opts.from} → ${opts.to}`, commandArgs: [...fopts.args], dragState }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    emulate: async args => commandResult(
      await emulateStr(cdp, sessionId, session, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
      { kind: 'action-receipt' },
    ),
    fill: createDaemonFillCapability({
      session,
      actionFeedback,
      fill: (selector, text, opts) => fillStr(cdp, sessionId, selector, text, refMap, refState, opts),
    }),
    hover: async args => {
      const text = await dispatchHoverWithLeftoverPolicy({
        cdp,
        sid: sessionId,
        selector: args[0],
        refMap,
        refState,
        consoleBuf,
        exceptionBuf,
        lastPerceiveStore,
        targetId,
        nextCommand: session.batchNextCommand,
      });
      return commandResult(text, null);
    },
    inject: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const safeCommandArgs = fopts.args.map((arg, index) => index === 0 ? arg : '<redacted>');
      const value = await actionFeedback(
        'inject',
        async () => {
          try {
            return await injectStr(cdp, sessionId, fopts.args);
          } catch (error) {
            throw redactExternalInputActionError(error, 'inject', fopts.args);
          }
        },
        {
          input: fopts.args[0] || '',
          resolvedBy: 'command',
          label: fopts.args[0] || 'inject',
          commandArgs: safeCommandArgs,
          redacted: ['commandArgs'],
        },
        'state-change',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    jsclick: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const selector = fopts.args[0];
      const clickTrust = {};
      const target = namedClickActionTarget(selector);
      target.clickTrust = clickTrust;
      const value = await actionFeedback(
        'jsclick',
        () => jsClickStr(cdp, sessionId, selector, refMap, refState, { clickTrust }),
        target,
        jsclickFeedbackPolicy(selector),
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    keepalive: async args => commandResult(
      extendKeepalive(parseDelayMs(args[0], { name: 'keepalive duration' })),
      null,
    ),
    loadall: async args => {
      const parsed = parseLoadAllArgs(args);
      return commandResult(
        await loadAllStr(cdp, sessionId, parsed.selector, parsed.intervalMs, { timeoutMs: parsed.timeoutMs }),
        null,
      );
    },
    mock: async args => commandResult(
      await mockStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    forward: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('forward', () => historyNavStr(cdp, sessionId, +1), { input: 'forward', resolvedBy: 'history', label: 'forward', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    nav: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const positional = [];
      let perceive = false;
      for (const arg of fopts.args) {
        if (arg === '--perceive') perceive = true;
        else if (String(arg).startsWith('--')) throw new Error(`nav: unknown argument ${arg}`);
        else positional.push(arg);
      }
      const url = positional[0];
      const value = await actionFeedback('nav', () => navActionDispatch({
        cdp,
        sessionId,
        url,
        targetId,
        onSessionId(nextSid) { sessionId = nextSid; },
        navigationCancelWatch: createNavigationCancelWatch({ dialogBuf, jsDialogs, session, dismissMode: () => !nativeDialogShouldAccept({ commandAccept: commandAcceptDialog, savedAccept: dialogAutoAcceptRef.value }) }),
      }), { input: url, resolvedBy: 'url', label: url || '', commandArgs: [url] }, perceive ? 'full-perceive' : 'state-change', perceive ? observeFullPerceive : () => observeNavPage(cdp, sessionId), fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    netlog: async args => {
      const opts = parseNetlogArgs(args);
      if (opts.id != null) {
        return commandResult(await netlogRequestStr(cdp, sessionId, netRequestStore, opts, { targetId: session.targetId }), null);
      }
      return commandResult(netlogStr(netReqBuf, opts.clear ? '--clear' : null, {
        lastNavigationTs: navBuf.all().at(-1)?.ts ?? null,
        holdRestored: session.restoredNetlogHold === true,
        observationUnreadable: session.observationRestore?.status === 'unreadable',
        unsafeFull: opts.unsafeFull,
        format: opts.format,
        filters: opts,
        requestStore: netRequestStore,
        targetId: session.targetId,
        session,
      }), null);
    },
    press: async args => {
      const parsed = parsePressArgs(args);
      const usage = pressUsageError(parsed.key);
      if (usage) throw usage;
      const awaitListing = parsed.viaListing && session.awaitSearchSubmitListing === true;
      const filledQuery = session.searchSubmitQuery;
      session.awaitSearchSubmitListing = false;
      session.searchSubmitQuery = undefined;
      const plan = pressSearchSubmitPlan({
        key: parsed.key,
        viaListing: parsed.viaListing,
        awaitListing,
      });
      let searchSubmit = { ok: false };
      if (plan.mode === 'probe-after-fill') {
        searchSubmit = await waitForSearchSubmitProbe(cdp, sessionId, { filledQuery });
      } else if (plan.mode === 'probe-once') {
        searchSubmit = await probeSearchSubmit(cdp, sessionId);
      }
      const commandArgs = parsed.viaListing ? [parsed.key, PRESS_SEARCH_SUBMIT_FLAG] : [parsed.key];
      const value = await actionFeedback(
        'press',
        () => pressStr(cdp, sessionId, parsed.key, {
          viaListing: parsed.viaListing,
          searchSubmit,
          refMap,
          refState,
        }),
        {
          input: parsed.key,
          resolvedBy: 'key',
          label: parsed.key || '',
          commandArgs,
          ...(searchSubmit.ok
            ? { expectedOutcome: 'search-submit' }
            : { expectedOutcome: 'press-no-change' }),
        },
        pressFeedbackPolicy(parsed.key, searchSubmit.ok ? searchSubmit : null),
        null,
        parsed.fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    qa: async args => commandResult(await qaPageStr({
      cdp,
      sid: sessionId,
      session,
      targetId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      refState,
      actionFeedback,
    }, args), { kind: 'action-receipt' }),
    reload: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('reload', () => reloadActionDispatch({
        cdp,
        sessionId,
        session,
        consoleBuf,
        exceptionBuf,
        navBuf,
        netReqBuf,
        pendingReqs,
        networkStatusByRequest,
        lastReadSeq,
        navigationCancelWatch: createNavigationCancelWatch({ dialogBuf, jsDialogs, session, dismissMode: () => !nativeDialogShouldAccept({ commandAccept: commandAcceptDialog, savedAccept: dialogAutoAcceptRef.value }) }),
      }), { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [] }, 'state-change', () => observeReloadPage(cdp, sessionId), fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    'responsive-audit': async args => commandResult(
      await responsiveAuditStr(cdp, sessionId, session, targetId, consoleBuf, exceptionBuf, args),
      { kind: 'action-receipt' },
    ),
    restore: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const safeCommandArgs = redactRestoreCommandArgs(fopts.args);
      const value = await actionFeedback(
        'restore',
        async () => {
          let restoreResult;
          try {
            restoreResult = await restoreCheckpointStr(cdp, sessionId, fopts.args);
          } catch (error) {
            throw redactRestoreActionError(error, fopts.args);
          }
          clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, networkStatusByRequest, lastReadSeq, session });
          session.pageGeneration += 1;
          invalidateSessionRefs(session, 'navigation');
          return restoreResult;
        },
        {
          input: 'checkpoint',
          resolvedBy: 'artifact',
          label: 'checkpoint',
          commandArgs: safeCommandArgs,
          redacted: ['commandArgs'],
        },
        'report-only',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    scroll: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      fopts.args = normalizeScrollArgs(fopts.args);
      const value = await actionFeedback(
        'scroll',
        () => scrollStr(cdp, sessionId, fopts.args[0], fopts.args[1], fopts.args.slice(2)),
        scrollActionTarget(fopts.args),
        scrollFeedbackPolicy(fopts.args[0], fopts.args[1]),
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    select: async args => {
      const wait = parseActionabilityWaitArgs(args, 'select');
      const fopts = parseCompactFormatArgs(wait.args, ['text', 'json']);
      const value = await actionFeedback('select', () => selectStr(cdp, sessionId, fopts.args[0], fopts.args[1], { waitMs: wait.waitMs }, refMap, refState), { input: fopts.args[0], resolvedBy: isRef(fopts.args[0]) ? 'ref' : 'selector', label: fopts.args[0] || '', commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    throttle: async args => commandResult(
      await throttleStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    type: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      if (typeTextNamesSecret(fopts.args[0])) throw new Error(TYPE_SECRET_UNSUPPORTED);
      const value = await actionFeedback('type', () => typeStr(cdp, sessionId, fopts.args[0]), { input: 'current focus', resolvedBy: 'focus', label: 'current focus', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    upload: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback(
        'upload',
        async () => {
          try {
            return await uploadStr(cdp, sessionId, fopts.args[0], fopts.args[1], refMap, refState);
          } catch (error) {
            throw redactExternalInputActionError(error, 'upload', fopts.args);
          }
        },
        {
          input: fopts.args[0],
          resolvedBy: isRef(fopts.args[0]) ? 'ref' : 'selector',
          label: fopts.args[0] || '',
          commandArgs: [fopts.args[0], '<redacted>'],
          redacted: ['commandArgs'],
        },
        'state-change',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    'verify-click': async args => {
      const vopts = parseVerifyClickArgs(args);
      let captured = null;
      const observeAssertions = async () => {
        if (vopts.expectRequest) {
          await waitForActionNetworkQuiet(pendingReqs, { timeoutMs: VERIFY_CLICK_REQUEST_WAIT_MS });
          return '(verify-click request window)';
        }
        await waitForSettle(cdp, sessionId, VERIFY_CLICK_SETTLE_MS);
        return '(verify-click assertion window)';
      };
      await actionFeedback(
        'click',
        () => clickStr(cdp, sessionId, vopts.selector, refMap, refState),
        { input: vopts.selector, resolvedBy: 'selector-or-ref', label: vopts.selector || '', commandArgs: [vopts.selector] },
        'settle-diff',
        observeAssertions,
        'json',
        result => { captured = result; },
      );
      const textMatched = vopts.expectText
        ? await pageContainsText(cdp, sessionId, vopts.expectText).catch(() => false)
        : false;
      const model = buildSemanticInteractionModel(captured || {}, vopts, { textMatched });
      const value = formatActionWorkflowCommandOutput(model, {
        format: vopts.format,
        text: () => `${formatSemanticInteractionResult(model)}${vopts.evidence === 'full' && captured ? `\n---\n${formatActionText(captured)}` : ''}`,
      });
      return commandResult(value, { kind: 'action-receipt' });
    },
    viewport: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = fopts.args[0]
        ? await actionFeedback('viewport', () => viewportStr(cdp, sessionId, fopts.args[0], { session }), { input: fopts.args[0], resolvedBy: 'viewport', label: fopts.args[0], commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts)
        : await viewportStr(cdp, sessionId);
      return commandResult(value, { kind: 'action-receipt' });
    },
  };
  const workflowCapabilities = {
    batch: async args => {
      const parsedBatch = parseBatchArgs(args);
      const { commands, parallel } = parsedBatch;
      if (!commands.length) throw new Error('batch: no commands provided');
      const blocked = commands.filter(command => BATCH_BLOCKED.has(command.cmd));
      if (blocked.length) throw new Error(`batch: ${blocked.map(command => command.cmd).join(', ')} not allowed inside batch`);
      if (parallel) {
        const unsafe = commands.filter(command => isBatchParallelUnsafeCommand(command.cmd, command.args || []));
        if (unsafe.length) throw new Error(`batch --parallel: ${[...new Set(unsafe.map(command => command.cmd))].join(', ')} mutate shared state — use sequential batch`);
      }
      const sequenced = batchCommandLookahead(commands, { parallel });
      const autoActionJson = parsedBatch.output === 'model';
      const runOne = command => runWithBatchLookahead(session, command.nextCommand, () => handleCommand({
        cmd: command.cmd,
        args: autoActionJsonArgs(command.cmd, command.args || [], autoActionJson),
      }));
      const results = await runBatchCommands({ run: runOne }, sequenced, { parallel });
      const format = parsedBatch.output === 'legacy-json' ? 'json' : parsedBatch.output;
      return formatBatchResults(results, format, { targetId, mode: parallel ? 'parallel' : 'sequential' });
    },
    flow: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return flowStr({
        run: step => handleCommand({
          cmd: step.cmd,
          args: autoActionJsonArgs(step.cmd, step.args || [], fopts.format === 'json'),
        }),
        settle: what => settleFlow(cdp, sessionId, what, pendingReqs),
        assertCondition: condition => probePageCondition(cdp, sessionId, condition),
      }, fopts.args.join(' '), { format: fopts.format, targetId, throwOnFailure: true });
    },
    repeat: args => repeatStr({
      run: step => handleCommand({ cmd: step.cmd, args: step.args || [] }),
      probeCondition: condition => probePageCondition(cdp, sessionId, condition),
    }, args),
    replay: args => replayActionsStr({
      run: step => handleCommand({ cmd: step.cmd, args: step.args || [] }),
    }, args),
  };
  const applicationHandlers = {
    report: applicationPreflight.handlerBuilders.report({ session, cdp, sessionId }),
    click: applicationPreflight.handlerBuilders.click({
      actionFeedback,
      click: (selector, opts) => clickStr(cdp, sessionId, selector, refMap, refState, opts),
      jsClick: (selector, clickTrust) => jsClickStr(cdp, sessionId, selector, refMap, refState, { clickTrust }),
      pointerClick: (selector, clickTrust) => pointerClickStr(cdp, sessionId, selector, refMap, refState, clickTrust),
      expectDownload: (options, run, effects) => captureClickDownload({
        browser: clickDownloadBrowser(cdp, sessionId, targetId),
        dir: options.dir || sessionDownloadDir(targetId),
        timeoutMs: options.timeoutMs,
        run,
        effects,
      }),
    }),
    evalraw: applicationPreflight.handlerBuilders.evalraw({
      evalRaw: (method, params, authorization) => evalRawStr(cdp, sessionId, method, params, authorization),
    }),
    perceive: applicationPreflight.handlerBuilders.perceive({
      cdp,
      sessionId,
      targetId,
      session,
      consoleBuf,
      exceptionBuf,
      netReqBuf,
      refMap,
      lastPerceiveStore,
      refState,
    }),
    html: applicationPreflight.handlerBuilders.html(readCapabilities),
    text: applicationPreflight.handlerBuilders.text(readCapabilities),
    table: applicationPreflight.handlerBuilders.table(readCapabilities),
    net: applicationPreflight.handlerBuilders.net(readCapabilities),
    status: applicationPreflight.handlerBuilders.status(readCapabilities),
    summary: applicationPreflight.handlerBuilders.summary(readCapabilities),
    snap: applicationPreflight.handlerBuilders.snap(readCapabilities),
    controls: applicationPreflight.handlerBuilders.controls(readCapabilities),
    frame: applicationPreflight.handlerBuilders.frame(readCapabilities),
    overlay: applicationPreflight.handlerBuilders.overlay(readCapabilities),
    styles: applicationPreflight.handlerBuilders.styles(readCapabilities),
    components: applicationPreflight.handlerBuilders.components(readCapabilities),
    'record-actions': recordActionsBuilder(readCapabilities),
    'export-playwright': exportPlaywrightBuilder(readCapabilities),
    wait: applicationPreflight.handlerBuilders.wait(readCapabilities),
    waitfor: applicationPreflight.handlerBuilders.waitfor(readCapabilities),
    cascade: applicationPreflight.handlerBuilders.cascade(readCapabilities),
    checkpoint: applicationPreflight.handlerBuilders.checkpoint(readCapabilities),
    cookies: applicationPreflight.handlerBuilders.cookies(readCapabilities),
    fill: applicationPreflight.handlerBuilders.fill(actionCapabilities),
    hover: applicationPreflight.handlerBuilders.hover(actionCapabilities),
    press: applicationPreflight.handlerBuilders.press(actionCapabilities),
    scroll: applicationPreflight.handlerBuilders.scroll(actionCapabilities),
    select: applicationPreflight.handlerBuilders.select(actionCapabilities),
    clickxy: applicationPreflight.handlerBuilders.clickxy(actionCapabilities),
    'dismiss-modal': dismissModalBuilder(actionCapabilities),
    drag: applicationPreflight.handlerBuilders.drag(actionCapabilities),
    jsclick: applicationPreflight.handlerBuilders.jsclick(actionCapabilities),
    type: applicationPreflight.handlerBuilders.type(actionCapabilities),
    'verify-click': verifyClickBuilder(actionCapabilities),
    back: applicationPreflight.handlerBuilders.back(actionCapabilities),
    forward: applicationPreflight.handlerBuilders.forward(actionCapabilities),
    nav: applicationPreflight.handlerBuilders.nav(actionCapabilities),
    reload: applicationPreflight.handlerBuilders.reload(actionCapabilities),
    clock: applicationPreflight.handlerBuilders.clock(actionCapabilities),
    mock: applicationPreflight.handlerBuilders.mock(actionCapabilities),
    throttle: applicationPreflight.handlerBuilders.throttle(actionCapabilities),
    emulate: applicationPreflight.handlerBuilders.emulate(actionCapabilities),
    viewport: applicationPreflight.handlerBuilders.viewport(actionCapabilities),
    cookiedel: applicationPreflight.handlerBuilders.cookiedel(actionCapabilities),
    cookieset: applicationPreflight.handlerBuilders.cookieset(actionCapabilities),
    dialog: applicationPreflight.handlerBuilders.dialog(actionCapabilities),
    keepalive: applicationPreflight.handlerBuilders.keepalive(actionCapabilities),
    netlog: applicationPreflight.handlerBuilders.netlog(actionCapabilities),
    eval: applicationPreflight.handlerBuilders.eval(scriptCapabilities),
    eval64: applicationPreflight.handlerBuilders.eval64(scriptCapabilities),
    call: applicationPreflight.handlerBuilders.call(scriptCapabilities),
    console: applicationPreflight.handlerBuilders.console(readCapabilities),
    record: applicationPreflight.handlerBuilders.record(readCapabilities),
    batch: applicationPreflight.handlerBuilders.batch(workflowCapabilities),
    flow: applicationPreflight.handlerBuilders.flow(workflowCapabilities),
    repeat: applicationPreflight.handlerBuilders.repeat(workflowCapabilities),
    replay: applicationPreflight.handlerBuilders.replay(workflowCapabilities),
    inject: applicationPreflight.handlerBuilders.inject(actionCapabilities),
    restore: applicationPreflight.handlerBuilders.restore(actionCapabilities),
    upload: applicationPreflight.handlerBuilders.upload(actionCapabilities),
    shot: applicationPreflight.handlerBuilders.shot(readCapabilities),
    'diff-shot': diffShotBuilder(readCapabilities),
    elshot: applicationPreflight.handlerBuilders.elshot(readCapabilities),
    fullshot: applicationPreflight.handlerBuilders.fullshot(readCapabilities),
    scanshot: applicationPreflight.handlerBuilders.scanshot(readCapabilities),
    qa: applicationPreflight.handlerBuilders.qa(actionCapabilities),
    'responsive-audit': responsiveAuditBuilder(actionCapabilities),
    closetab: applicationPreflight.handlerBuilders.closetab(actionCapabilities),
    loadall: applicationPreflight.handlerBuilders.loadall(actionCapabilities),
  };
  Object.freeze(applicationHandlers);
  const applicationDispatcher = createCommandDispatcher({
    registry: applicationRegistry,
    owners: applicationPreflight.routeOwners,
    handlers: applicationHandlers,
    authorize: authorizeDaemonApplicationCommand,
  });

  // Handle a command
  async function readTargetUrl() {
    let timer;
    try {
      const { targetInfos } = await Promise.race([
        cdpDomains(cdp).Target.getTargets(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Target.getTargets timed out')), 2000); }),
      ]);
      return (targetInfos || []).find(info => info.targetId === targetId)?.url || '';
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async function readContentBoundary() {
    return { nonce: contentBoundaryNonce, origin: originLabel(await readTargetUrl()) };
  }

  async function throwIfDecisionDialogDismissed(cmd, commandArgs, sinceSeq) {
    if (jsDialogs.hasPending()) await jsDialogs.waitForPending(1500);
    const dismissed = dismissedDecisionDialogSince(dialogBuf, sinceSeq);
    if (!dismissed) return;
    throw nativeDialogDismissedError(dismissed, {
      action: cmd,
      target: {
        targetId,
        input: Array.isArray(commandArgs) ? (commandArgs[0] || '') : '',
        commandArgs: Array.isArray(commandArgs) ? commandArgs : [],
      },
    });
  }

  async function handleCommand({ cmd, args, policy, secrets = null }, execution = undefined, { outermost = false, guarded = false, dialogFlagTaken = false } = {}) {
  await environmentReady;
  if (!dialogFlagTaken) {
    const taken = takeAcceptDialogFlag(args);
    const previousAccept = commandAcceptDialog;
    commandAcceptDialog = previousAccept || taken.acceptDialog;
    try {
      return await handleCommand(
        { cmd, args: taken.args, policy, secrets },
        execution,
        { outermost, guarded, dialogFlagTaken: true },
      );
    } finally {
      commandAcceptDialog = previousAccept;
    }
  }
  if (daemonCommandResetsIdle(cmd)) resetIdle();
  if (daemonRequestStorage.getStore() === undefined) {
    const policyState = createRequestPolicyState(policy);
    return runDaemonRequestScope({ cmd, secrets, execution, session }, () => daemonPolicyStorage.run(
      policyState,
      () => handleCommand({ cmd, args }, execution, { outermost: true, dialogFlagTaken: true }),
    ));
  }
    // #466: with a session policy, every command and step runs inside its checks.
    const policyState = daemonPolicyStorage.getStore() || null;
    if (policyState && !guarded) {
      return guardDaemonCommand({
        state: policyState,
        cmd,
        args,
        execute: () => handleCommand({ cmd, args }, execution, { guarded: true, dialogFlagTaken: true }),
        navigationLog: mainFrameNavigationLog,
        compositeSteps: policyCompositeSteps,
        readContentBoundary: outermost ? readContentBoundary : null,
        readCurrentUrl: outermost ? readTargetUrl : null,
        actionMark: () => currentSessionActionSequence(session),
        onViolation: ({ sinceAction, error }) => markSessionActionsPolicyFailed(session, sinceAction, error),
      });
    }
    const dialogSince = typeof dialogBuf?.latest === 'function' ? dialogBuf.latest() : 0;
    try {
      enforceDaemonTableCollectionGate({ cmd, args }, execution);
      let result;
      const applicationRoute = applicationDispatcher.route(cmd);
      if (applicationRoute?.owner === 'application') {
        const route = await executeDaemonApplicationRoute({
          cmd,
          args,
          targetBound: Boolean(targetId),
        }, applicationDispatcher, cmd === 'table' && execution?.deadline ? execution : undefined);
        if (route.ok === false) {
          return { ok: false, result: route.result, error: route.error };
        }
        await throwIfDecisionDialogDismissed(cmd, args, dialogSince);
        return { ok: true, result: route.result ?? '' };
      }
      switch (cmd) {
        case 'meta': {
          // `meta` does not reset the idle timer, so it reports the time left (#440).
          result = formatJson({ ...daemonMetadata, idleRemainingMs: idleTimer.remainingMs() });
          break;
        }
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages, _browserInfo);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case '_activate': { // FOREGROUND_ACTIVATE_COMMAND (#488)
          result = JSON.stringify(await revealHiddenTab(cdp, sessionId, targetId, { state: revealState }));
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      await throwIfDecisionDialogDismissed(cmd, args, dialogSince);
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return daemonCommandCatchResult(e, {
        cdp,
        sessionId,
        cmd,
        args,
        targetId,
        session,
        dialogBuf,
        dialogSince,
        jsDialogs,
      });
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  // A request line is UTF-8, decoded only once complete, and capped at
  // MAX_DAEMON_REQUEST_LINE_BYTES (16 MiB); see createDaemonRequestConnection.
  server = net.createServer((conn) => {
    let requestConnection;
    requestConnection = createDaemonRequestConnection(conn, {
      handleRequest: idleTrackedDaemonRequestHandler(idleTimer, handleCommand, { onSettled: runtimePrune.requestSettled }),
      cleanup: (_request, execution) => tableArtifactStore.rollbackRequest(execution),
      onFlushed: (_request, execution) => tableArtifactStore.releaseRequest(execution),
      onDispose: () => {
        if (requestConnection.activeRequestCount() === 0 && conn.destroyed) {
          requestConnections.delete(requestConnection);
        }
      },
      onDisconnect: () => requestConnections.delete(requestConnection),
      onFatal: () => shutdown(1),
      onStop: shutdown,
    });
    requestConnections.add(requestConnection);
  });

  const tooLong = daemonEndpointTooLongError(sp);
  if (tooLong) {
    process.stderr.write(`Daemon server listen failed: ${tooLong.message}\n`);
    shutdown(1);
    return;
  }
  ensureRuntimeDir();
  const serving = await endpointLifecycle.serve({
    listen: endpoint => listenDaemonServer(server, endpoint),
    record: { pid: daemonMetadata.pid, startedAt: daemonMetadata.startedAt },
    // Only the daemon that owns the endpoint starts the tab's session log (the loser would truncate it).
    onServing: () => {
      runtimePrune.arm();
      session.daemonReady = true;
      const started = initializeSessionLog(session);
      const restarted = started?.restarted === true
        || session.observationRestore?.status === 'unreadable'
        || (session.observationRestore?.netlogCount || 0) > 0
        || (session.observationRestore?.actionCount || 0) > 0
        || session.observationLoaded === true;
      environmentReady = (async () => {
        try {
          session.environmentRestore = withObservationNotice(
            await applySavedNetworkControls(cdp, sessionId, session, savedEnvironment),
            session,
          );
        } catch {
          // Dialog mode was already taken from the file. Leave throttle and mocks off and say so.
          session.environmentRestore = withObservationNotice({
            ...environmentRestoreOutcome(savedEnvironment),
            throttleReset: savedEnvironment?.status === 'ok' ? Boolean(savedEnvironment.throttle) : true,
            mocksReset: savedEnvironment?.status === 'ok' ? Boolean(savedEnvironment.mocks?.length) : true,
          }, session);
          session.networkThrottle = null;
          session.networkMocks = [];
        }
        armDaemonRestartNotice(session, session.environmentRestore, { restarted });
      })();
      exitLog.current.markOwned();
    },
  });
  if (!serving) return;
  server.on('error', (e) => {
    process.stderr.write(`Daemon server failed: ${e.message}\n`);
    shutdown(1);
  });
}
export function listenDaemonServer(server, endpoint) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = error => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
}
// A daemon spawned while another already serves the tab (a parallel client spawned it first)
// exits before it attaches (#458). `serve` settles the races this check misses.
export async function daemonAlreadyServes(endpoint, { platform = process.platform, probe = path => probeDaemonEndpoint(path) } = {}) {
  return platform !== 'win32' && await probe(endpoint) === 'answers';
}
// A daemon's ownership of its endpoint (#458), shared by runDaemon and its tests. `serve`
// claims the socket path; only a winner records the socket's dev/ino, writes the record
// `stop` uses, runs `onServing` and watches the path. A loser shuts down and leaves the
// socket, the record and the session log to the daemon that holds the path: exit 0 when that
// daemon answers (what the spawning client wanted), 1 when the holder could not be probed.
// `shutdown` closes the server (libuv then unlinks the path) only while the path still holds
// this daemon's socket, and removes the record only while it names this daemon.
export function createDaemonEndpointLifecycle({
  targetId,
  socketPath,
  requestConnections,
  getServer,
  cleanupSession,
  closeCdp,
  exitProcess,
  platform = process.platform,
  probe = path => probeDaemonEndpoint(path),
  unlink = unlinkSync,
  stat = statSync,
  lstat = lstatSync,
  runtimeDir = RUNTIME_DIR,
  pid = process.pid,
  watch = watchDaemonSocket,
  log = message => process.stderr.write(message),
  beforeExit = () => {},
}) {
  let identity = null;
  const shutdown = createDaemonShutdown({
    requestConnections,
    getServer,
    socketPath,
    cleanupSession,
    closeCdp,
    exitProcess,
    getSocketIdentity: () => identity,
    statSocket: stat,
    removeRecord: () => removeOwnDaemonRecord(targetId, { pid, runtimeDir }),
    isWindows: platform === 'win32',
    beforeExit,
  });
  async function serve({ listen, record, onServing = () => {} }) {
    let claim;
    try {
      claim = await claimDaemonEndpoint(socketPath, { platform, listen, probe, unlink, stat, lstat });
    } catch (error) {
      log(`Daemon server listen failed: ${error.message}\n`);
      shutdown(1);
      return false;
    }
    if (!claim.claimed) {
      log(claim.holder === 'answers'
        ? `Daemon: another daemon already serves ${socketPath}; exiting\n`
        : `Daemon: ${socketPath} is in use and its holder did not answer; leaving it in place\n`);
      shutdown(claim.holder === 'answers' ? 0 : 1);
      return false;
    }
    identity = claim.identity;
    writeDaemonRecord(targetId, record, { runtimeDir });
    onServing();
    watch(socketPath, {
      identity,
      stat,
      onLost: () => {
        log(`Daemon: ${socketPath} no longer belongs to this daemon; exiting\n`);
        shutdown(0, { reason: 'socket-lost' });
      },
    });
    return true;
  }
  return Object.freeze({ shutdown, serve, socketIdentity: () => identity });
}
// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

export function connectToSocket(sp, { timeoutMs = 5000 } = {}) {
  return connectToDaemon(sp, { timeoutMs });
}
export async function getOrStartTabDaemon(targetId, opts = {}) {
  const platform = opts.platform || process.platform;
  const sp = daemonEndpointForPlatform(targetId, {
    platform,
    runtimeDir: opts.runtimeDir || RUNTIME_DIR,
  });
  // #444: a daemon could not listen on a truncated path; fail before spawning one.
  const tooLong = daemonEndpointTooLongError(sp, { platform });
  if (tooLong) throw tooLong;
  const connect = opts.connect || connectToSocket;
  const spawnProcess = opts.spawnProcess || spawn;
  const delay = opts.delay || sleep;
  const retries = opts.retries ?? DAEMON_CONNECT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DAEMON_CONNECT_DELAY;
  const execPath = opts.execPath || process.execPath;
  const scriptPath = opts.scriptPath || process.argv[1];
  // Try existing daemon
  let lastError = null;
  try { return await connect(sp); } catch (error) { lastError = error; }

  // No stale-socket cleanup here: a parallel client's daemon may have bound the path since
  // the connect above failed. The spawned daemon removes a stale socket only after a probe (#458).

  // Spawn daemon
  const child = spawnProcess(execPath, [scriptPath, '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
    env: withoutSecretEnv(opts.env || process.env),
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow when the tab is not yet live)
  for (let i = 0; i < retries; i++) {
    await delay(retryDelayMs);
    try { return await connect(sp); } catch (error) { lastError = error; }
  }
  throw new Error(formatDaemonStartFailure({
    lastError,
    liveTargetPresent: opts.liveTargetPresent === true,
    targetId,
  }));
}
export function sendCommand(conn, req, { targetId = null } = {}) {
  const sentAt = Date.now();
  return requestDaemon(conn, req, {
    runtimeDir: RUNTIME_DIR,
    mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),
    crashReport: targetId ? () => readDaemonCrashReport(targetId, { sinceMs: sentAt }) : null,
  });
}
export function daemonRequestMayHaveSideEffects(request = {}) {
  const command = COMMAND_SURFACE.resolve(request.cmd);
  if (command?.name === 'table') {
    if (command.kind !== 'conditional-mutation'
      || command.authorization !== 'conditional'
      || command.evidencePolicy !== 'none') return true;
    return isTableCollectArgs(request.args || []);
  }
  return Boolean(command && DAEMON_SIDE_EFFECT_AUTHORIZATIONS.has(command.authorization));
}
export async function assertFreshDaemonConnection(conn, { targetPrefix, expectedTargetId = null, currentMetadata }) {
  const response = await sendCommand(conn, { cmd: 'meta', args: [] });
  const daemonMetadata = response?.ok ? parseDaemonMetadataResult(response.result) : null;
  const assessment = assessDaemonFreshness({
    targetPrefix,
    expectedTargetId,
    current: currentMetadata,
    daemon: daemonMetadata,
  });
  if (assessment.stale) {
    const error = new Error(formatStaleDaemonMessage(assessment));
    error.assessment = assessment;
    throw error;
  }
  return assessment;
}
// The freshness check's `meta` does not reset the idle timer (#419), so a target daemon that
// passes it with seconds left could exit before the command that follows reaches it (#440).
// Such a daemon is let go: wait out its idle deadline, then check the daemon `reopen` gives
// (a new one, or the same one if other use reset its timer meanwhile). Waiting, not `stop`,
// so a concurrent command that just reset that daemon is never cut off. At most once, and
// only in the last DAEMON_IDLE_EXIT_MARGIN_MS of a 20 min idle period.
export async function assertFreshDaemonForCommand(conn, freshness, {
  reopen,
  assess = assertFreshDaemonConnection,
  wait = sleep,
  marginMs = DAEMON_IDLE_EXIT_MARGIN_MS,
} = {}) {
  const assessment = await assess(conn, freshness);
  if (!daemonIdleExitsSoon(assessment?.daemon, marginMs)) return assessment;
  await wait(Math.max(0, assessment.daemon.idleRemainingMs) + DAEMON_IDLE_EXIT_GRACE_MS);
  return assess(await reopen(), freshness);
}
// host:port of a CDP endpoint, normalized by URL so both sides compare equal.
export function normalizeCdpEndpoint(host, port) {
  try {
    const url = new URL(`ws://${host}:${port}/`);
    return url.port ? url.host : null;
  } catch {
    return null;
  }
}
export function cdpEndpointFromWsUrl(wsUrl) {
  try {
    const url = new URL(String(wsUrl));
    return normalizeCdpEndpoint(url.hostname, url.port);
  } catch {
    return null;
  }
}
export function requestedCdpEndpoint(env = process.env) {
  if (!env.CDP_PORT) return null;
  return normalizeCdpEndpoint(env.CDP_HOST || DEFAULT_CDP_HOST, env.CDP_PORT);
}
// Page list from a running daemon, but only one attached to the endpoint this call targets.
// Daemon sockets come from the shared pages cache and may belong to another browser, so a
// daemon must prove its endpoint through `meta` first. Without CDP_PORT the endpoint is not
// known before discovery, and an old daemon has no `cdpEndpoint`: both return null (fallback).
// `meta` and `list_raw` are discovery probes, often sent to another tab's daemon on the same
// endpoint (#419). They are not use of that tab, so they must not keep an idle daemon alive.
export function daemonCommandResetsIdle(cmd) {
  return cmd !== 'meta' && cmd !== 'list_raw';
}
export function daemonIdleExitsSoon(metadata, marginMs = DAEMON_IDLE_EXIT_MARGIN_MS) {
  const remaining = metadata?.idleRemainingMs;
  return typeof remaining === 'number' && Number.isFinite(remaining) && remaining < marginMs;
}
export async function listPagesFromMatchingDaemon({
  env = process.env,
  listSockets = listDaemonSockets,
  timeoutMs = DAEMON_PAGE_LIST_PROBE_TIMEOUT_MS,
  budgetMs = timeoutMs * 2,
  now = Date.now,
  connect = (socketPath, options) => connectToSocket(socketPath, options),
  request = (conn, req, options) => requestDaemon(conn, req, { runtimeDir: RUNTIME_DIR, mayHaveSideEffects: false, ...options }),
} = {}) {
  const wanted = requestedCdpEndpoint(env);
  if (!wanted) return null;
  // One hard budget for the whole probe loop, so many wedged daemons cannot stack up:
  // every step gets min(step timeout, budget left), and none starts once it is spent.
  const deadline = now() + budgetMs;
  const stepOptions = () => {
    const left = deadline - now();
    return left > 0 ? { timeoutMs: Math.min(timeoutMs, left) } : null;
  };
  const ask = async (socketPath, daemonRequest) => {
    const connectOptions = stepOptions();
    if (!connectOptions) return null;
    const conn = await connect(socketPath, connectOptions);
    const requestOptions = stepOptions();
    if (!requestOptions) {
      try { conn?.destroy?.(); } catch {}
      return null;
    }
    return request(conn, daemonRequest, requestOptions);
  };
  for (const { socketPath } of listSockets()) {
    if (!stepOptions()) return null;
    let metadata = null;
    try {
      const metaResponse = await ask(socketPath, { cmd: 'meta', args: [] });
      metadata = metaResponse?.ok ? parseDaemonMetadataResult(metaResponse.result) : null;
    } catch {}
    if (!metadata || metadata.cdpEndpoint !== wanted) continue;
    if (daemonIdleExitsSoon(metadata)) continue;
    // First usable endpoint match decides: at most one list_raw per discovery, then the fallback.
    try {
      const response = await ask(socketPath, { cmd: 'list_raw', args: [] });
      if (!response?.ok) return null;
      const pages = JSON.parse(response.result);
      return Array.isArray(pages) ? pages : null;
    } catch {
      return null;
    }
  }
  return null;
}
export async function discoverLivePagesForTargetResolution({
  env = process.env,
  pinCdpPort = false,
  listSockets = listDaemonSockets,
  connect,
  request,
  resolveWsUrl = getWsUrl,
  connectCdp,
  listPages = getPages,
  rememberEndpoint = rememberLiveCdpEndpointFromSession,
} = {}) {
  // #534: under CDP_ISOLATED_ONLY a running daemon may predate the variable; attach afresh through the gate.
  if (!pinCdpPort && !isolatedOnlyEnabled(env)) {
    const pages = await listPagesFromMatchingDaemon({
      env,
      listSockets,
      ...(connect ? { connect } : {}),
      ...(request ? { request } : {}),
    });
    // A daemon started before #546 can still return one id twice from list_raw.
    if (pages) return distinctTargets(pages);
  }
  const openCdp = connectCdp || (async (wsUrl) => {
    const cdp = new CDP();
    await cdp.connect(wsUrl);
    return cdp;
  });
  const cdp = await openCdp(await resolveWsUrl({ env }));
  try {
    try { await rememberEndpoint(cdp, { env }); } catch {}
    return await listPages(cdp);
  } finally {
    try { cdp.close(); } catch {}
  }
}
export async function readDaemonBinding(targetId) {
  const daemon = listDaemonSockets().find(entry => entry.targetId === targetId);
  if (!daemon) return null;
  try {
    const conn = await connectToSocket(daemon.socketPath);
    const response = await sendCommand(conn, { cmd: 'meta', args: [] });
    const metadata = response?.ok ? parseDaemonMetadataResult(response.result) : null;
    return metadata ? { targetId: daemon.targetId, ...metadata } : { targetId: daemon.targetId };
  } catch {
    return { targetId: daemon.targetId };
  }
}
// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

export function buildStopResult({
  requestedTarget = null,
  daemons = [],
  stoppedDaemons = [],
  goneDaemons = [],
  removedDaemons = [...stoppedDaemons, ...goneDaemons],
  failedDaemons = [],
  reasons = {},
} = {}) {
  const targetIds = daemons.map(daemon => daemon.targetId).filter(Boolean);
  const prefixLength = targetIds.length ? getDisplayPrefixLength(targetIds) : MIN_TARGET_PREFIX_LEN;
  const removedIds = new Set(removedDaemons.map(daemon => daemon.targetId));
  const prefixOf = daemon => daemon.targetId.slice(0, prefixLength);
  const stoppedTargets = stoppedDaemons.map(prefixOf);
  const goneTargets = goneDaemons.map(prefixOf);
  const failedTargets = failedDaemons.map(prefixOf);
  const remainingTargets = daemons
    .filter(daemon => !removedIds.has(daemon.targetId))
    .map(prefixOf);
  const statusOf = new Map([
    ...stoppedDaemons.map(daemon => [daemon.targetId, 'stopped']),
    ...goneDaemons.map(daemon => [daemon.targetId, 'gone']),
    ...failedDaemons.map(daemon => [daemon.targetId, 'failed']),
  ]);
  const results = daemons
    .filter(daemon => statusOf.has(daemon.targetId))
    .map(daemon => {
      const entry = { target: prefixOf(daemon), status: statusOf.get(daemon.targetId) };
      if (reasons[daemon.targetId]) entry.reason = reasons[daemon.targetId];
      return entry;
    });
  return {
    schema: 'chrome-cdp-ex.stop.v1',
    requestedTarget,
    stopped: stoppedTargets.length > 0,
    stoppedTargets,
    goneTargets,
    failedTargets,
    results,
    remainingSessions: remainingTargets.length,
    remainingTargets,
    noop: stoppedTargets.length === 0 && failedTargets.length === 0 && goneTargets.length === 0,
  };
}
export function formatStopResult(model, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(model);
  const results = model.results || [];
  const lines = [];
  // One line per daemon whenever the outcome is more than a plain stop.
  if (results.some(entry => entry.status !== 'stopped' || entry.reason)) {
    for (const entry of results) {
      if (entry.status === 'failed') lines.push(`${entry.target}: failed: ${entry.reason || 'unknown reason'}`);
      else if (entry.status === 'gone') lines.push(`${entry.target}: already gone${entry.reason ? ` (${entry.reason})` : ''}`);
      else lines.push(`${entry.target}: stopped${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }
  lines.push(formatStopSummary(model));
  return lines.join('\n');
}
export function formatStopSummary(model) {
  if (model.failedTargets?.length) {
    if (model.requestedTarget) {
      return `Failed to stop daemon ${model.failedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
    }
    const stopped = model.stoppedTargets?.length
      ? `Stopped ${model.stoppedTargets.length} daemon(s): ${model.stoppedTargets.join(', ')}; `
      : '';
    return `${stopped}Failed to stop daemon(s): ${model.failedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
  }
  if (!model.stopped) {
    if (model.goneTargets?.length) {
      return `Removed ${model.goneTargets.length} stale daemon entr${model.goneTargets.length === 1 ? 'y' : 'ies'} (already gone): ${model.goneTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
    }
    const scope = model.requestedTarget ? ` for ${model.requestedTarget}` : 's';
    return `No active daemon${scope}; ${model.remainingSessions} remaining session(s).`;
  }
  if (model.requestedTarget) {
    return `Stopped daemon ${model.stoppedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
  }
  return `Stopped ${model.stoppedTargets.length} daemon(s): ${model.stoppedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
}
// The same daemon wrote both records: same pid and same start time. A daemon started
// later for the same target writes a new start time, even if its pid was reused.
export function sameDaemonRecord(a, b) {
  return Boolean(a && b) && a.pid === b.pid && a.startedAt === b.startedAt;
}
export function isProcessAlive(pid, { kill = process.kill.bind(process) } = {}) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
// Guards against pid reuse: a recorded pid is only killed when its command line
// is this target's `cdp.mjs _daemon <targetId>`. Returns true (it is), false (it is
// not, or no such process) or null (could not be checked), and only true allows a kill.
export function processIsTargetDaemon(pid, targetId, { platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  try {
    const numericPid = Number(pid);
    const result = platform === 'win32'
      ? spawnSyncFn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${numericPid}").CommandLine`], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      : spawnSyncFn('ps', ['-o', 'args=', '-p', String(numericPid)], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.signal) return null;
    const commandLine = String(result.stdout || '').trim();
    if (result.status !== 0) return commandLine || String(result.stderr || '').trim() ? null : false;
    // A live pid with an unreadable (empty) command line cannot be told apart from access denied.
    if (!commandLine) return platform === 'win32' ? null : false;
    return commandLine.includes('_daemon') && commandLine.includes(String(targetId));
  } catch {
    return null;
  }
}
export async function stopDaemons(targetPrefix, deps = {}) {
  const platform = deps.platform || process.platform;
  const isWindows = platform === 'win32';
  const list = deps.list || listDaemonSockets;
  // Injecting `list` without `registry` is a fake run: never read the real runtime dir.
  const registry = deps.registry || (deps.list
    ? { list: () => [], read: () => null, remove: () => {} }
    : { list: listDaemonRecords, read: readDaemonRecord, remove: removeDaemonRecord });
  const connect = deps.connect || connectToSocket;
  // `stop` has side effects but must not wait the 120 s default on a wedged daemon.
  const send = deps.send || ((conn, request, options) => requestDaemon(conn, request, {
    runtimeDir: RUNTIME_DIR,
    mayHaveSideEffects: true,
    ...options,
  }));
  const unlink = deps.unlink || unlinkSync;
  const isAlive = deps.isAlive || (pid => isProcessAlive(pid));
  const isDaemonProcess = deps.isDaemonProcess || ((pid, targetId) => processIsTargetDaemon(pid, targetId, { platform }));
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal));
  const wait = deps.sleep || sleep;

  // On win32 `list` enumerates the pages cache, not daemons, and a daemon whose
  // page cache entry is gone is only reachable through its registry record.
  const daemons = [...(list() || [])];
  const known = new Set(daemons.map(daemon => daemon.targetId));
  for (const record of registry.list() || []) {
    if (known.has(record.targetId)) continue;
    known.add(record.targetId);
    daemons.push({
      targetId: record.targetId,
      socketPath: daemonEndpointForPlatform(record.targetId, { platform, runtimeDir: RUNTIME_DIR }),
    });
  }
  if (!daemons.length) return buildStopResult({ requestedTarget: targetPrefix || null });

  let selected = daemons;
  if (targetPrefix) {
    const matches = daemons.filter(daemon => daemon.targetId.toLowerCase().startsWith(String(targetPrefix).toLowerCase()));
    if (!matches.length) return buildStopResult({ requestedTarget: targetPrefix, daemons: await liveDaemons(daemons) });
    const targetId = resolvePrefix(targetPrefix, daemons.map(daemon => daemon.targetId), 'daemon');
    selected = [daemons.find(daemon => daemon.targetId === targetId)];
  }

  async function liveDaemons(candidates) {
    const live = [];
    for (const daemon of candidates) if (await hasLiveDaemon(daemon)) live.push(daemon);
    return live;
  }

  async function terminate(pid) {
    try { kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < STOP_KILL_POLLS && isAlive(pid); i++) await wait(STOP_KILL_POLL_MS);
    if (isAlive(pid) && !isWindows) {
      try { kill(pid, 'SIGKILL'); } catch {}
      for (let i = 0; i < STOP_KILL_POLLS && isAlive(pid); i++) await wait(STOP_KILL_POLL_MS);
    }
    return !isAlive(pid);
  }

  // Probe result: 'answers', 'absent' (ENOENT / ECONNREFUSED / ENOTSOCK prove no listener)
  // or 'unknown' (a timeout or EACCES could be a slow but live daemon).
  async function probeEndpoint(daemon) {
    try {
      const conn = await connect(daemon.socketPath, { timeoutMs: STOP_PROBE_TIMEOUT_MS });
      try { conn?.destroy?.(); } catch {}
      return 'answers';
    } catch (error) {
      return ENDPOINT_ABSENT_CODES.has(error?.code) ? 'absent' : 'unknown';
    }
  }

  async function endpointIsGone(daemon) {
    return (await probeEndpoint(daemon)) === 'absent';
  }

  // Remove what a dead daemon leaves behind, and only that (#439). `deadRecord` is the
  // record read before stop confirmed that daemon dead (null when it had none). A record
  // with another pid or start time, or one that appeared meanwhile, belongs to a daemon
  // started during the kill window and is left alone, and so is its socket. Off win32
  // the socket is removed only while the endpoint proves nothing listens on it.
  // Returns { error } when removal failed, { leftInPlace } when the endpoint was kept.
  async function removeLeftovers(daemon, deadRecord) {
    const current = registry.read(daemon.targetId);
    if (current && !sameDaemonRecord(current, deadRecord)) {
      return { leftInPlace: `daemon record now names pid ${current.pid}; it and its endpoint were left in place` };
    }
    if (current) registry.remove(daemon.targetId);
    if (isWindows) return {};
    if (!(await endpointIsGone(daemon))) {
      return { leftInPlace: 'endpoint still does not refuse connections, so the socket was left in place' };
    }
    try {
      unlink(daemon.socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { error: `could not remove stale socket: ${error?.message || error}` };
    }
    return {};
  }

  // Remaining sessions are targets with a live daemon: a recorded pid that is alive, or an
  // endpoint that does not prove absence. On win32 `list` also yields page-cache entries
  // that never had a daemon, and a stale POSIX socket file has no daemon behind it (#439).
  async function hasLiveDaemon(daemon) {
    const record = registry.read(daemon.targetId);
    if (record?.pid && isAlive(record.pid)) return true;
    return (await probeEndpoint(daemon)) !== 'absent';
  }

  async function stopOne(daemon) {
    const record = registry.read(daemon.targetId);
    let connected = false;
    let error = null;
    try {
      const conn = await connect(daemon.socketPath);
      connected = true;
      const response = await send(conn, { cmd: 'stop', args: [] }, { timeoutMs: STOP_REQUEST_TIMEOUT_MS });
      if (response?.ok === false) return { status: 'failed', reason: response.error || 'daemon rejected stop' };
      return { status: 'stopped' };
    } catch (caught) {
      error = caught;
    }
    const reason = error?.message || String(error);

    // The graceful stop did not happen. A recorded daemon that is alive but
    // unreachable is killed, after proving the pid is still this daemon.
    const pid = record?.pid;
    const pidAlive = pid ? isAlive(pid) : false;
    let reused = false;
    if (pidAlive) {
      const verdict = isDaemonProcess(pid, daemon.targetId);
      if (verdict === true) {
        if (!(await terminate(pid))) return { status: 'failed', reason: `pid ${pid} is still running after kill (${reason})` };
        const leftover = await removeLeftovers(daemon, record);
        if (leftover.error) return { status: 'failed', reason: leftover.error };
        const kept = leftover.leftInPlace ? `; ${leftover.leftInPlace}` : '';
        return { status: 'stopped', reason: `unresponsive, killed pid ${pid}${kept}`, endpointKept: Boolean(leftover.leftInPlace) };
      }
      if (verdict == null) return { status: 'failed', reason: `pid ${pid} is alive but could not be verified as the daemon, so it was not killed (${reason})` };
      reused = true;
    }
    if (connected) {
      // A listener answered but the reply never arrived. If the daemon is gone now, the stop worked.
      const exited = pid && !reused ? !pidAlive : await endpointIsGone(daemon);
      if (exited) {
        const leftover = await removeLeftovers(daemon, record);
        if (leftover.error) return { status: 'failed', reason: leftover.error };
        const kept = leftover.leftInPlace ? ` (${leftover.leftInPlace})` : '';
        return { status: 'stopped', reason: `exited before replying${kept}`, endpointKept: Boolean(leftover.leftInPlace) };
      }
      return { status: 'failed', reason: `${reason}; no daemon pid record to kill` };
    }

    const missing = error?.code === 'ENOENT';
    if (missing && !record) return { status: 'none' };
    // Only these errors prove nothing is listening; a timeout or EACCES could be a wedged daemon.
    const proofOfAbsence = ENDPOINT_ABSENT_CODES.has(error?.code);
    if (!proofOfAbsence) {
      if (!record) return { status: 'failed', reason };
      // The recorded pid is dead (or reused), but something holds the endpoint and did not
      // answer in time: possibly a slow live daemon, so its socket is not stop's to remove (#439).
      if (sameDaemonRecord(registry.read(daemon.targetId), record)) registry.remove(daemon.targetId);
      return { status: 'failed', reason: `${reason}; the recorded daemon (pid ${pid}) is gone, but the endpoint did not refuse the connection, so it was left in place` };
    }
    const leftover = await removeLeftovers(daemon, record);
    if (leftover.error) return { status: 'failed', reason: leftover.error };
    if (leftover.leftInPlace) return { status: 'failed', reason: `${reason}; ${leftover.leftInPlace}` };
    return { status: 'gone', reason: 'no daemon process or endpoint left; stale entry removed' };
  }

  const stoppedDaemons = [];
  const goneDaemons = [];
  const failedDaemons = [];
  const notDaemons = new Set();
  // Stopped, but its endpoint was kept because something may still live there (a daemon
  // started during the kill window, or a listener that only timed out): still a session.
  const keptEndpoints = new Set();
  const reasons = {};
  for (const daemon of selected) {
    const outcome = await stopOne(daemon);
    if (outcome.reason) reasons[daemon.targetId] = outcome.reason;
    if (outcome.endpointKept) keptEndpoints.add(daemon.targetId);
    if (outcome.status === 'stopped') stoppedDaemons.push(daemon);
    else if (outcome.status === 'gone') goneDaemons.push(daemon);
    else if (outcome.status === 'failed') failedDaemons.push(daemon);
    else notDaemons.add(daemon.targetId);
  }
  // A cached page that never had a daemon is not a session, so it is neither failed nor remaining.
  // Targets this call did not try to stop count only while a live daemon is behind them (#439).
  const handled = new Set(selected.map(daemon => daemon.targetId));
  const untouchedLive = new Set((await liveDaemons(daemons.filter(daemon => !handled.has(daemon.targetId))))
    .map(daemon => daemon.targetId));
  const sessions = daemons.filter(daemon => (handled.has(daemon.targetId)
    ? !notDaemons.has(daemon.targetId)
    : untouchedLive.has(daemon.targetId)));
  return buildStopResult({
    requestedTarget: targetPrefix || null,
    daemons: sessions,
    stoppedDaemons,
    goneDaemons,
    removedDaemons: [...stoppedDaemons, ...goneDaemons].filter(daemon => !keptEndpoints.has(daemon.targetId)),
    failedDaemons,
    reasons,
  });
}
export function createReportCommandHandler(session, { cdp = null, sessionId = null, pageInfo = pageInfoModel } = {}) {
  return async ({ args }) => {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    const ropts = parseReportArgs(fopts.args);
    if (ropts.args.length) throw new Error(`report: unknown argument ${ropts.args[0]}`);
    let page = null;
    if (cdp && sessionId) {
      try {
        page = await pageInfo(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(session.targetId) });
      } catch {}
    }
    return commandResult(formatSessionReport(session, {
      format: fopts.format,
      lastActions: ropts.lastActions,
      compact: ropts.compact,
      qa: ropts.qa,
      page,
    }), { kind: 'session-report' });
  };
}
export function createPerceiveCommandHandler({
  cdp,
  sessionId,
  targetId,
  session,
  consoleBuf,
  exceptionBuf,
  netReqBuf,
  refMap,
  lastPerceiveStore,
  refState,
  ops = {},
}) {
  const pageInfo = ops.pageInfoModel || pageInfoModel;
  const collectHealth = ops.collectPageHealth || collectPageHealth;
  const perceiveText = ops.perceiveText || perceiveStr;
  const buildPerceiveModel = ops.perceiveModel || perceiveModel;
  const buildPerceiveDiff = ops.perceiveDiffModel || perceiveDiffModel;
  return async ({ args }) => {
    const fopts = parseQaModeArgs(args, ['text', 'json']);
    const popts = resolveSinceActionPerceiveOpts(
      parsePerceiveArgs(fopts.args),
      session.lastAction,
      fopts.args,
    );
    await ensurePerceiveTargetReady({ cdp, sessionId, targetId, ops });
    const targetPrefix = targetPrefixForDisplay(targetId);
    popts.targetPrefix = targetPrefix;
    if (popts.sinceAction) popts.diffBaseline = popts.diffBaseline || session.lastAction?.baselineOutput || null;
    const page = await pageInfo(cdp, sessionId, { targetPrefix });
    if (isPdfViewerContentType(page.contentType)) {
      return commandResult(
        fopts.format === 'json'
          ? formatJson(pdfViewerHandoffModel(page, { targetPrefix, unsafeFull: popts.unsafeFull === true }))
          : formatPdfViewerOutput(page, { targetPrefix, unsafeFull: popts.unsafeFull === true }),
        null,
      );
    }
    let value;
    if (fopts.qa) {
      const consoleHealth = {
        errors: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'error').length,
        warnings: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
        exceptions: consoleDocumentEntries(exceptionBuf).length,
      };
      const pageHealth = await collectHealth(cdp, sessionId).catch(() => null);
      let text = '';
      try {
        text = await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
          ...popts,
          interactive: true,
          maxDepth: Math.min(popts.maxDepth || 8, 6),
        }, refState);
      } catch (error) {
        text = error.message || String(error);
      }
      const summary = buildQaSummaryModel({
        page: { title: page.title, url: page.url },
        pageHealth,
        console: consoleHealth,
        network: { failures: countNetworkFailures(netReqBuf) },
        targetPrefix,
        nextCommand: `cdp report ${targetPrefix}`,
        source: 'perceive',
      });
      value = fopts.format === 'json'
        ? formatJson({
            summary,
            perceptionPreview: truncateTextLines(text, fopts.maxDiffLines ?? 20),
          })
        : formatQaSummaryText(summary);
    } else if (popts.cards) {
      value = await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
        ...popts,
        format: fopts.format,
      }, refState);
      if (fopts.maxDiffLines != null && fopts.format !== 'json') {
        value = truncateTextLines(value, fopts.maxDiffLines);
      }
    } else {
      value = fopts.format === 'json' && (popts.sinceAction || popts.diff)
        ? formatJson(await buildPerceiveDiff(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
        : fopts.format === 'json'
        ? formatPerceptionJson(await buildPerceiveModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
        : await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
      if (fopts.maxDiffLines != null && fopts.format !== 'json') {
        value = truncateTextLines(value, fopts.maxDiffLines);
      }
    }
    return commandResult(value, null);
  };
}
// The --secret names a command will use, found with the same parsers the daemon runs, so only a
// `--secret` in flag position counts (a fill text such as "see --secret docs" is just text).
// Parse errors yield no names: the daemon reports them. Depth bounds batch/repeat nesting.
export function collectSecretNames(cmd, args = [], { readFile, cwd, depth = 0 } = {}) {
  if (depth > 4 || !SECRET_FILL_COMMANDS.has(cmd)) return [];
  const steps = command => collectSecretNames(command?.cmd, Array.isArray(command?.args) ? command.args.map(String) : [], { readFile, cwd, depth: depth + 1 });
  try {
    switch (cmd) {
      case 'fill': {
        const { secretName } = parseFillArgs(args);
        return secretName ? [secretName] : [];
      }
      case 'batch':
        return parseBatchArgs(args).commands.flatMap(steps);
      case 'flow':
        return parseFlowSteps(parseFormatArgs(args, ['text', 'json']).args.join(' '))
          .filter(step => step.kind === 'command')
          .flatMap(steps);
      case 'repeat':
        return steps(parseRepeatArgs(args));
      case 'record': {
        const opts = parseRecordArgs(args);
        if (opts.action !== 'fill') return [];
        const at = opts.actionArgs.indexOf('--secret');
        return at === -1 ? [] : [String(opts.actionArgs[at + 1] ?? '')];
      }
      case 'replay': {
        const { artifact } = parseReplayArgs(args, { reader: (path, encoding) => readFile(resolve(cwd, path), encoding) });
        return [...(artifact.environment || []), ...artifact.actions]
          .map(action => (Array.isArray(action?.command) ? action.command.map(String) : []))
          .flatMap(command => steps({ cmd: command[0], args: command.slice(1) }));
      }
      default:
        return [];
    }
  } catch (error) {
    // A malformed --secret NAME is reported here; other parse errors belong to the daemon.
    if (/--secret|secret name/.test(String(error?.message))) throw error;
    return [];
  }
}
// The --secret values a target command needs (#469), or null when it names none. Each name is
// resolved now, in this process, so an unset name fails before anything is typed.
export function cliRequestSecrets(cmd, args = [], {
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  fs = undefined,
  readFile = readFileSync,
} = {}) {
  if (cmd === 'type' && typeTextNamesSecret(argsWithoutFormat(args).join(' '))) throw new Error(TYPE_SECRET_UNSUPPORTED);
  const names = [...new Set(collectSecretNames(cmd, args, { readFile, cwd }))];
  if (!names.length) return null;
  for (const name of names) assertSecretName(name, cmd);
  const available = loadSecrets({ env, platform, cwd, ...(fs ? { fs } : {}) });
  const secrets = {};
  for (const name of names) {
    if (!available.has(name)) throw unknownSecretError(name, available.keys(), cmd);
    if (available.get(name) === '') throw new Error(`${cmd}: secret ${name} is empty`);
    secrets[name] = available.get(name);
  }
  return secrets;
}
