#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { actionFailureMessage, actionFailurePage, buildActionRecoveryPlan, buildNoChangeOutcomeRecommendation, classifyActionFailure, formatActionFailure, isClassifiedActionFailureText, isExpectedClipboardNoChange, isExpectedNoChange, isTimeoutError, looksLikeClipboardControl, overlaySelectorArg, recoveryCommandArg } from './lib/action-recovery.mjs';
import { detectBrowserPath } from './lib/browser-paths.mjs';
import { createLocatorPlan } from './lib/browser-resources.mjs';
import { createBrowserSupervisor } from './lib/browser-supervisor.mjs';
import { buildCardsModel, formatCardsJson, formatCardsText } from './lib/cards-model.mjs';
import { absolutizeExpectDownloadOut, captureClickDownload } from './lib/click-download.mjs';
import { commandResult } from './lib/command-application.mjs';
import { createCommandDispatcher } from './lib/command-dispatch.mjs';
import { COMMAND_SURFACE, SURVIVOR_COMMANDS } from './lib/command-surface.mjs';
import { createDaemonActionHandlers } from './lib/daemon-action-handlers.mjs';
import { createDaemonReadHandlers } from './lib/daemon-read-handlers.mjs';
import { daemonEndpointForPlatform, daemonEndpointTooLongError, ipcTimeoutForRequest } from './lib/daemon-transport.mjs';
import { createNetlogRequestStore, parseNetlogArgs } from './lib/netlog.mjs';
import { formatNextClosingLines } from './lib/next-line.mjs';
import { NODE22_MISSING_HINT, discoverNode22, formatNodeRerunCommand, nodeMajor, resolveChromeCdpNodeLaunch } from './lib/node-runtime.mjs';
import { classifyPageHealth, pageHealthScript } from './lib/page-health.mjs';
import { extractPdfPageText } from './lib/pdf-text.mjs';
import { createPerceptionModel, formatPerceptionJson } from './lib/perception-model.mjs';
import { assertSecretName, loadSecrets, unknownSecretError, withoutSecretEnv } from './lib/secrets.mjs';
import { createContentBoundaryNonce, createMainFrameNavigationLog, createRequestPolicyState, deniedCommandMessage, guardDaemonCommand, isContentBoundary, navigationBlockedMessage, originLabel, policyPreflightMessage, policyRecovery, policyRequestFields, readSessionPolicy, urlFlagValue, wrapContentBoundary } from './lib/session-policy.mjs';
import { createSourceMapResolver } from './lib/source-maps.mjs';
import { removeTabObservation, tabObservePath } from './lib/tab-observation.mjs';
import { createTableArtifactStore } from './lib/table-artifacts.mjs';
import { attachTargetResolutionDiagnostics, completeTargetResolution, distinctTargets, resolveLiveTargetBinding } from './lib/target-binding.mjs';
import { formatWebVitalsText } from './lib/web-vitals.mjs';
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import net from 'net';
import { homedir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { format as formatValue } from 'util';
import { actionDomDiffShowsChange, actionNavigationEvidence, actionObservationPerceiveOpts, actionResultPdfViewerMeta, actionSettleBaseline, actionSettleObserveOpts, applyActionObservationDelta, buildActionObservationDelta, buildActionOutcome, buildActionReceipt, buildLocatedActionObservationDelta, compactActionText, compactFillReceiptForJson, createActionDiagnosis, createActionObservationBaseline, createActionResult, describeFailedActionRequests, failedRequestNextCommand, formatActionNavigationDiff, formatActionResultOutput, formatActionText, formatFailedRequestLine, formatSummaryText, insertBeforeNextLine, isCardsPerceiveOutput, isDocumentScrollEdgeTarget, isFramedPerceiveOutput, isLeftoverDefaultAxScrollSettle, isLeftoverFeedCardsSettle, isNetworkFailure, isPdfViewerPerceiveOutput, isScrollActionTarget, leftoverCardsCount, locateObservedEntries, locatedCallerLines, locatedLoc, noBaselineActionDiff, noBaselineActionDiffText, parseVerifyClickArgs, pdfViewerPerceiveResult, pdfViewerSettleDiffText, perceiveStoreDiffSource, redactDisplayedPage, redactNavigationEntries, redactObservedEntry, redactSensitiveArtifactValue, rememberPerceiveDiffSource, shouldCaptureFirstActionBaseline, shouldCaptureTopLevelActionSettle, shouldRecaptureNavigatedBaseline, shouldSkipActionDomSettle, shouldTrackActionNetworkRequest, stripLeftoverAxScrollCensusChrome, stripLeftoverAxScrollNoChangeAxBodyChrome, stripLeftoverAxScrollNoChangeIdentityChrome, summarizeActionObservationEffects, tagScrollLeftoverSettle } from './lib/cdp-action-result.mjs';
import { ACCEPT_DIALOG_FLAG, ACTIONABILITY_WAIT_DEFAULT_MS, ACTIONABILITY_WAIT_MAX_MS, ACTION_TEXT_REDACT_WINDOW, ALLOW_STALE_DAEMON_FLAG, BATCH_BLOCKED, CATALOG_USAGE, CLICK_HREF_PROBE_TIMEOUT_MS, CLICK_MOUSE_ACK_TIMEOUT_MS, CLICK_NAVIGATION_WAIT_MS, CLICK_OPENER_RESPOND_TIMEOUT_MS, CLICK_OPENER_TERMINATE_TIMEOUT_MS, CLICK_POPUP_COMMIT_WAIT_MS, CLICK_POPUP_NAVIGATION_CAP_MS, CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS, CLICK_STUCK_OPENER_BUDGET_MS, CLI_HELP_LAYOUT, CLI_HELP_TEMPLATE, COMMANDS, CONTENT_REF_ROLES, DAEMON_ALLOW_DELAY, DAEMON_REQUEST_IDLE_PAUSE_MAX_MS, DEFAULT_CDP_HOST, DEFAULT_CDP_PROBE_PORT, DEFAULT_OPEN_ATTACH_TIMEOUT_MS, DEFAULT_OPEN_READY_TIMEOUT_MS, DEFAULT_SPAWN_READY_TIMEOUT_MS, DOCTOR_LIST_TARGET_PLACEHOLDER, DOCUMENT_SCROLLER_JS, DOCUMENT_SCROLL_EDGE_OUTCOME, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, EARLY_RESPONSE_STATUS_MAX, EARLY_RESPONSE_STATUS_MAX_AGE_MS, ENRICHED_ROLES, FAILED_REQUEST_BODY_TIMEOUT_MS, FIRE_AND_FORGET_KEEPALIVE, FLOW_SCRIPT_COMMANDS, FOLLOW_URL_FLAG, FOREGROUND_ACTIVATE_COMMAND, FULLSHOT_TIMEOUT_MS, HIDDEN_TAB_CAPTURE_TIMEOUT_MS, HIDDEN_TAB_RERUN_COMMANDS, HOVER_DELIVERY_WAIT_MS, HOVER_MOUSE_ACK_TIMEOUT_MS, HOVER_MUTATION_MARKER, HOVER_MUTATION_TIMEOUT_MS, HOVER_REVEAL_MARKER, IDLE_TIMEOUT, INTERACTIVE_ROLES, KEY_MAP, LOADALL_DEFAULT_INTERVAL_MS, LOADALL_DEFAULT_TIMEOUT_MS, LOADALL_MAX_TIMEOUT_MS, MAX_CAPTURED_CONSOLE_CHARS, MAX_DAEMON_REQUEST_LINE_BYTES, NAMED_IN_VIEWPORT_CLICK_OUTCOME, NAVIGATION_CANCEL_EVIDENCE_WAIT_MS, NEEDS_TARGET, OPEN_CREATED_TARGET_URL, PAGES_CACHE, PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP, PRESS_DELIVERY_WAIT_MS, PRESS_PROBE_MARKER, PRESS_SEARCH_SUBMIT_FLAG, PUNCT_KEY_MAP, QA_SCREENSHOT_TIMEOUT_MS, REF_RESOLVE_TIMEOUT, REF_SETTLE_BUDGET_MS, REPEAT_BLOCKED, REPLAY_BLOCKED, REVEAL_POLL_TIMEOUT_MS, RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS, RUNTIME_ARTIFACT_MAX_AGE_MS, RUNTIME_DIR, RUNTIME_PRUNE_FALLBACK_MS, SCREENSHOT_TIMEOUT, SEARCH_SUBMIT_PROBE_WAIT_MS, SECRET_FILL_COMMANDS, SESSION_LOG_ROTATE_BYTES, SHIFTED_PUNCT_KEY_MAP, SPAWN_DEBUG_BROWSER_FLAGS, SPAWN_DEBUG_BROWSER_VIA, STATUS_PAGE_INFO_TIMEOUT, TABLE_COLLECTION_DEADLINES, TAB_MODE_RECORDS_MAX, TIMEOUT, TYPEAHEAD_OMITTED_NOTICE, TYPE_SECRET_UNSUPPORTED, USAGE_LOG_MAX_BYTES, VERIFY_CLICK_REQUEST_WAIT_MS, VERIFY_CLICK_SETTLE_MS, cdpProfileKey, createSystemTempRootReader, daemonPolicyStorage, daemonRequestStorage, findListeningBrowserProcess, listeningSocketInodes, profileDirFromCommandLine, readProcessArgv, renderCardHelp, renderCliHelp, sleep } from './lib/cdp-base.mjs';
import { CDP, aliasEnv, aliasLookupKey, aliasesForTarget, answeredDevToolsActivePort, assessDaemonFreshness, bindAliasTargetFromPages, buildBroadcastModel, buildQaSummaryModel, buildTargetSelectModel, cdpCheckFromDiagnosis, cdpDiscoveryMiss, cdpErrorFromDiagnosis, cdpRecoveryFromDoctor, cdpUnreachableError, classifyBrowserProfile, collectDaemonMetadata, commandAcceptsFollowUrl, dailyProfileRefusedError, defaultCdpEnvironmentCheck, deleteTabGroup, devToolsActivePortCandidates, discoverOptionsForTargetAlias, emptyTabGroupStore, fetchFailureText, forgetTargetAlias, formatAliasRecord, formatBroadcastResult, formatCurrentAlias, formatDaemonStartFailure, formatJson, formatQaSummaryText, formatStaleDaemonMessage, formatTabGroup, formatTabGroupStore, formatTargetSelect, getDisplayPrefixLength, getTabGroup, inspectCdpProfileProcess, isBlankPageUrl, isBrowserDefaultUserDataDir, isElectronUserAgent, isLicenseBlobUrl, isolatedOnlyEnabled, listDaemonSockets, listKnownLiveTargetIds, livePageIdentity, looksLikeAliasToken, looksLikeHexTargetPrefix, macCommandLineArgv, matchPageTargets, normalizeTabGroupName, normalizeTabGroupStore, pageTargetScore, parseAliasCommandArgs, parseBroadcastArgs, parseCompactFormatArgs, parseDelayMs, parseFormatArgs, parseListArgs, parseQaModeArgs, parseTabGroupArgs, parseTargetSelectArgs, profileDirFromDevToolsActivePort, rankPageTargets, readBrowserArgvViaCdp, readBrowserProcessArgv, readCachedPages, readCdpUserAgent, readTabGroups, recordCommandUsage, rememberLiveCdpEndpointFromSession, rememberedCdpProbePort, removeTabGroupMember, removeTargetAlias, resolvePrefix, resolveScriptIdentityPath, resolveTabGroupMember, resolveTabGroupMembers, resolveTargetAlias, selectLivePagesForAliasResolution, selectPageTarget, splitCommandLine, takeFollowUrlFlag, takeUnsafeFullArg, truncateTextLines, unknownAliasError, upsertTabGroup, upsertTargetAlias, waitStr, withLiveLaunchFlags, writeTabGroups } from './lib/cdp-browser.mjs';
import { CliExitSignal, argsWithoutFormat, authorizeDaemonApplicationCommand, backgroundDaemonEnv, buildApplicationCommandSpecs, buildExactTargetSupervisorCandidates, buildOpenModel, cliErrorMessage, commandUsageTemplate, createApplicationCommandRegistry, createClickCommandHandler, createEvalrawCommandHandler, createOpenTarget, detectCliErrorFormat, editDistance, executeDaemonApplicationRoute, fillCliArgError, formatArgSuffix, formatCliErrorRecovery, formatOpenAttachWaitMessage, formatOpenNextPerceiveCommand, formatOpenReadyMessage, formatOpenTimeoutMessage, helpStr, helpTopicStr, isDeterministicTableContinuationResult, jsclickSelectorFromCliError, normalizeTargetCommandArgs, openNavigationScript, openReadyProbeScript, openTargetNavigationRequested, parseClickArgs, parseFillArgs, parseOpenArgs, parseTargetAndCommandArgs, sameStringArray, shouldAnnounceOpenAttachWait, snapshotApplicationDataObject, suggestCommands, targetCommandCliErrorFormat, targetPrefixForDisplay, typeTextNamesSecret, unknownCommandMessage, withKindOnLastNextLine } from './lib/cdp-cli.mjs';
import { RingBuffer, TableCollectionDeadlineError, applyDaemonRestartNotice, applySavedNetworkControls, applySavedTabEnvironment, armDaemonRestartNotice, boundedConsoleLineText, cdpDisplayContext, consoleEntryFromEvent, createDaemonIdleTimer, createDaemonNetworkObserver, createDaemonRequestConnection, createDaemonRequestExecutionContext, createDaemonShutdown, createEarlyResponseStatusStore, createTableCollectionRuntime, daemonBackgroundMode, daemonCrashReportPath, daemonRecordPath, displayConsoleLine, displayLocation, displayUrl, emptyAliasStore, enforceDaemonTableCollectionGate, ensureRuntimeDir, environmentRestoreOutcome, exceptionEntryFromEvent, explicitBackgroundChoice, formatCdpRelaunchCommand, formatDaemonRestartNotice, idleTrackedDaemonRequestHandler, inspectCdpOccupantProfileDirViaCdp, installDaemonCrashRecorder, isBackgroundMode, isDisposableSpawnProfileDir, isIsolatedChromeCdpExProfileDir, isTempCdpProfileDir, isolatedOccupantAttachError, lastCdpEndpointPath, listDaemonRecords, listTabModeRecords, normalizeAliasName, rankCdpRelaunchCandidates, readDaemonCrashReport, readDaemonRecord, readLastCdpEndpoint, readTabBackgroundMode, readTabEnvironment, readTabMode, readTargetAliases, recordDaemonCrash, rememberLastCdpEndpoint, rememberTabEnvironment, rememberTabObservation, removeDaemonRecord, removeOwnDaemonRecord, removeTabEnvironment, removeTabMode, replayableLaunchFlags, resolveOccupantProfileDir, restoreTabObservation, runTableCollectionLifecycle, savedDialogAccepts, shellQuoteCliArg, sliceAtCodePoint, sockPath, tabEnvPath, tabModePath, tokenizeCommandLine, validateDaemonProtocolRequest, withObservationNotice, writeDaemonRecord, writeLastCdpEndpoint, writeTabBackgroundMode, writeTabEnvironment, writeTargetAliases } from './lib/cdp-core.mjs';
import { assertFreshDaemonForCommand, attachDaemonTarget, buildStopResult, cdpEndpointFromWsUrl, connectToSocket, createDaemonEndpointLifecycle, daemonAlreadyServes, daemonCommandResetsIdle, daemonIdleExitsSoon, daemonRequestMayHaveSideEffects, enableDaemonDomains, foregroundActivationRequest, formatStopResult, getOrStartTabDaemon, isProcessAlive, listPagesFromMatchingDaemon, listenDaemonServer, loadSourceMapText, processIsTargetDaemon, readDaemonBinding, requestedCdpEndpoint, revealHiddenTab, sendCommand, stopDaemons } from './lib/cdp-daemon.mjs';
import { buildDoctorModel, buildSpawnDebugBrowserModel, buildSpawnDebugBrowserPlan, captureSpawnOutput, checkBrowserPermission, checkBrowserProfile, checkBrowserTargets, checkCdpReachability, checkDaemonSockets, checkFdLimit, checkRuntimeEnvironment, defaultIsProfileLocked, defaultProfileIgnoresRemoteDebugging, defaultQuitBrowser, defaultSpawnProbePorts, detectChromiumMajorVersion, detectRuntimeEnvironment, dialogVisibleFunctionSource, dismissModalScript, dismissModalStr, doctorCheckSeverity, doctorNextSteps, doctorProbeFromChecks, doctorProbeFromTargets, doctorStatusSummary, doctorWizardModel, doctorWizardSummary, fdLimitRecovery, formatDailyDefaultProfileCdpFailure, formatDoctorOutput, formatDoctorReport, formatExistingBrowserSessionHandoffError, formatOverlayReport, formatSpawnDebugBrowserOutput, formatSpawnDebugBrowserReadinessFailure, isDefaultBrowserProfileDir, isExistingBrowserSessionHandoff, isolatedSpawnProfileDir, listSpawnedDebugTargets, liveOtherProfilePort, minimizeWindowsForTargets, openDialogCountScript, overlayDetectorScript, overlayStr, parseSpawnDebugBrowserArgs, persistentDailyUserDataDir, pickSpawnedTarget, probeTcpPort, profileInUseSpawnError, readinessIsProfileHandoff, reconcileCdpWithLiveDaemons, reconcileRuntimeEnvironmentCheck, resolveOverlayTargetPoint, spawnOutputHandoffText, waitForSpawnedCdp } from './lib/cdp-doctor.mjs';
import { ambiguousEscapedSemicolonError, autoActionJsonArgs, buildFlowResultModel, cascadeStr, checkSkillSymlink, classifyCommandResultSemantics, closetabStr, commandCatalogName, commandMeta, createNavigationCancelWatch, decodeFlowEscapedSemicolon, decodeVLQ, dispatchGuardingCancelledNavigation, doctorCliPrefix, escapedSemicolonIsScriptBody, firstFlowToken, flowQuoteOpens, flowQuotedEscape, flowStepModel, flowWordAt, formatBatchResults, historyNavStr, injectStr, isBatchParallelUnsafeCommand, mapInlineSourceMap, mapLineToSource, mapStyleSource, maybeParseJson, navActionDispatch, navigationCancelledError, observeNavPage, observePageState, observeReloadPage, pageConditionDescription, parseBatchArgs, parseClosetabArgs, parseFlowLine, parsePageConditionArgs, parseRecordArgs, parseRepeatArgs, parseReplayArgs, parseReplayArtifact, probePageCondition, recordStr, reloadObservationBuffers, reloadStr, repeatStr, replayActionsStr, replayStepFromAction, runBatchCommands, scriptSegmentClosesQuote, settleFlow, stripVitePathQuery, unclosedFlowQuoteError } from './lib/cdp-flow.mjs';
import { absolutizeArtifactFileArgs, absolutizeElshotFileArg, absolutizeFullshotArgs, absolutizeResponsiveAuditArgs, absolutizeShotArgs, absolutizeUploadArgs, actionDisabledError, actionabilityFunctionSource, applyFillValueState, applyLateClickDownload, assertClickPointNotCovered, assertScreenshotOutputDirectory, batchCommandLookahead, buildFillValueState, callerPayloadIndexes, canonicalCallerCommand, clickEventProbeInstallAtPointScript, clickEventProbeInstallOnNodeDeclaration, clickEventProbeReadAtPointScript, clickEventProbeReadOnNodeDeclaration, clickFeedbackPolicy, clickProbeSawPageEvent, clickStr, clickXyStr, confirmClickFollowedHref, dispatchClick, dispatchClickMouseEvent, dispatchDrag, dispatchHoverMove, dispatchMouseEventAllowingAckTimeout, documentScrollEdgeExpression, documentScrollReachedEdge, documentScrollToJs, dragEventProbeInstallScript, dragEventProbeReadScript, dragStr, evalPageHref, fillFeedbackPolicy, fillLiveValueAccepted, fillLiveValuePageScript, fillReactStr, fillStr, fillValueRejectedError, fillableControlProbeDeclaration, findClickOpenedTab, forgetSessionTarget, formControlStateChanged, formatActionabilityWaitNote, formatDocumentScrollEdgeFailure, formatDocumentScrollEdgeText, formatDragEventCounts, formatFormControlStateDiff, formatHoverRevealClause, formatScrollByContainerText, formatSearchSubmitPressText, getDpr, handledLater, hoverFeedbackPolicy, hoverRevealStateExpression, hoverStr, isEnterKeyName, isHoverConfirmEvalCommand, isLikelyCssSelector, isNamedClickQuery, isNavigatingHref, isSearchSubmitPressCommand, jsClickStr, jsclickFeedbackPolicy, keyForPress, linkOpensNewBrowsingContext, markSensitiveFillTarget, namedClickActionTarget, namedClickQueryName, namedInViewportClickExpression, navigateSearchListingIssued, normalizeActionabilityWaitMs, normalizeScrollArgs, notFillableControlError, openerUnusableError, parseActionabilityWaitArgs, parseClickEventProbeOutput, parseClickOpenedTab, parseDragArgs, parseFormControlStateSnapshot, parseHoverRevealState, parsePressArgs, parseScrollContainerArg, parseScrollEdge, pinClickPointOnNodeDeclaration, pointerClickFunctionDeclaration, pointerClickStr, pressFeedbackPolicy, pressHelpLines, pressSearchSubmitPlan, pressStr, pressUsageError, probePageVisibility, probeSearchSubmit, rejoinRewrittenCommand, rememberSessionTarget, replaceCallerPayload, runWithBatchLookahead, sameArgList, scrollActionTarget, scrollByExpression, scrollEdgeExpression, scrollFeedbackPolicy, scrollStr, searchListingProbeFromQuery, searchSubmitProbeExpression, selectStr, shouldSnapshotFormControlState, snapshotFormControlState, splitScrollEdgeArgs, stuckOpenerBeforeClick, submitSearchListing, textSelectorName, typeStr, waitForSearchListingHref, waitForSearchSubmitProbe, waitForStr, writeScreenshotFile } from './lib/cdp-input.mjs';
import { assertNotPdfViewerPage, axNodeTokenState, buildEmulateFeatures, buildEmulateModel, buildPageListModel, callStr, captureHiddenTabFrame, cdpDomains, collectPageHealth, createScreenshotTierState, diffShotCompareScript, diffShotReceiptRegion, diffShotRegionsSource, emptyEmulateState, emulateStr, evalBase64Decode, evalFireAndForgetStr, evalStr, formatAxNode, formatCallResult, formatDiffShotRegionLines, formatDiffShotResult, formatEmulateText, formatEvalValue, formatPageList, formatPageListOutput, formatPdfViewerOutput, formatScreenshotCaptureDiagnostics, getPages, hiddenTabCaptureError, htmlStr, inspectScreenshotFrame, isHiddenTabCaptureError, isPdfViewerContentType, isPriorityPerceiveTextLine, isScreenshotCaptureFailure, loadPdfBytesForText, navStr, netStr, nextDiffShotArtifactPaths, normalizeEvalCliArgs, orderedAxChildren, parseConsoleArgs, parseDiffShotArgs, parseEmulateArgs, parseEvalArgs, parseNavigationDocumentProbe, parseShotArgs, pdfViewerError, pdfViewerHandoffModel, pdfViewerHandoffModelFromOutput, pdfViewerNextCommand, pdfViewerReportRecommendation, runtimeExceptionMessage, runtimeMetricsStr, screencastFallback, screenshotCaptureUsesSessionTier, screenshotFailureError, screenshotFallbackReason, shouldShowAxNode, snapshotStr, waitForCommittedDocumentReady, waitForScreenshotPaint, webVitalsModel, webVitalsModelOrUnavailable, wrapAwaitExpression } from './lib/cdp-page.mjs';
import { absolutizeNetlogOutArg, actionNetworkQuietOptions, appendPendingActionNetworkEntries, applyViewportOverride, assertReadableUploadFiles, assessViewportReadback, boundedTableObservationEmissionJson, boundedTableObservationEmissionText, buildClockModel, buildMockModel, buildTableCollectorBootstrapExpression, checkpointCookieToSetCookieParams, checkpointModel, checkpointPageScript, checkpointSessionEvent, checkpointStr, clearObservationBuffers, clockPageScript, clockStr, componentsStr, cookieDelStr, cookieDeleteParams, cookieSetStr, cookiesForRestore, cookiesStr, createJavaScriptDialogSession, dialogStr, dismissedDecisionDialogSince, errorYieldingToDismissedDialog, evalRawStr, filterNetlogEntries, formatClockSummary, formatClockText, formatDialogBlockedObserveText, formatMockText, formatNetworkMocksSummary, formatTextNoMatchError, formatThrottleSummary, formatThrottleText, frameworkDetectorScript, fullshotFitsViewport, handleMockRequestPaused, handleOpeningJavaScriptDialog, isRestorableCheckpointCookie, javascriptDialogHandleParams, loadAllStr, mockStr, nativeDialogDismissedError, nativeDialogShouldAccept, netlogRequestStr, netlogStr, observeAfterActionGuardingDialogs, parseCheckpointArgs, parseCheckpointArtifact, parseClockArgs, parseComponentsArgs, parseCookieArgs, parseLoadAllArgs, parseMockArgs, parseRestoreArgs, parseTextArgs, parseThrottleArgs, reactComponentsTreeScript, readNetlogResponseBody, redactExternalInputActionError, redactRestoreActionError, redactRestoreCommandArgs, rememberViewportReadback, restoreCheckpointStr, restoreStorageScript, sampleRootFrameTables, sanitizeCheckpointCookies, sanitizeCheckpointStorage, sanitizeComponentResult, sanitizeComponentValue, setDialogMode, shouldSkipActionPageEvaluate, stylesStr, tableCollectionStr, tableObservationStr, takeAcceptDialogFlag, textPageScript, textStr, throttleModel, throttleStr, uploadStr, viewportStr, vueComponentsTreeScript, waitForActionNetworkQuiet } from './lib/cdp-page-commands.mjs';
import { attachRefToVisibleControl, axIdentityByRefMap, axInteractiveBackendCount, baselineOutputForActionTarget, buildPerceiveDiffModel, buildPerceiveDiffRecommendation, buildPerceiveTree, chooseAdaptivePerceiveLast, clickableBoxHelpersSource, collectDomBackendNodeIds, collectDomInteractiveControls, compactVisibleControlsModel, controlsStr, countedInteractiveElements, createFrameExecutionContext, dedupeRepeatedLines, discardHoverIdleBaseline, elementScreenshotClip, elshotReceiptLabel, elshotRefLabel, extractVisibleControlLabels, filterAxNodesToBackendSubtree, filterPerceiveExcludedAxNodes, flattenFrameTree, formatElshotReceipt, formatFrameTreeText, formatPerceiveCoordsLine, formatPerceiveDiffOutput, formatRefRect, formatUnknownRefError, formatVisibleControlLine, formatVisibleControlsHeader, formatVisibleControlsText, frameRefFromActionTarget, frameViewportOffset, framesModel, framesStr, hoverRecaptureShowsChange, isPerceiveDecorativeTitleChrome, isRef, isSearchListingControl, isSearchListingHref, isSearchListingText, isSkipLinkAxNode, isSkipLinkName, isSynthesizableDomControl, isVisibleControlTimestampName, listDomInteractiveControls, mergeMissingDomInteractiveAxNodes, nativeVisibleControlTag, offsetCssRect, offsetCursorInteractiveItem, omitTypeaheadListboxNodes, parseControlsArgs, parseElshotArgs, parseFrameArgs, parseFrameOnlyRef, parseFrameRef, parsePerceiveArgs, parsePerceiveHeader, perceiveArgsIncludeSnapshotShape, perceiveCursorSurfaceLimit, perceiveInteractiveNoiseHint, perceivePageScript, perceiveSnapshotOpts, perceiveTextboxValueFromOutput, perceptionModelFromText, pickPrimaryScrollMetrics, qualifyFrameRefsInLines, rankPerceiveCursorItems, rankSearchListingFirst, refAnnotationsFromTreeLines, rememberFramePerceiveOutput, renderedInteractiveSource, resolveFrameRef, resolveRef, resolveRefNode, resolveSinceActionPerceiveOpts, scrollSettledRectFunctionDeclaration, searchListingSelector, shouldPreservePerceiveRefs, shouldSynthesizeMissingFrameInteractives, storeFrameScopedRefs, stripPerceiveIdentityChrome, stripPerceiveRectChrome, syntheticAxNodeFromDomControl, uniqueVisibleControlCapSwapSamples, validateUrl, visibleControlNameFromLine, visibleControlsCollectorSource, visibleControlsPageScript, waitForHoverDomChange, waitForSettle } from './lib/cdp-perceive.mjs';
import { appendSessionActionLog, appendSessionEnvironmentLog, appendSessionEventLog, appendSessionExitLog, appendSessionScreenshot, buildQaPageModel, buildRecordActionsModel, buildRecordEnvironmentModel, buildResponsiveAuditModel, buildSemanticInteractionModel, buildSessionReportModel, captureViewportSize, clickDownloadBrowser, countNetworkFailures, createDaemonExitLog, createDaemonFillCapability, createRuntimePruneScheduler, createSessionState, currentSessionActionSequence, diffShotScreenshotCaptureOptions, ensureSessionScreenshotDir, formatActionWorkflowCommandOutput, formatExportPlaywright, formatPlaywrightSpecFromRecordActions, formatQaPageReport, formatRecordActions, formatResponsiveAuditReport, formatSemanticInteractionResult, formatSessionReport, initializeSessionLog, isScreenshotTimeoutError, isSensitiveActionTarget, liveRuntimeArtifactTargetIds, markSessionActionsPolicyFailed, nextSessionScreenshotPath, pageContainsText, parseExportPlaywrightArgs, parseQaArgs, parseReportArgs, parseResponsiveAuditArgs, playwrightStepFromCommand, pruneDaemonRuntimeArtifacts, pruneRuntimeArtifacts, qaScreenshotCaptureOptions, rememberSessionSecret, resolveRequestSecret, responsiveAuditViewportScript, restoreAuditViewport, runActionWithFeedback, runDaemonRequestScope, scrubDaemonResponse, scrubSessionSecrets, sessionDownloadDir, sessionScreenshotDir } from './lib/cdp-session-report.mjs';


// #534: broadcast's per-member gate. For each endpoint (the alias's port, else the environment), the
// browser passes getWsUrl's CDP_ISOLATED_ONLY check once; a member must then be one of its tabs, so a
// daemon left attached to another (daily) browser is never reused.
function createIsolatedMemberGate({
  gatedWsUrl = getWsUrl,
  listPagesFor = async (wsUrl) => {
    const cdp = new CDP();
    await cdp.connect(wsUrl);
    try { return await getPages(cdp); } finally { cdp.close(); }
  },
  baseEnv = process.env,
} = {}) {
  const checked = new Map();
  const check = (alias) => {
    const env = aliasEnv(alias, baseEnv);
    const key = `${env.CDP_HOST || ''}|${env.CDP_PORT || ''}`;
    if (!checked.has(key)) {
      const pending = (async () => {
        const wsUrl = await gatedWsUrl({ env });
        const pages = await listPagesFor(wsUrl);
        return { endpoint: cdpEndpointFromWsUrl(wsUrl), ids: new Set((pages || []).map(page => page.targetId)) };
      })();
      // A failure is not remembered: a transient error must not fail every later member.
      pending.catch(() => checked.delete(key));
      checked.set(key, pending);
    }
    return checked.get(key);
  };
  const gate = async (alias, targetId) => {
    const result = await check(alias);
    if (!result.ids.has(targetId)) {
      throw new Error(`CDP_ISOLATED_ONLY=1: ${targetPrefixForDisplay(targetId)} is not a tab of the checked browser at ${result.endpoint}; broadcast does not reuse its daemon.`);
    }
  };
  // The environment endpoint, checked before any member: a refusal there stays a Kind: policy error.
  gate.prime = async () => { await check(null); };
  return gate;
}

// #546: a page list taken right after location.reload() can hold two matches for one tab for a
// moment. Discover again (up to 3 more times, 250 ms apart) before an ambiguous prefix fails.
async function resolvePageCommandTarget({
  targetPrefix,
  targetAlias = null,
  lastSeenPages = [],
  followUrl = false,
  discover = livePagesForTargetCommand,
  readBinding = readDaemonBinding,
  onPages = () => {},
  attempts = 4,
  delayMs = 250,
  wait = sleep,
} = {}) {
  const requestedTargetId = String(targetAlias?.targetId || targetPrefix).toUpperCase();
  for (let attempt = 1; ; attempt++) {
    const livePages = distinctTargets(await discover(targetAlias));
    onPages(livePages);
    const preliminaryIds = new Set(livePages
      .map(page => String(page.targetId || ''))
      .filter(id => id.toUpperCase().startsWith(requestedTargetId)));
    const preliminaryTargetId = preliminaryIds.size === 1 ? [...preliminaryIds][0] : null;
    const daemonBinding = preliminaryTargetId ? await readBinding(preliminaryTargetId) : null;
    try {
      const targetResolution = resolveLiveTargetBinding({
        requested: targetPrefix,
        livePages,
        daemonBinding,
        alias: targetAlias,
        lastSeenPages,
        followUrl,
      });
      return { livePages, targetResolution };
    } catch (error) {
      if (error?.code !== 'target_ambiguous' || attempt >= attempts) throw error;
      await wait(delayMs);
    }
  }
}

async function livePagesForTargetCommand(targetAlias, {
  discoverPages = discoverLivePagesForTargetResolution,
  env = process.env,
} = {}) {
  const discoveredPages = await discoverPages(discoverOptionsForTargetAlias(targetAlias, env));
  return selectLivePagesForAliasResolution({ alias: targetAlias, discoveredPages });
}

async function bindAndSaveTargetAlias(parsed, {
  store = readTargetAliases(),
  discoverPages = discoverLivePagesForTargetResolution,
  writeStore = writeTargetAliases,
  env = process.env,
} = {}) {
  const attachEnv = parsed.port ? {
    ...env,
    CDP_PORT: String(parsed.port),
    CDP_HOST: parsed.host || env.CDP_HOST || DEFAULT_CDP_HOST,
  } : null;
  let targetId = parsed.targetId;
  let boundUrl = '';
  let boundTitle = '';
  try {
    const pages = await discoverPages({
      env: attachEnv || env,
      pinCdpPort: Boolean(parsed.port),
    });
    const bound = bindAliasTargetFromPages(parsed, pages);
    targetId = bound.targetId;
    boundUrl = bound.url;
    boundTitle = bound.title;
  } catch (error) {
    if (parsed.port) throw error;
  }
  const next = upsertTargetAlias(store, {
    name: parsed.name,
    targetId,
    port: parsed.port,
    host: parsed.host,
    url: boundUrl,
    title: boundTitle,
  });
  writeStore(next);
  return next;
}

// Browser metadata from /json/version — set when connecting via CDP_PORT
let _browserInfo = null;

async function wsUrlFromCdpHttp({
  host,
  port,
  fetcher,
  remembered,
  rememberReachable,
  display,
  inspectProfileProcess,
}) {
  const unreachable = (cause) => {
    const err = cdpUnreachableError({ host, port, cause, lastEndpoint: remembered, display, inspectProfileProcess });
    err.probeCause = String(cause || 'unreachable');
    return err;
  };
  let res;
  try {
    res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw unreachable(fetchFailureText(e));
  }
  if (res.ok) {
    const info = await res.json();
    if (!info.webSocketDebuggerUrl) throw new Error(`CDP on port ${port}: /json/version has no webSocketDebuggerUrl`);
    _browserInfo = info;
    rememberReachable({ host, port });
    // Extract path only — don't trust the hostname in the response (may be "localhost"
    // while CDP_HOST points elsewhere, e.g. WSL2→Windows)
    const wsPath = new URL(info.webSocketDebuggerUrl).pathname;
    return `ws://${host}:${port}${wsPath}`;
  }
  // Chrome 136+ / SSH tunnel / websocket-only mode: HTTP discovery returns 404 but
  // direct WebSocket handshake to /devtools/browser still works. Do not fall back on
  // other HTTP failures — those usually mean a non-CDP service is bound to the port.
  if (res.status === 404) {
    rememberReachable({ host, port });
    return `ws://${host}:${port}/devtools/browser`;
  }
  throw unreachable(`HTTP ${res.status}`);
}

// #534: with CDP_ISOLATED_ONLY=1, read the attached browser's command line and refuse a daily or
// unidentified profile. Every fresh attach (daemon start, list, open, target discovery) comes here.
async function getWsUrl(options = {}) {
  const url = await discoverWsUrl(options);
  if (!isolatedOnlyEnabled(options.env || process.env)) return url;
  const { hostname: host, port } = new URL(url);
  // Chrome answers Browser.getBrowserCommandLine only with --enable-automation; otherwise ask the OS.
  const inspect = options.inspectBrowserArgv
    || (async endpoint => (await readBrowserArgvViaCdp({ wsUrl: url, connectWebSocket: options.connectWebSocket }))
      || readBrowserProcessArgv(endpoint));
  const readUserAgent = options.readUserAgent || (endpoint => readCdpUserAgent({ ...endpoint, fetcher: options.fetcher }));
  const profile = classifyBrowserProfile(await inspect({ host, port }), {
    electron: isElectronUserAgent(await readUserAgent({ host, port })),
  });
  if (profile.kind === 'daily' || profile.kind === 'unknown') throw dailyProfileRefusedError({ host, port, profile });
  return url;
}

async function discoverWsUrl({
  env = process.env,
  fetcher = fetch,
  lastEndpoint,
  readLastEndpoint = readLastCdpEndpoint,
  rememberEndpoint = rememberLastCdpEndpoint,
  inspectOccupantProfileDir,
  connectWebSocket,
  inspectProfileProcess,
  display = cdpDisplayContext(),
  environmentCheck = cdpCheck => defaultCdpEnvironmentCheck(env, cdpCheck),
} = {}) {
  const host = env.CDP_HOST || DEFAULT_CDP_HOST;
  const remembered = lastEndpoint !== undefined ? lastEndpoint : readLastEndpoint();
  const rememberReachable = (record) => {
    try { rememberEndpoint(withLiveLaunchFlags(record, { remembered, inspectProfileProcess })); } catch {}
  };
  const httpProbe = port => wsUrlFromCdpHttp({
    host,
    port,
    fetcher,
    remembered,
    rememberReachable,
    display,
    inspectProfileProcess,
  });

  // CDP_PORT: explicit port (e.g. Electron with --remote-debugging-port=9222)
  if (env.CDP_PORT) return httpProbe(env.CDP_PORT);

  // Why each probed port failed, for the one miss diagnosis below.
  const probed = {};
  // A live port is attach success unless it is a leftover isolated chrome-cdp-ex profile.
  const attachProbe = async (port) => {
    try {
      const url = await httpProbe(port);
      const profileDir = await resolveOccupantProfileDir({
        host,
        port,
        remembered,
        inspectOccupantProfileDir,
        connectWebSocket,
      });
      // With CDP_ISOLATED_ONLY an isolated occupant is exactly what the user asked for (#534).
      if (!isolatedOnlyEnabled(env) && isIsolatedChromeCdpExProfileDir(profileDir)) {
        throw isolatedOccupantAttachError({ host, port, profileDir });
      }
      return url;
    } catch (error) {
      if (error?.code === 'cdp_isolated_occupant' || error?.isolatedOccupant) throw error;
      probed[String(port)] = error?.probeCause || error?.message || 'unreachable';
      return null;
    }
  };

  // Probe spawn-default 9222 (and CDP_LAST_PORT) before DevToolsActivePort / FAIL.
  for (const candidate of defaultSpawnProbePorts(env)) {
    const url = await attachProbe(candidate);
    if (url) return url;
  }

  // DevToolsActivePort file discovery (Chrome, Edge, Brave, etc.)
  let deadFilePort = null;
  const portFile = devToolsActivePortCandidates({
    home: homedir(),
    localAppData: env.LOCALAPPDATA || process.env.LOCALAPPDATA || '',
    portFile: env.CDP_PORT_FILE || process.env.CDP_PORT_FILE,
  }).find(p => existsSync(p));
  if (portFile) {
    const lines = readFileSync(portFile, 'utf8').trim().split('\n');
    if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
    const live = await answeredDevToolsActivePort({
      host,
      port: lines[0],
      wsPath: lines[1],
      profileDir: profileDirFromDevToolsActivePort(portFile),
      fetcher,
      rememberReachable,
      connectWebSocket,
    });
    if (live.url) return live.url;
    deadFilePort = lines[0];
    probed[String(lines[0])] = live.miss;
  }

  // Chrome 136+ often does not write DevToolsActivePort. Probe the same HTTP
  // path as CDP_PORT=9224, including the 404 → /devtools/browser fallback.
  // Skip a port the file already missed: a 404 response is success for this
  // probe, and that would hide a live remembered endpoint (#558).
  if (!Object.hasOwn(probed, String(DEFAULT_CDP_PROBE_PORT))) {
    try {
      return await httpProbe(DEFAULT_CDP_PROBE_PORT);
    } catch (error) {
      probed[DEFAULT_CDP_PROBE_PORT] = error?.probeCause || error?.message || 'unreachable';
    }
  }

  // Last, the endpoint this tool last reached (#425): a live browser there is attach success.
  const rememberedPort = rememberedCdpProbePort(remembered, host, probed);
  if (rememberedPort) {
    const url = await attachProbe(rememberedPort);
    if (url) return url;
  }

  const diagnosis = cdpDiscoveryMiss({ host, remembered, probed, display, inspectProfileProcess, deadFilePort });
  const check = cdpCheckFromDiagnosis(diagnosis);
  // Not a relaunch: the Next is whatever doctor recommends for this same check.
  const needsDoctorRecovery = diagnosis.code === 'cdp_not_found' || diagnosis.profileInUse;
  const recovery = needsDoctorRecovery
    ? cdpRecoveryFromDoctor([diagnosis.profileInUse ? null : environmentCheck(check), check].filter(Boolean))
    : null;
  throw cdpErrorFromDiagnosis(diagnosis, { recovery });
}

// ---------------------------------------------------------------------------
// Screenshot with multi-tier fallback (handles Electron CDP limitations)
// ---------------------------------------------------------------------------
// Tier 1: Page.captureScreenshot (standard)
// Tier 2: Page.captureScreenshot with fromSurface:false (view-based capture)
// Tier 3: Page.startScreencast single-frame grab (different rendering pipeline)
//
// Every command starts at tier 1, the same call a raw CDP client makes (#452). A
// multi-capture command (scanshot) passes one `hooks.tierState` to all its captures so
// a tier that timed out is skipped for the rest of that command only. A tier
// remembered for the daemon's whole life let one transient timeout route every later
// capture to fromSurface:false, which Electron on Windows cannot serve (PrintWindow).
// `getScreenshotTier` reports the tier the last default capture reached.
let _lastScreenshotTier = 1;
function resetScreenshotTier() { _lastScreenshotTier = 1; }
function getScreenshotTier() { return _lastScreenshotTier; }
let _backgroundCaptureGuard = false;
function setBackgroundCaptureGuard(on) { _backgroundCaptureGuard = on === true; }

// Returns capture data plus bounded method/retry diagnostics.
// `params` is passed to Page.captureScreenshot (format, clip, etc.).
async function captureScreenshot(cdp, sid, params = { format: 'png' }, hooks = {}) {
  const inspectFrame = hooks.inspectFrame
    || (frame => inspectScreenshotFrame(cdp, sid, frame.data, { clip: params.clip || null }));
  if (_backgroundCaptureGuard && await probePageVisibility(cdp, sid) === 'hidden') {
    return captureHiddenTabFrame(cdp, sid, params, hooks, inspectFrame);
  }
  const waitForPaint = hooks.waitForPaint || (() => waitForScreenshotPaint(cdp, sid));
  const timeoutMs = Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0
    ? hooks.timeoutMs
    : SCREENSHOT_TIMEOUT;
  const skipSanityRetry = hooks.skipSanityRetry === true;
  const viewportCapture = screenshotCaptureUsesSessionTier(params);
  const tierState = viewportCapture && hooks.tierState ? hooks.tierState : null;
  const noteTier = tier => { if (viewportCapture && !tierState) _lastScreenshotTier = tier; };
  const attempts = [];
  // A timeout skips that tier for the rest of a multi-capture command; a capture
  // failure only moves this capture on to the next pipeline.
  const recordFailure = (tier, err) => {
    const timedOut = String(err?.message || '').startsWith('Timeout:');
    if (!timedOut && !isScreenshotCaptureFailure(err)) throw err;
    if (timedOut && hooks.failFastOnTimeout === true) throw err;
    attempts.push({ tier, timedOut, message: String(err?.message || err).slice(0, 200) });
    if (timedOut && tierState && tierState.tier <= tier) tierState.tier = tier + 1;
  };
  const startTier = tierState ? tierState.tier : 1;
  let captured;
  // Tier 1: standard captureScreenshot
  if (startTier <= 1) {
    try {
      const result = await cdpDomains(cdp).Page.captureScreenshot( params, sid, timeoutMs);
      captured = { data: result.data, fallback: false, method: 'captureScreenshot', tier: 1 };
    } catch (err) {
      recordFailure(1, err);
    }
  }

  // Tier 2: captureScreenshot with fromSurface:false (captures from view, not compositor)
  if (!captured && startTier <= 2) {
    try {
      const result = await cdpDomains(cdp).Page.captureScreenshot(
        { ...params, fromSurface: false }, sid, timeoutMs);
      captured = { data: result.data, fallback: true, method: 'captureScreenshot-fromSurface-false', tier: 2 };
    } catch (err) {
      recordFailure(2, err);
    }
  }

  // Tier 3: screencast single-frame grab. A screencast frame is always the whole
  // viewport, so a clipped capture (elshot, fullshot) never falls back to it.
  if (!captured) {
    if (params.clip != null) throw screenshotFailureError(attempts);
    if (startTier > 3) {
      attempts.push({ tier: 3, timedOut: true, message: 'skipped: timed out earlier in this command' });
      throw screenshotFailureError(attempts);
    }
    try {
      const data = await screencastFallback(cdp, sid, timeoutMs);
      captured = { data, fallback: true, method: 'screencast', tier: 3 };
    } catch (err) {
      const message = String(err?.message || err);
      const timedOut = /timeout|timed out/i.test(message);
      // A protocol failure (target closed, detached) is not a capture-pipeline verdict.
      if (!timedOut && !isScreenshotCaptureFailure(err)) throw err;
      attempts.push({ tier: 3, timedOut, message: message.slice(0, 200) });
      if (timedOut && tierState) tierState.tier = 4;
      noteTier(3);
      throw screenshotFailureError(attempts);
    }
  }
  noteTier(captured.tier);
  if (attempts.length) captured.attempts = attempts;

  const firstFrameSanity = await inspectFrame(captured);
  if (skipSanityRetry || !firstFrameSanity?.retry || captured.method !== 'captureScreenshot') {
    return { ...captured, retryCount: 0, sanity: firstFrameSanity };
  }

  await waitForPaint();
  let retry;
  try {
    retry = await cdpDomains(cdp).Page.captureScreenshot( { ...params, fromSurface: false }, sid, timeoutMs);
  } catch (error) {
    throw new Error(`Screenshot alternate capture failed: ${error?.message || String(error)}`);
  }
  const sanity = await inspectFrame({ data: retry.data, method: 'captureScreenshot-fromSurface-false' });
  if (sanity?.retry) {
    throw new Error(`Screenshot alternate capture still failed sanity check (${sanity.reason || 'contradictory-frame'}).`);
  }
  return {
    data: retry.data,
    fallback: true,
    method: 'captureScreenshot-fromSurface-false',
    retryCount: 1,
    sanity,
    firstFrameSanity,
  };
}

async function shotStr(cdp, sid, filePathOrOpts, targetId, maybeOpts) {
  let filePath = null;
  let opts = { quiet: false, verbose: false, onCapture: null, timeoutMs: null, skipSanityRetry: false, tierState: null };
  if (filePathOrOpts && typeof filePathOrOpts === 'object' && !Array.isArray(filePathOrOpts)) {
    filePath = filePathOrOpts.filePath || null;
    opts = {
      quiet: !!filePathOrOpts.quiet,
      verbose: !!filePathOrOpts.verbose,
      onCapture: filePathOrOpts.onCapture || null,
      timeoutMs: filePathOrOpts.timeoutMs,
      skipSanityRetry: filePathOrOpts.skipSanityRetry === true,
      tierState: filePathOrOpts.tierState || null,
    };
  } else {
    filePath = filePathOrOpts || null;
    if (maybeOpts && typeof maybeOpts === 'object') {
      opts = {
        quiet: !!maybeOpts.quiet,
        verbose: !!maybeOpts.verbose,
        onCapture: maybeOpts.onCapture || null,
        timeoutMs: maybeOpts.timeoutMs,
        skipSanityRetry: maybeOpts.skipSanityRetry === true,
        tierState: maybeOpts.tierState || null,
      };
    }
  }
  // Fail before capture: a missing directory is a caller-path mistake, not a browser failure (#577).
  if (filePath) assertScreenshotOutputDirectory(filePath, 'shot');
  const dpr = await getDpr(cdp, sid);
  const captureHooks = { skipSanityRetry: opts.skipSanityRetry, tierState: opts.tierState };
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) captureHooks.timeoutMs = opts.timeoutMs;
  const capture = await captureScreenshot(cdp, sid, { format: 'png' }, captureHooks);
  const { data } = capture;
  opts.onCapture?.(capture);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeScreenshotFile(out, data, 'shot');

  // Default output: saved path FIRST so scripts grabbing `head -1` get a clean
  // path. Verbose adds full coordinate-mapping tutorial. Quiet hides hints.
  const lines = [out];
  const diagnostics = formatScreenshotCaptureDiagnostics(capture);
  if (diagnostics) lines.push(diagnostics);
  if (opts.quiet) return lines.join('\n');
  // Default: short DPR hint after the path. (`shot ... --verbose` for the long form.)
  lines.push(`Screenshot saved. DPR=${dpr}${dpr !== 1 ? ` (CSS px = image px / ${dpr})` : ''}`);
  if (opts.verbose) {
    lines.push(`Coordinate mapping:`);
    lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
    lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
    }
  }
  return lines.join('\n');
}

async function diffShotStr(cdp, sid, session, opts = {}) {
  let shot;
  try {
    shot = await captureScreenshot(cdp, sid, { format: 'png' }, diffShotScreenshotCaptureOptions());
  } catch (error) {
    if (isScreenshotTimeoutError(error)) {
      throw new Error('diff-shot: screenshot capture timed out; comparison is untrusted');
    }
    throw error;
  }
  if (shot.fallback === true) {
    throw new Error(`diff-shot: screenshot capture ${screenshotFallbackReason(shot)}; comparison is untrusted`);
  }
  const targetId = session.targetId;
  const reset = opts.reset || !session.diffShot?.baselineData;
  const paths = nextDiffShotArtifactPaths(session);
  if (reset) {
    writeFileSync(paths.baselinePath, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    session.diffShot = {
      ...(session.diffShot || {}),
      baselineData: shot.data,
      baselinePath: paths.baselinePath,
    };
    appendSessionScreenshot(session, { kind: 'diff-shot-baseline', path: paths.baselinePath, note: opts.reset ? 'reset baseline' : 'baseline' });
    const model = {
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId,
      baselineCaptured: true,
      baselinePath: paths.baselinePath,
      currentPath: paths.baselinePath,
      diffPath: null,
      changedPixels: 0,
      totalPixels: 0,
      changedRatio: 0,
      thresholdRatio: opts.thresholdRatio || 0,
      exceedsThreshold: false,
      advancedBaseline: true,
      fallback: shot.fallback === true,
    };
    return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
  }

  writeFileSync(paths.currentPath, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  const compareRaw = await evalStr(cdp, sid, diffShotCompareScript(session.diffShot.baselineData, shot.data));
  const compare = JSON.parse(compareRaw);
  writeFileSync(paths.diffPath, Buffer.from(compare.diffPngBase64, 'base64'), { mode: 0o600 });
  appendSessionScreenshot(session, { kind: 'diff-shot-current', path: paths.currentPath, note: 'current capture' });
  appendSessionScreenshot(session, { kind: 'diff-shot-diff', path: paths.diffPath, note: 'pixel diff' });
  const priorBaselinePath = session.diffShot.baselinePath;
  const advancedBaseline = !opts.keepBaseline;
  if (advancedBaseline) {
    session.diffShot.baselineData = shot.data;
    session.diffShot.baselinePath = paths.currentPath;
  }
  const model = {
    schema: 'chrome-cdp-ex.diff-shot.v1',
    targetId,
    baselineCaptured: false,
    baselinePath: priorBaselinePath,
    currentPath: paths.currentPath,
    diffPath: paths.diffPath,
    width: compare.width,
    height: compare.height,
    baselineWidth: compare.baselineWidth,
    baselineHeight: compare.baselineHeight,
    currentWidth: compare.currentWidth,
    currentHeight: compare.currentHeight,
    changedPixels: compare.changedPixels,
    totalPixels: compare.totalPixels,
    changedRatio: compare.changedRatio,
    regions: (Array.isArray(compare.regions) ? compare.regions : []).map(diffShotReceiptRegion),
    regionCount: Number(compare.regionCount) || 0,
    thresholdRatio: opts.thresholdRatio || 0,
    exceedsThreshold: compare.changedRatio > Number(opts.thresholdRatio || 0),
    advancedBaseline,
    fallback: shot.fallback === true,
  };
  return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
}

function buildTargetStatusDiagnostic(err, { cmd = 'status', targetPrefix = '' } = {}) {
  const model = buildCliErrorModel(err, { cmd, targetPrefix });
  const state = model.recovery.kind === 'target-closed'
    ? 'closed'
    : model.recovery.kind === 'daemon-disconnect'
    ? 'daemon-disconnect'
    : 'error';
  return {
    state,
    error: model.error,
    recovery: model.recovery,
    nextSteps: model.nextSteps,
  };
}

async function pageInfoModel(cdp, sid, opts = {}) {
  let title = '', url = '', contentType = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })', false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    title = info.title;
    url = info.url;
    contentType = info.contentType || '';
  } catch (e) {
    return { title, url, contentType, diagnostic: buildTargetStatusDiagnostic(e, { targetPrefix: opts.targetPrefix }) };
  }
  return { title, url, contentType, diagnostic: null };
}

function clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq) {
  const cleared = {
    console: consoleDocumentEntries(consoleBuf).length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  consoleBuf.clear();
  exceptionBuf.clear();
  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();
  return {
    schema: 'chrome-cdp-ex.console-baseline.v1',
    mode: 'clear',
    cleared,
    message: 'Console baseline cleared (console and exception buffers)',
  };
}

function selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  if (mode === 'all') return { mode, entries: consoleDocumentEntries(consoleBuf), exceptions: consoleDocumentEntries(exceptionBuf) };
  if (mode === 'errors') {
    return {
      mode,
      entries: consoleDocumentEntries(consoleBuf).filter(e => e.level === 'error' || e.level === 'warning'),
      exceptions: consoleDocumentEntries(exceptionBuf),
    };
  }
  return {
    mode: 'new',
    entries: consoleDocumentSince(consoleBuf, lastReadSeq.console),
    exceptions: consoleDocumentSince(exceptionBuf, lastReadSeq.exception),
  };
}

function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag, located = null, { unsafeFull = false } = {}) {
  const { mode, entries, exceptions } = selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag);
  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode,
    entries: entries.map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    exceptions: exceptions.map(entry => redactObservedEntry(entry, located, { unsafeFull })),
  };
}

function buildStatusModel({ targetId, page, consoleBuf, exceptionBuf, navBuf, lastReadSeq, runtime = null, vitals = null, diagnostic = null, located = null, unsafeFull = false }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    target: {
      state: diagnostic?.state || 'connected',
      diagnostic,
    },
    page: redactDisplayedPage(page, { unsafeFull }),
    console: consoleDocumentSince(consoleBuf, lastReadSeq.console).map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    exceptions: consoleDocumentSince(exceptionBuf, lastReadSeq.exception).map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    navigation: redactNavigationEntries(navBuf.since(lastReadSeq.nav || 0), { unsafeFull }),
    runtime,
    vitals,
  };
}

async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq, opts = {}) {
  const { title, url, diagnostic } = await pageInfoModel(cdp, sid, { targetPrefix: opts.targetPrefix });

  const lines = [];
  const unsafeFull = opts.unsafeFull === true;
  lines.push(`URL: ${displayUrl(url, { unsafeFull })}`);
  lines.push(`Title: ${title}`);
  if (diagnostic) {
    lines.push(`Target state: ${diagnostic.state}`);
    lines.push(`Diagnostic: ${diagnostic.error.message}`);
    lines.push(...formatCliErrorRecovery(diagnostic.recovery));
    lines.push(`Next: ${diagnostic.recovery.run}`);
  }

  const navs = navBuf.all();
  if (navs.length > 0) {
    const last = navs[navs.length - 1];
    const ago = Math.round((Date.now() - last.ts) / 1000);
    lines.push(`Navigations: ${navs.length} (last ${ago}s ago)`);
  }

  // Collect the slow probes before reading the buffers (as the JSON path does), so console
  // entries and exceptions logged during the vitals window are printed in this call.
  let runtimeLine = null;
  if (opts.runtime) {
    try {
      runtimeLine = await runtimeMetricsStr(cdp, sid);
    } catch (e) {
      runtimeLine = `Runtime metrics (Performance.getMetrics): unavailable (${e.message})`;
    }
  }
  const vitalsText = opts.vitals ? formatWebVitalsText(await webVitalsModelOrUnavailable(cdp, sid)) : null;

  // Read the buffers and snapshot how far they were read in the same synchronous step.
  const newConsole = consoleDocumentSince(consoleBuf, lastReadSeq.console);
  const newExceptions = consoleDocumentSince(exceptionBuf, lastReadSeq.exception);
  // Entries logged while source maps load are not printed here, so they stay unread.
  const readThrough = { console: consoleBuf.latest(), exception: exceptionBuf.latest() };
  const located = await locateObservedEntries(opts.locate, newConsole.slice(-20), newExceptions.slice(-10));

  if (newConsole.length > 0) {
    lines.push(`Console (${newConsole.length} new):`);
    for (const e of newConsole.slice(-20)) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` (${locText})` : '';
      lines.push(`  [${e.level}] ${displayConsoleLine(e.text, e, 200, { unsafeFull })}${loc}`);
    }
    if (newConsole.length > 20) lines.push(`  ... and ${newConsole.length - 20} more (use 'console --all')`);
  } else {
    lines.push('Console: (no new entries)');
  }

  if (newExceptions.length > 0) {
    lines.push(`Exceptions (${newExceptions.length} new):`);
    for (const e of newExceptions.slice(-10)) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` at ${locText}` : '';
      lines.push(`  ${displayConsoleLine(e.msg, e, 200, { unsafeFull })}${loc}`);
    }
  }

  if (runtimeLine) lines.push(runtimeLine);
  if (vitalsText) lines.push(vitalsText);

  lastReadSeq.console = readThrough.console;
  lastReadSeq.exception = readThrough.exception;

  return lines.join('\n');
}

async function consoleStr(consoleBuf, exceptionBuf, lastReadSeq, flag, { locate = null, unsafeFull = false } = {}) {
  const { mode, entries, exceptions } = selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag);
  if (mode === 'new') {
    lastReadSeq.console = consoleBuf.latest();
    lastReadSeq.exception = exceptionBuf.latest();
  }

  const lines = [];
  if (entries.length === 0 && exceptions.length === 0) {
    return mode === 'all' ? 'Console buffer is empty' : 'No new console entries';
  }

  const located = await locateObservedEntries(locate, entries, exceptions);
  for (const e of entries) {
    const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
    const loc = locText ? ` (${locText})` : '';
    lines.push(`[${e.level}] ${displayConsoleLine(e.text, e, 300, { unsafeFull })}${loc}`);
    lines.push(...locatedCallerLines(located, e, { unsafeFull }));
  }
  if (exceptions.length > 0) {
    lines.push('--- Uncaught Exceptions ---');
    for (const e of exceptions) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` at ${locText}` : '';
      lines.push(`[exception] ${displayConsoleLine(e.msg, e, 300, { unsafeFull })}${loc}`);
      lines.push(...locatedCallerLines(located, e, { unsafeFull }));
    }
  }
  return lines.join('\n');
}

async function summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  const targetPrefix = extra.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const expr = `
    (function() {
      const counts = {};
      const renderedInteractive = ${renderedInteractiveSource()};
      const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      let visibleControls = 0;
      for (const el of interactive) {
        if (el.getAttribute('aria-hidden') === 'true' || !renderedInteractive(el)) continue;
        visibleControls += 1;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }
      const domNodes = document.querySelectorAll('*').length;
      let tableRows = 0;
      for (const table of document.querySelectorAll('table')) {
        const sourceRows = Number(table.getAttribute('data-source-rows') || table.dataset.sourceRows || 0);
        tableRows = Math.max(tableRows, table.querySelectorAll('tr').length, Number.isFinite(sourceRows) ? sourceRows : 0);
      }
      const hiddenTemplateNodes = document.querySelectorAll('template *, [data-hidden-template], [data-hidden-template] *, [hidden], [hidden] *, [aria-hidden="true"], [aria-hidden="true"] *').length;
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + (focused.className ? '.' + focused.className.toString().split(' ')[0] : '') + '>'
        : 'none';
      return {
        title: document.title,
        url: window.location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        counts,
        domNodes,
        tableRows,
        visibleControls,
        hiddenTemplateNodes,
        focused: focusDesc,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  const allConsole = consoleDocumentEntries(consoleBuf);
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = consoleDocumentEntries(exceptionBuf).length;

  return {
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: r.title, url: displayUrl(r.url, { unsafeFull: extra.unsafeFull === true }) },
    viewport: {
      size: r.viewport,
      scrollY: r.scrollY,
      scrollMax: r.scrollMax,
    },
    interactive: r.counts,
    counts: {
      domNodes: r.domNodes || 0,
      tableRows: r.tableRows || 0,
      visibleControls: r.visibleControls || 0,
      hiddenTemplateNodes: r.hiddenTemplateNodes || 0,
    },
    limits: {
      outputTokenBudget: 1200,
      hiddenTemplateNodesOmitted: r.hiddenTemplateNodes || 0,
      truncated: (r.domNodes || 0) > 1000 || (r.tableRows || 0) > 100 || (r.visibleControls || 0) > 50 || (r.hiddenTemplateNodes || 0) > 0,
    },
    focused: r.focused,
    console: { errors, warnings, exceptions },
  };
}

async function summaryStr(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  return formatSummaryText(await summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra));
}

// The capture writes to its own store and ref map. Assigning session refs here
// would let a leftover @ref from the previous daemon resolve against numbers
// the agent never saw, and clear the daemon-start stale-ref state.
async function captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId) {
  const store = { output: null, model: null, snapshotOpts: null, cards: null };
  const opts = actionObservationPerceiveOpts(targetId);
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, new Map(), store, opts, null);
  return {
    output: perceiveStoreDiffSource(store) ?? output,
    snapshotOpts: store.snapshotOpts || perceiveSnapshotOpts(opts),
  };
}

// One capture of the loaded document. If a main-frame navigation commits
// while that capture is in flight, the first tree can still be the previous
// document; take one more after the commit.
async function captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration) {
  const readGeneration = () => (typeof pageGeneration === 'function' ? pageGeneration() : pageGeneration);
  const before = readGeneration();
  let captured = await captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId);
  const after = readGeneration();
  if (before != null && after != null && before !== after) {
    captured = await captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId);
  }
  return captured;
}

// What an action's settle step diffs against: the leftover perceive in its own
// shape, a recaptured top-level tree when the leftover is a cards/frame view
// (#257/#279), a fresh capture when the daemon has not perceived yet (#504),
// or a fresh capture when that leftover tree belongs to a document the page
// has since navigated away from (#589).
async function resolveActionSettleBaseline({
  cdp, sid, consoleBuf, exceptionBuf, refMap, refState, lastPerceiveStore, targetId,
  action, actionTarget, feedbackPolicy = 'settle-diff', observe = null, pageGeneration = null,
}) {
  let baselineFromTarget = baselineOutputForActionTarget(refState, perceiveStoreDiffSource(lastPerceiveStore), actionTarget);
  let baselineSnapshotOpts = lastPerceiveStore.snapshotOpts || null;
  if (shouldCaptureFirstActionBaseline(lastPerceiveStore, actionTarget, feedbackPolicy, observe)) {
    let first;
    try {
      first = await captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration);
    } catch {
      // A failed snapshot must not fail the action: dispatch it without a
      // baseline, and let the receipt say the DOM change was not observed.
      return { output: null, opts: null, captureFailed: true };
    }
    baselineFromTarget = first.output;
    baselineSnapshotOpts = first.snapshotOpts;
  } else if (shouldRecaptureNavigatedBaseline(lastPerceiveStore, refState, actionTarget, feedbackPolicy, observe)) {
    let fresh;
    try {
      fresh = await captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration);
    } catch {
      // Keep the previous document's tree out of the comparison. The receipt
      // says the baseline is stale instead of reporting a failed click.
      return { output: null, opts: null, captureFailed: true, baselineStale: true };
    }
    baselineFromTarget = fresh.output;
    baselineSnapshotOpts = fresh.snapshotOpts;
  }
  let settleBaseline = actionSettleBaseline(
    baselineFromTarget,
    baselineSnapshotOpts,
    actionTarget,
  );
  if (isPdfViewerPerceiveOutput(baselineFromTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'pdf-viewer-no-change';
  }
  tagScrollLeftoverSettle(
    action,
    actionTarget,
    baselineFromTarget,
    baselineSnapshotOpts,
  );
  if (
    !settleBaseline.output
    && shouldCaptureTopLevelActionSettle(
      baselineSnapshotOpts,
      baselineFromTarget,
      actionTarget,
    )
  ) {
    const topLevelOpts = actionObservationPerceiveOpts(targetId, {
      ...(settleBaseline.opts || {}),
      frameRef: null,
    });
    const before = await perceiveStr(
      cdp,
      sid,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      topLevelOpts,
      refState,
    );
    settleBaseline = {
      output: perceiveStoreDiffSource(lastPerceiveStore) ?? before,
      opts: perceiveSnapshotOpts(topLevelOpts),
    };
  }
  return settleBaseline;
}

async function responsiveAuditStr(cdp, sid, session, targetId, consoleBuf, exceptionBuf, args = []) {
  const opts = parseResponsiveAuditArgs(args);
  const targetPrefix = targetPrefixForDisplay(targetId);
  const page = await pageInfoModel(cdp, sid, { targetPrefix });
  if (isPdfViewerContentType(page.contentType)) {
    throw pdfViewerError(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'error').length,
    warnings: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  const viewports = [];
  const errors = [];
  // One tier state for every viewport: a capture tier that timed out is not retried per size.
  const tierState = createScreenshotTierState();
  let viewportRestore = null;
  try {
    let screenshotTimedOut = false;
    for (const size of opts.viewports) {
      const entry = { viewport: size };
      try {
        if (screenshotTimedOut) {
          entry.error = 'skipped after previous screenshot timeout';
          errors.push(`${size}: ${entry.error}`);
          viewports.push(entry);
          continue;
        }
        await applyViewportOverride(cdp, sid, size);
        const metricsRaw = await evalStr(cdp, sid, responsiveAuditViewportScript({ maxControls: opts.maxControls }));
        // The page reports its layout viewport (a mobile size without <meta viewport> lays
        // out at 980px); keep the requested size as the entry's label (#452).
        const { viewport: layoutViewport, ...metrics } = JSON.parse(metricsRaw);
        Object.assign(entry, metrics);
        if (layoutViewport) entry.layoutViewport = layoutViewport;
        const shotDir = opts.outDir || session.screenshotDir || null;
        if (opts.outDir) {
          try { mkdirSync(opts.outDir, { recursive: true }); } catch {}
        } else {
          ensureSessionScreenshotDir(session);
        }
        const path = opts.outDir
          ? resolve(opts.outDir, `responsive-${size.replace(/[^0-9x]/gi, 'x')}-${Date.now()}.png`)
          : nextSessionScreenshotPath(session, `responsive-${size}`);
        let screenshotCapture = null;
        const shot = await shotStr(cdp, sid, path, targetId, { quiet: true, tierState, onCapture: capture => { screenshotCapture = capture; } });
        entry.screenshot = shot.split('\n')[0];
        if (screenshotCapture) {
          entry.screenshotCapture = {
            method: screenshotCapture.method,
            retryCount: screenshotCapture.retryCount || 0,
            sanity: screenshotCapture.sanity || null,
          };
        }
        appendSessionScreenshot(session, { kind: 'responsive-audit', path: entry.screenshot, note: size });
        if (!shotDir && !opts.outDir) {
          // default screenshots stay under session dir outside the repo
        }
      } catch (e) {
        entry.error = e.message || String(e);
        errors.push(`${size}: ${entry.error}`);
        // A hidden tab stays hidden for the next size too (#488).
        if (isScreenshotTimeoutError(e) || isHiddenTabCaptureError(e)) screenshotTimedOut = true;
      }
      viewports.push(entry);
    }
    // #533: restore before the receipt is built, so the receipt can say where the viewport ended up.
    viewportRestore = await restoreAuditViewport(cdp, sid, session, originalViewport);
    const model = buildResponsiveAuditModel({
      targetId,
      viewports,
      page: { title: page.title, url: page.url },
      console: consoleHealth,
      errors,
      viewportRestore,
    });
    if (screenshotTimedOut) {
      const timeoutError = errors.find(msg => isScreenshotTimeoutError({ message: msg })) || errors[0];
      throw new Error(timeoutError);
    }
    return opts.format === 'json' ? formatJson(model) : formatResponsiveAuditReport(model);
  } finally {
    if (!viewportRestore) await restoreAuditViewport(cdp, sid, session, originalViewport);
  }
}

async function qaPageStr({
  cdp,
  sid,
  session,
  targetId,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  actionFeedback,
}, args = []) {
  const qopts = parseQaArgs(args);
  const errors = [];
  const page = await pageInfoModel(cdp, sid, { targetPrefix: targetPrefixForDisplay(targetId) });
  if (isPdfViewerContentType(page.contentType)) {
    const targetPrefix = targetPrefixForDisplay(targetId);
    return qopts.format === 'json'
      ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
      : formatPdfViewerOutput(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'error').length,
    warnings: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  const screenshots = {};
  let screenshotTimedOut = false;
  try {
    for (const [kind, size] of [['desktop', qopts.desktop], ['mobile', qopts.mobile]]) {
      if (!size) continue;
      if (screenshotTimedOut) {
        errors.push(`${kind} screenshot: skipped after previous screenshot timeout`);
        continue;
      }
      try {
        await applyViewportOverride(cdp, sid, size);
        ensureSessionScreenshotDir(session);
        const path = nextSessionScreenshotPath(session, kind);
        const shot = await shotStr(cdp, sid, path, targetId, {
          quiet: true,
          ...qaScreenshotCaptureOptions(),
        });
        appendSessionScreenshot(session, { kind: `qa-${kind}`, path: shot.split('\n')[0], note: size });
        screenshots[kind] = { viewport: size, path: shot.split('\n')[0] };
      } catch (error) {
        errors.push(`${kind} screenshot: ${error.message}`);
        if (isScreenshotTimeoutError(error) || isHiddenTabCaptureError(error)) screenshotTimedOut = true;
      }
    }
    let perception = null;
    try {
      const text = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
        cursorInteractive: true,
        maxDepth: 4,
        targetPrefix: targetPrefixForDisplay(targetId),
      }, refState);
      perception = { captured: true, summary: text.split('\n').slice(0, 6).join('\n') };
    } catch (error) {
      perception = { captured: false, error: error.message };
      errors.push(`perceive: ${error.message}`);
    }
    let action = null;
    const assertions = [];
    if (qopts.click) {
      let captured = null;
      await actionFeedback(
        'click',
        () => clickStr(cdp, sid, qopts.click, refMap, refState),
        { input: qopts.click, resolvedBy: 'selector-or-ref', label: qopts.click || '', commandArgs: [qopts.click] },
        'settle-diff',
        null,
        'json',
        result => { captured = result; },
      );
      const textMatched = qopts.expectText
        ? await pageContainsText(cdp, sid, qopts.expectText).catch(() => false)
        : false;
      action = buildSemanticInteractionModel(captured || {}, {
        selector: qopts.click,
        expectRequest: qopts.expectRequest,
        expectStatus: qopts.expectStatus,
        expectText: qopts.expectText,
        noConsoleErrors: qopts.noConsoleErrors,
        evidence: 'concise',
      }, { textMatched });
    } else {
      if (qopts.expectText) {
        const textMatched = await pageContainsText(cdp, sid, qopts.expectText).catch(() => false);
        assertions.push({
          kind: 'text',
          expected: qopts.expectText,
          status: textMatched ? 'pass' : 'fail',
          message: textMatched ? `"${qopts.expectText}" matched` : `"${qopts.expectText}" not found`,
        });
      }
      if (qopts.expectRequest) {
        assertions.push({
          kind: 'request',
          expected: qopts.expectRequest,
          status: 'fail',
          message: '--expect-request requires --click so the command can collect action network evidence',
        });
      }
    }
    const pageHealth = await collectPageHealth(cdp, sid).catch(() => null);
    const model = buildQaPageModel({
      targetId,
      page: { title: page.title, url: page.url },
      pageHealth,
      console: consoleHealth,
      perception,
      screenshots,
      action,
      assertions,
      errors,
    });
    return formatActionWorkflowCommandOutput(model, {
      format: qopts.format,
      text: () => formatQaPageReport(model),
    });
  } finally {
    await restoreAuditViewport(cdp, sid, session, originalViewport);
  }
}

function invalidateSessionRefs(session, reason, options = {}) {
  session.refs.map.clear();
  if (session.refs.frameRefs instanceof Map) session.refs.frameRefs.clear();
  if (session.refs.frameLastOutputs instanceof Map) session.refs.frameLastOutputs.clear();
  session.refs.invalidatedAt = Date.now();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
  // #610: reload must not move this cut after the new document's load errors.
  if (reason === 'navigation' && options.cutDocument !== false) cutDocumentConsoleBuffers(session.buffers);
}

async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const {
    diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null,
    interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false,
    keepRefs = false, keepTypeahead = false, last = null, adaptive = false, sinceAction = false, diffBaseline = null,
    frameRef = null, cards = false, verbose = false,
  } = opts;
  if (lastPerceiveStore && typeof lastPerceiveStore === 'object') lastPerceiveStore.outputTruncated = false;
  const frameContext = frameRef ? await resolveFrameRef(cdp, sid, frameRef) : null;
  const frame = frameContext?.frame || null;
  const frameExecutionContextId = frame ? await createFrameExecutionContext(cdp, sid, frame.id) : null;
  if (frame && (scopeSelector || excludeSelector)) {
    throw new Error('perceive --frame does not yet support --selector/--exclude; run frame-scoped perceive first, then use the listed @fN:M refs.');
  }

  const pdfProbeContext = frameExecutionContextId != null
    ? { contextId: frameExecutionContextId }
    : { timeoutMs: STATUS_PAGE_INFO_TIMEOUT };
  // --cards and -s previously skipped the PDF gate and treated the empty
  // embedder as a normal HTML/cards page. Probe before AX / scoped DOM queries.
  if (cards || scopeSelector) {
    try {
      const probe = JSON.parse(await evalStr(
        cdp,
        sid,
        'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })',
        false,
        pdfProbeContext,
      ));
      if (isPdfViewerContentType(probe.contentType)) {
        const output = formatPdfViewerOutput(probe, { targetPrefix: opts.targetPrefix, unsafeFull: opts.unsafeFull === true });
        return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
      }
    } catch (error) {
      if (error?.code === 'pdf_viewer') throw error;
    }
  }

  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = !frame && (scopeSelector || excludeSelector);
  const docRootPromise = needsDocument ? cdpDomains(cdp).DOM.getDocument( {}, sid) : null;
  let scopeBackendNodeIds = null;
  const axPromise = frame
    ? cdpDomains(cdp).Accessibility.getFullAXTree( { frameId: frame.id }, sid)
    : scopeSelector
    ? (async () => {
        const { root } = await docRootPromise;
        const { nodeId } = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector: scopeSelector }, sid);
        if (!nodeId) throw new Error(`Scope selector not found: ${scopeSelector}`);
        const { node } = await cdpDomains(cdp).DOM.describeNode( { nodeId, depth: -1, pierce: true }, sid);
        scopeBackendNodeIds = collectDomBackendNodeIds(node);
        return cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
      })()
    : cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
  const [axResult, metaJson] = await Promise.all([
    axPromise,
    evalStr(cdp, sid, perceivePageScript(cursorInteractive), false, frameExecutionContextId != null ? { contextId: frameExecutionContextId } : {})
  ]);

  const meta = JSON.parse(metaJson);

  if (isPdfViewerContentType(meta.contentType)) {
    const output = formatPdfViewerOutput(meta, { targetPrefix: opts.targetPrefix, unsafeFull: opts.unsafeFull === true });
    return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
  }

  // Console health
  const allConsole = consoleDocumentEntries(consoleBuf);
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = consoleDocumentEntries(exceptionBuf).length;

  // Exclude filtering: remove AX subtrees rooted at excluded DOM nodes
  let axNodes = axResult.nodes;
  if (scopeBackendNodeIds) {
    axNodes = filterAxNodesToBackendSubtree(axNodes, scopeBackendNodeIds);
  }
  if (excludeSelector) {
    const { root } = await docRootPromise;
    const excludedBackendNodeIds = new Set();
    const describedNodesByBackendId = new Map();
    const exNodes = await cdpDomains(cdp).DOM.querySelectorAll( { nodeId: root.nodeId, selector: excludeSelector }, sid);
    if (exNodes.nodeIds) {
      const results = await Promise.allSettled(
        exNodes.nodeIds.map(nid => cdpDomains(cdp).DOM.describeNode( { nodeId: nid, depth: -1, pierce: true }, sid))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.node?.backendNodeId) {
          excludedBackendNodeIds.add(r.value.node.backendNodeId);
          describedNodesByBackendId.set(r.value.node.backendNodeId, r.value.node);
        }
      }
    }
    axNodes = filterPerceiveExcludedAxNodes(axNodes, excludedBackendNodeIds, describedNodesByBackendId);
  }

  const typeaheadFilter = omitTypeaheadListboxNodes(axNodes, {
    keepTypeahead,
    selector: scopeSelector,
    focusedDesc: meta.focused,
  });
  axNodes = typeaheadFilter.nodes;

  if (frame) {
    const listed = await listDomInteractiveControls(cdp, sid, {
      contextId: frameExecutionContextId,
    });
    if (shouldSynthesizeMissingFrameInteractives(frame, axNodes, listed)) {
      const extras = await collectDomInteractiveControls(cdp, sid, {
        contextId: frameExecutionContextId,
        listed,
      });
      if (extras.length) axNodes = mergeMissingDomInteractiveAxNodes(axNodes, extras);
    }
  }

  const activeRefMap = frame ? new Map() : refMap;
  if (cards) {
    const model = buildCardsModel(axNodes, meta, activeRefMap, {
      last,
      targetPrefix: opts.targetPrefix,
      previousCards: lastPerceiveStore.cards?.cards,
      previousScrollY: lastPerceiveStore.cards?.scrollY,
    });
    if (frame) {
      storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);
      for (const card of model.cards || []) {
        if (typeof card.ref === 'string' && /^@\d+$/.test(card.ref)) {
          card.ref = `${frame.ref}:${card.ref.slice(1)}`;
        }
      }
    }
    const output = opts.format === 'json' ? formatCardsJson(model) : formatCardsText(model);
    lastPerceiveStore.output = output;
    lastPerceiveStore.cards = model;
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    if (refState && typeof refState === 'object') {
      refState.lastPerceiveText = output;
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
    return output;
  }
  const builtTree = buildPerceiveTree(axNodes, meta, activeRefMap, {
    maxDepth,
    interactiveOnly,
    keepRefs,
    last,
    adaptive,
    cursorInteractive,
    // --since-action / --diff print added and removed lines only. Rebuilding
    // @1..@N would point a remembered @N at a different node (#642).
    preserveRefs: shouldPreservePerceiveRefs(opts),
    consoleErrors: errors + exceptions,
    targetPrefix: opts.targetPrefix || '<target>',
  });
  let treeLines = builtTree.treeLines;
  const { refNodeIds, hiddenTextLines } = builtTree;
  if (frame) storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  // Now also returns `position` (computed style) so fixed/sticky elements get
  // a clear annotation — agents previously saw negative document-relative Ys
  // and assumed elements were off-screen.
  const refRects = new Map(); // ref number → {x, y, w, h, position?}
  const frameOffset = frame
    ? await frameViewportOffset(cdp, sid, {
        ...frame,
        frameRef: frame.ref,
        frameId: frame.id,
        frames: frameContext.frames,
      })
    : { x: 0, y: 0 };
  if (frame && (frameOffset.x || frameOffset.y)) {
    if (Array.isArray(meta.cursorInteractives)) {
      meta.cursorInteractives = meta.cursorInteractives.map(item => offsetCursorInteractiveItem(item, frameOffset));
    }
    if (Array.isArray(meta.visibleControls)) {
      meta.visibleControls = meta.visibleControls.map(control => (
        control?.rect ? { ...control, rect: offsetCssRect(control.rect, frameOffset) } : control
      ));
    }
  }
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId: backendDOMNodeId }, sid);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            position: cs ? cs.position : '',
          };
        }`,
        returnByValue: true,
      }, sid);
      const rect = res.result.value || {};
      if (frame) {
        rect.x = (Number(rect.x) || 0) + frameOffset.x;
        rect.y = (Number(rect.y) || 0) + frameOffset.y;
      }
      return { ref, rect };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines (top-level viewport CSS pixels; same space as clickxy)
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  ${formatRefRect(rect)}`;
    }
  }
  if (frame) treeLines = qualifyFrameRefsInLines(treeLines, frame.ref);

  // === Cursor-interactive @c refs (capped AFTER body; last/adaptive apply here) ===
  const cursorLimit = perceiveCursorSurfaceLimit({
    last,
    adaptive,
    lineCount: treeLines.length,
    consoleErrors: errors + exceptions,
    interactiveCount: refNodeIds.length + (meta.cursorInteractives?.length || 0) + (meta.visibleControls?.length || 0),
    hasPriorityText: treeLines.some(ln => isPriorityPerceiveTextLine(ln)),
  });
  let cRefCounter = 0;
  let outputTruncated = false;
  if (cursorInteractive && meta.cursorInteractives?.length > 0) {
    const ranked = rankPerceiveCursorItems(meta.cursorInteractives, item => item.text || item.sel);
    const capped = ranked.slice(0, cursorLimit);
    if (ranked.length > capped.length) outputTruncated = true;
    treeLines.push('');
    treeLines.push(`[Cursor-interactive elements] (non-ARIA clickable)${ranked.length > capped.length ? ' (truncated)' : ''}`);
    for (const ci of capped) {
      cRefCounter++;
      refMap.set(`c${cRefCounter}`, ci);
      treeLines.push(`  [clickable] ${ci.text || ci.sel}  @c${cRefCounter}  (${ci.x},${ci.y} ${ci.w}×${ci.h})`);
    }
  }
  if (cursorInteractive && meta.visibleControls?.length > 0) {
    const refAnns = refAnnotationsFromTreeLines(treeLines);
    const axIdentities = axIdentityByRefMap(axNodes, activeRefMap);
    const ranked = rankPerceiveCursorItems(
      meta.visibleControls.map(control => attachRefToVisibleControl(control, refAnns, axIdentities)),
      item => item.label || item.ariaLabel || item.text || item.title,
    );
    const formatted = ranked.map(control => `  ${formatVisibleControlLine(control)}`);
    const listed = verbose ? formatted : dedupeRepeatedLines(formatted, treeLines);
    const capped = listed.slice(0, cursorLimit);
    const pageTruncated = Boolean(meta.visibleControlsTruncated);
    if (pageTruncated || listed.length > capped.length) outputTruncated = true;
    treeLines.push('');
    treeLines.push(formatVisibleControlsHeader({
      shown: capped.length,
      collected: listed.length,
      pageTruncated,
    }));
    for (const line of capped) treeLines.push(line);
  }
  if (lastPerceiveStore && typeof lastPerceiveStore === 'object') lastPerceiveStore.outputTruncated = outputTruncated;

  // === Assemble output ===
  const lines = [];
  const unsafeFull = opts.unsafeFull === true;
  lines.push(`Page: ${meta.title} — ${displayUrl(meta.url, { unsafeFull })}`);
  if (frame) {
    const label = frame.name || '(anonymous)';
    const url = displayUrl(frame.url || frame.unreachableUrl || '(no url)', { unsafeFull });
    lines.push(`Frame: ${frame.ref} ${label} ${frame.id} ${url}`);
  }

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${meta.focused}`);
  if (typeaheadFilter.omitted) lines.push(TYPEAHEAD_OMITTED_NOTICE);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);
  // Coordinate hint — top-level viewport CSS pixels match clickxy/Input events.
  // Fixed/sticky elements include a "fixed"/"sticky" tag so agents do not
  // misread negative scroll-relative Ys as off-screen.
  lines.push(formatPerceiveCoordsLine(verbose));

  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');

  const markPerceived = () => {
    lastPerceiveStore.output = output;
    rememberPerceiveDiffSource(lastPerceiveStore, output, hiddenTextLines);
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, perceiveStoreDiffSource(lastPerceiveStore));
    // Mark refs as freshly assigned (clears 'navigation'/'daemon-start' state).
    if (refState && typeof refState === 'object') {
      refState.lastPerceiveText = output;
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
  };

  if (sinceAction) {
    markPerceived();
    if (!diffBaseline) {
      return output + '\n\n(no action baseline available; run `perceive` before a mutating command, or use `perceive --diff` after a normal perceive.)';
    }
    return formatPerceiveDiffOutput(diffBaseline, perceiveStoreDiffSource(lastPerceiveStore), { mode: 'since-action' });
  }

  // Diff mode: compare with previous perceive output.
  if (diffMode && lastPerceiveStore.output) {
    const previousOutput = perceiveStoreDiffSource(lastPerceiveStore);
    markPerceived();
    return formatPerceiveDiffOutput(previousOutput, perceiveStoreDiffSource(lastPerceiveStore));
  }

  markPerceived();
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return output + `\n\n${perceiveInteractiveNoiseHint(refNodeIds.length)}`;
  }
  return output;
}

async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState);
  if (String(output || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
    return pdfViewerHandoffModelFromOutput(output, opts.targetPrefix || '<target>');
  }
  return perceptionModelFromText(output, refState || {}, opts.targetPrefix || '<target>', {
    ...opts,
    outputTruncated: lastPerceiveStore?.outputTruncated === true,
  });
}

async function perceiveDiffModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const mode = opts.sinceAction ? 'since-action' : 'diff';
  const baseline = opts.sinceAction ? opts.diffBaseline : perceiveStoreDiffSource(lastPerceiveStore);
  const printedOutput = await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    {
      ...opts,
      sinceAction: false,
      diff: false,
      diffBaseline: null,
      // The flags above are cleared so this call stores the full tree. They are
      // also what keeps a surviving @ref (#642); pass that decision through.
      preserveRefs: shouldPreservePerceiveRefs(opts),
    },
    refState
  );
  const currentOutput = perceiveStoreDiffSource(lastPerceiveStore) ?? printedOutput;
  if (!baseline) {
    const header = parsePerceiveHeader(currentOutput);
    const target = opts.targetPrefix || '<target>';
    const nextSteps = [
      `cdp perceive ${target} -C -d 8`,
      `cdp report ${target} --format json`,
    ];
    return {
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode,
      baselineAvailable: false,
      ...header,
      summary: {
        changed: null,
        removed: 0,
        added: 0,
        textRemoved: 0,
        textAdded: 0,
      },
      removed: [],
      added: [],
      removedOmitted: 0,
      addedOmitted: 0,
      textRemovedSamples: [],
      textAddedSamples: [],
      recommendation: buildPerceiveDiffRecommendation({
        mode,
        changed: null,
        baselineAvailable: false,
        nextSteps,
      }),
      nextSteps,
    };
  }
  return buildPerceiveDiffModel(baseline, currentOutput, {
    mode,
    targetPrefix: opts.targetPrefix || '',
  });
}

function rewriteFlowInput(input, cwd, depth) {
  // Same quote and `\;` boundaries as the step parser. A semicolon inside quotes
  // stays in that step; an escaped semicolon stays escaped in the raw text.
  let steps;
  try {
    steps = splitFlowSegmentsRaw(String(input));
  } catch {
    return input;
  }
  let changed = false;
  const next = steps.map(step => {
    const trimmed = step.trim();
    if (!trimmed) return step;
    const tokens = tokenizeCommandLine(trimmed);
    if (!tokens.length) return step;
    const head = tokens[0].value;
    if (head === 'wait' || head === 'assert') return step;
    const args = tokens.slice(1).map(token => token.value);
    let rewritten;
    try {
      rewritten = rewriteCallerCommandArgs(head, args, cwd, depth + 1);
    } catch {
      return step;
    }
    if (sameArgList(rewritten, args)) return step;
    changed = true;
    const prefix = step.match(/^\s*/)?.[0] || '';
    return `${prefix}${rejoinRewrittenCommand(head, rewritten)}`.trimEnd();
  });
  return changed ? next.join(';') : input;
}

function rewriteBatchInput(input, cwd, depth) {
  const text = String(input);
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    let commands;
    try { commands = JSON.parse(trimmed); } catch { return input; }
    if (!Array.isArray(commands)) return input;
    let changed = false;
    const next = commands.map(command => {
      if (!command || typeof command !== 'object' || Array.isArray(command)) return command;
      const args = Array.isArray(command.args) ? command.args.map(String) : [];
      let rewritten = args;
      try { rewritten = rewriteCallerCommandArgs(command.cmd, args, cwd, depth + 1); } catch { rewritten = args; }
      if (sameArgList(rewritten, args)) return command;
      changed = true;
      return { ...command, args: rewritten };
    });
    return changed ? JSON.stringify(next) : input;
  }
  const segments = text.split('|');
  let changed = false;
  const next = segments.map(segment => {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) return segment;
    const tokens = tokenizeCommandLine(trimmedSegment);
    if (!tokens.length) return segment;
    const head = tokens[0].value;
    const args = tokens.slice(1).map(token => token.value);
    let rewritten;
    try {
      rewritten = rewriteCallerCommandArgs(head, args, cwd, depth + 1);
    } catch {
      return segment;
    }
    if (sameArgList(rewritten, args)) return segment;
    changed = true;
    return rejoinRewrittenCommand(head, rewritten);
  });
  return changed ? next.join('|') : input;
}

function absolutizeFlowArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const indexes = callerPayloadIndexes(args, new Set());
  if (!indexes.length) return args;
  const input = indexes.map(index => args[index]).join(' ');
  const rewritten = rewriteFlowInput(input, cwd, depth);
  if (rewritten === input) return args;
  return replaceCallerPayload(args, indexes, rewritten);
}

function absolutizeBatchArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const indexes = callerPayloadIndexes(args, new Set(['--parallel', '--plain', '--compact']));
  if (!indexes.length) return args;
  const input = indexes.map(index => args[index]).join(' ');
  const rewritten = rewriteBatchInput(input, cwd, depth);
  if (rewritten === input) return args;
  return replaceCallerPayload(args, indexes, rewritten);
}

function absolutizeRepeatArgs(args, cwd, depth) {
  if (!Array.isArray(args)) return args;
  const untilFlags = new Set(['--until-selector', '--until-selector-missing', '--until-text']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--continue' || token === '-c') continue;
    if (untilFlags.has(token)) {
      i += 1;
      continue;
    }
    positional.push(i);
  }
  if (positional.length < 3) return args;
  const argIndexes = positional.slice(2);
  const inner = argIndexes.map(index => args[index]);
  const rewritten = rewriteCallerCommandArgs(args[positional[1]], inner, cwd, depth + 1);
  if (sameArgList(rewritten, inner)) return args;
  if (rewritten.length === inner.length) {
    const next = args.slice();
    argIndexes.forEach((index, offset) => { next[index] = rewritten[offset]; });
    return next;
  }
  for (let i = 1; i < argIndexes.length; i++) {
    if (argIndexes[i] !== argIndexes[i - 1] + 1) return args;
  }
  const start = argIndexes[0];
  const end = argIndexes[argIndexes.length - 1];
  return [...args.slice(0, start), ...rewritten, ...args.slice(end + 1)];
}

// Top-level commands and the same paths nested in flow, batch, and repeat (#577).
function rewriteCallerCommandArgs(cmd, args, cwd, depth) {
  if (depth > 8 || !Array.isArray(args)) return args;
  switch (canonicalCallerCommand(cmd)) {
    case 'shot': return absolutizeShotArgs(args, cwd);
    case 'fullshot': return absolutizeFullshotArgs(args, cwd);
    case 'elshot': return absolutizeElshotFileArg(args, cwd);
    case 'upload': return absolutizeUploadArgs(args, cwd);
    case 'replay':
    case 'restore': return absolutizeArtifactFileArgs(args, cwd);
    case 'responsive-audit': return absolutizeResponsiveAuditArgs(args, cwd);
    case 'netlog': return absolutizeNetlogOutArg(args, cwd);
    case 'click': return absolutizeExpectDownloadOut(args, cwd);
    case 'flow': return absolutizeFlowArgs(args, cwd, depth);
    case 'batch': return absolutizeBatchArgs(args, cwd, depth);
    case 'repeat': return absolutizeRepeatArgs(args, cwd, depth);
    default: return args;
  }
}

function absolutizeCallerFileArgs(cmd, args = [], cwd = process.cwd()) {
  return rewriteCallerCommandArgs(cmd, args, cwd, 0);
}

async function elshotStr(cdp, sid, selector, targetId, refMap, refState, filePath = null) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (filePath) assertScreenshotOutputDirectory(filePath, 'elshot');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    const label = await elshotRefLabel(cdp, sid, refMap, selector, refState);
    await sleep(100);
    const scroll = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ x: window.scrollX, y: window.scrollY })'));
    const clip = elementScreenshotClip(r, scroll);
    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = filePath || resolve(RUNTIME_DIR, `elshot-${prefix}-ref${selector.slice(1)}.png`);
    writeScreenshotFile(out, data, 'elshot');
    return formatElshotReceipt(`<${r.tag}> "${elshotReceiptLabel(label)}" (${selector})`, {
      w: r.w,
      h: r.h,
      fallback,
      path: out,
    });
  }
  // Scroll element into view and get its bounding rect
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        scrollX: window.scrollX, scrollY: window.scrollY,
        tag: el.tagName, id: el.id,
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 80)
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);

  // The rect and scroll offset come from the same instant, so their sum is the element's
  // document position even if a smooth scroll is still running.
  const clip = elementScreenshotClip(r, { x: r.scrollX, y: r.scrollY });

  await sleep(100); // let scroll settle

  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });

  const prefix = (targetId || 'unknown').slice(0, 8);
  const selSafe = selector.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const out = filePath || resolve(RUNTIME_DIR, `elshot-${prefix}-${selSafe}.png`);
  writeScreenshotFile(out, data, 'elshot');

  const desc = `<${r.tag}>${r.id ? '#' + r.id : ''} "${elshotReceiptLabel(r.text)}"`;
  return formatElshotReceipt(desc, { w: r.w, h: r.h, clip, fallback, path: out });
}

async function dispatchHoverWithLeftoverPolicy({
  cdp,
  sid,
  selector,
  refMap,
  refState,
  consoleBuf,
  exceptionBuf,
  lastPerceiveStore,
  targetId,
  nextCommand = null,
} = {}) {
  const dispatch = () => hoverStr(cdp, sid, selector, refMap, refState);
  if (hoverFeedbackPolicy(nextCommand) === 'report-only') {
    return dispatch();
  }
  let text;
  await rememberHoverSettleBaseline(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    refState,
    targetId,
    async () => {
      text = await dispatch();
    },
  );
  return text;
}

async function rememberHoverSettleBaseline(
  cdp,
  sid,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  targetId,
  dispatchHover = null,
) {
  // Hover mutates live DOM (tooltips, :hover text) but historically printed a
  // one-liner and left last-perceive stale. Recapture default AX so the next
  // mutator does not steal hover's delta (#286). Snapshot settle-shape AX
  // before mouseMoved — leftover perceive -C -d 8 is a different line-set
  // than default recapture even when both still say hover:0, so that leftover
  // must not be the KEEP baseline. After dispatch, recapture immediately; if
  // the same shape already changed, KEEP. If it is still idle, discard
  // unconditionally (#291). Do not sit waitForHoverDomChange /
  // HOVER_MUTATION_TIMEOUT_MS: Chrome 151 mouseenter can land after that
  // window, and discard already keeps the next no-op scroll honest. Do not
  // emit ActionResult. Do not lengthen waitForSettle. Do not wait for the
  // compositor mouseMoved ack. hoverStr confirms :hover before it returns;
  // this recapture stays immediate and does not add another wait.
  const settleOpts = actionObservationPerceiveOpts(targetId);
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  const before = lastPerceiveStore.output;
  if (typeof dispatchHover === 'function') {
    await dispatchHover();
  }
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  if (hoverRecaptureShowsChange(before, lastPerceiveStore.output)) {
    return;
  }
  discardHoverIdleBaseline(lastPerceiveStore);
}

async function fullshotStr(cdp, sid, filePath, targetId) {
  if (filePath) assertScreenshotOutputDirectory(filePath, 'fullshot');
  const targetPrefix = targetPrefixForDisplay(targetId);
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const dpr = await getDpr(cdp, sid);
  const metrics = await cdpDomains(cdp).Page.getLayoutMetrics( {}, sid);
  const width = metrics.cssContentSize?.width || metrics.contentSize?.width || 1280;
  const height = metrics.cssContentSize?.height || metrics.contentSize?.height || 800;
  let viewport = null;
  try {
    viewport = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
    ));
  } catch {}
  const fitsViewport = fullshotFitsViewport({ width, height }, viewport);
  const params = fitsViewport
    ? { format: 'png' }
    : {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      };
  const hooks = fitsViewport
    ? {}
    : {
        timeoutMs: FULLSHOT_TIMEOUT_MS,
        skipSanityRetry: true,
        failFastOnTimeout: true,
      };

  let capture;
  try {
    capture = await captureScreenshot(cdp, sid, params, hooks);
  } catch (error) {
    if (isScreenshotTimeoutError(error)) {
      throw new Error('fullshot: full-page capture timed out; screenshot is untrusted');
    }
    throw error;
  }
  if (!fitsViewport && capture.fallback === true) {
    throw new Error(`fullshot: full-page capture ${screenshotFallbackReason(capture)}; screenshot is untrusted`);
  }

  const out = filePath || resolve(RUNTIME_DIR, `fullshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeScreenshotFile(out, capture.data, 'fullshot');

  const diagnostics = formatScreenshotCaptureDiagnostics(capture);
  const fb = diagnostics ? ` ${diagnostics}` : '';
  return `${out}\nFull-page screenshot saved. Size: ${width}x${height} CSS px, DPR: ${dpr}${fb}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
}

async function scanshotStr(cdp, sid, targetId) {
  // Get viewport and page dimensions
  const dims = await evalStr(cdp, sid, `JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY)
  })`);
  const { vw, vh, scrollH, scrollY: originalY } = JSON.parse(dims);

  // Calculate segments (overlap by 10% to avoid cutting content at boundaries)
  const overlap = Math.round(vh * 0.1);
  const step = vh - overlap;
  const segments = [];
  for (let y = 0; y < scrollH; y += step) {
    segments.push(y);
  }
  // If the last segment is tiny (< 30% viewport), replace it with a
  // bottom-aligned capture so no content is clipped
  if (segments.length > 1) {
    const lastY = segments[segments.length - 1];
    const lastH = scrollH - lastY;
    if (lastH < vh * 0.3) {
      segments.pop();
      // Scroll the last capture so the viewport's bottom edge aligns with page bottom
      const bottomY = Math.max(0, scrollH - vh);
      if (bottomY > segments[segments.length - 1]) {
        segments.push(bottomY);
      }
    }
  }

  const files = [];
  const prefix = (targetId || 'unknown').slice(0, 8);

  let usedFallback = false;
  const offTarget = new Map();
  // One tier state for all segments: a tier that timed out is not retried per segment.
  const tierState = createScreenshotTierState();
  for (let i = 0; i < segments.length; i++) {
    const y = segments[i];
    // Scroll to segment
    await evalStr(cdp, sid, documentScrollToJs(y));
    await sleep(150); // let rendering settle
    // Read back where the page actually is: a page that overrides or animates scrolling would
    // otherwise yield images of the wrong slice that look like a successful capture.
    const landed = JSON.parse(await evalStr(cdp, sid, `JSON.stringify({
      y: Math.round(window.scrollY),
      max: Math.max(0, Math.round((Number(${DOCUMENT_SCROLLER_JS}.scrollHeight) || 0) - window.innerHeight)),
    })`));
    const expectedY = Math.min(y, Number(landed.max) || 0);
    if (Math.abs(Number(landed.y) - expectedY) > DOCUMENT_SCROLL_EDGE_TOLERANCE_PX) {
      offTarget.set(i, { landedY: landed.y, expectedY });
    }

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' }, { tierState });
    if (fallback) usedFallback = true;
    const out = resolve(RUNTIME_DIR, `scanshot-${prefix}-${i + 1}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });
    files.push(out);
  }

  // Restore original scroll position
  await evalStr(cdp, sid, documentScrollToJs(originalY));

  const lines = [`Captured ${files.length} segment(s) of ${vw}x${vh} viewport (page height: ${scrollH}px)`];
  if (usedFallback) lines.push('(screenshot fallback — Page.captureScreenshot timed out)');
  for (let i = 0; i < files.length; i++) {
    const miss = offTarget.get(i);
    lines.push(`  [${i + 1}/${files.length}] ${files[i]}${miss ? ` (landed at y=${miss.landedY}, expected y=${miss.expectedY})` : ''}`);
  }
  if (offTarget.size) {
    lines.push(`Warning: ${offTarget.size} of ${files.length} segment(s) did not land on their scroll offset (±${DOCUMENT_SCROLL_EDGE_TOLERANCE_PX}px), so those images do not show the expected slice. The page may override or animate scrolling; use fullshot for a single full-page capture.`);
  }
  lines.push(`Use the Read tool to view each segment image.`);
  return lines.join('\n');
}

async function annotshotStr(cdp, sid, targetId, refMap) {
  if (refMap.size === 0) throw new Error('No refs available. Run "perceive" first.');

  // Resolve all refs in parallel to get bounding rects
  const refEntries = [...refMap.entries()];
  const settled = await Promise.allSettled(refEntries.map(async ([num, backendNodeId]) => {
    const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId }, sid);
    const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId: object.objectId,
      functionDeclaration: `function() { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }`,
      returnByValue: true,
    }, sid);
    return { num, ...result.result.value };
  }));
  const entries = settled.filter(s => s.status === 'fulfilled').map(s => s.value);

  // Inject overlay + draw labels + screenshot + cleanup in try/finally
  await evalStr(cdp, sid, `(function() {
    const overlay = document.createElement('div');
    overlay.id = '__cdp_annot_overlay__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(overlay);
  })()`);

  try {
    await evalStr(cdp, sid, `(function() {
      const overlay = document.getElementById('__cdp_annot_overlay__');
      if (!overlay) return;
      const entries = ${JSON.stringify(entries)};
      for (const e of entries) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;border:2px solid red;pointer-events:none;' +
          'left:' + e.x + 'px;top:' + e.y + 'px;width:' + e.w + 'px;height:' + e.h + 'px;';
        const label = document.createElement('span');
        label.textContent = '@' + e.num;
        label.style.cssText = 'position:absolute;top:-16px;left:0;background:red;color:white;font:bold 11px monospace;padding:1px 3px;border-radius:2px;line-height:14px;';
        box.appendChild(label);
        overlay.appendChild(box);
      }
    })()`);

    await sleep(100);

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `annotshot-${prefix}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });

    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nAnnotated screenshot with ${entries.length} ref labels. Use refs (@1, @2...) from perceive output to identify elements.${fb}`;
  } finally {
    await evalStr(cdp, sid, `(function() { const el = document.getElementById('__cdp_annot_overlay__'); if (el) el.remove(); })()`).catch(() => {});
  }
}

async function reloadActionDispatch({ cdp, sessionId, session, consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, networkStatusByRequest, navigationCancelWatch = null }) {
  const buffers = reloadObservationBuffers(session, consoleBuf, exceptionBuf);
  const consoleBefore = typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0;
  const exceptionBefore = typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0;
  const consoleCutBefore = documentConsoleCutSeq(buffers.console);
  const exceptionCutBefore = documentConsoleCutSeq(buffers.exception);
  const reloadResult = await reloadStr(cdp, sessionId);
  // Checked before clearing buffers or refs: a cancelled reload left the page as it was.
  const cancelledBy = navigationCancelWatch
    ? await navigationCancelWatch({ awaitMs: NAVIGATION_CANCEL_EVIDENCE_WAIT_MS })
    : null;
  if (cancelledBy) throw navigationCancelledError('reload', cancelledBy);
  // #610: the main-frame commit already cut console and exception reads at that
  // document. Clearing those buffers after the load event dropped exceptions
  // thrown while the new document loaded, and cutting again here would move
  // the cut past those same entries. Navigation and network reads are not cut
  // that way, so those buffers are still cleared. The cleared netlog is saved
  // so a later daemon does not bring the pre-reload requests back.
  clearObservationBuffers({ navBuf, netReqBuf, pendingReqs, networkStatusByRequest, session });
  const consoleCutMoved = documentConsoleCutSeq(buffers.console) !== consoleCutBefore;
  const exceptionCutMoved = documentConsoleCutSeq(buffers.exception) !== exceptionCutBefore;
  if (!consoleCutMoved || !exceptionCutMoved) {
    cutDocumentConsoleBuffersAt(buffers, {
      ...(consoleCutMoved ? {} : { console: consoleBefore }),
      ...(exceptionCutMoved ? {} : { exception: exceptionBefore }),
    });
  }
  if (session) invalidateSessionRefs(session, 'navigation', { cutDocument: false });
  return reloadResult;
}

// --- Flow: sequential step runner ---
// A semicolon separates steps only outside quotes (' " `). A quote opens only at
// the start of a word: the start of a segment, or after whitespace. A quote inside
// a word stays literal. Inside quotes a backslash is literal, except `\;`, which
// keeps a semicolon. The opening quote always closes. Outside quotes, `\;` is a
// literal semicolon, and a doubled backslash does not escape the next character,
// so `\\;` still separates steps. An unquoted `\;` before a command name, alias,
// or assert fails the flow, except inside an unquoted eval/eval64/call body.
// That body keeps consuming segments until the next one starts with a command
// name, alias, or assert. A body that is one wrapped quote stops at that quote.
// The unwrapped script body is one argument, byte-exact, including an empty
// quoted body. Wrapping quotes on that body are flow delimiters and are not
// part of the JavaScript.
let flowStepHeads = null;

function flowStepHeadSet() {
  if (!flowStepHeads) {
    flowStepHeads = new Set(['assert', FOREGROUND_ACTIVATE_COMMAND]);
    for (const command of COMMANDS) {
      flowStepHeads.add(command.name);
      for (const alias of command.aliases || []) flowStepHeads.add(alias);
    }
  }
  return flowStepHeads;
}

function splitFlowSegmentsRaw(input) {
  const segments = [];
  let start = 0;
  let quote = '';
  let quoteAt = -1;
  let atTokenStart = true;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      // A backslash does not swallow the closer. `\;` stays in this step.
      const escaped = flowQuotedEscape(ch, input[i + 1]);
      if (escaped.skip) {
        i += escaped.skip;
        continue;
      }
      if (ch === quote) {
        quote = '';
        quoteAt = -1;
        atTokenStart = false;
      }
      continue;
    }
    // Pair from the left. `\\` is an escaped backslash, so the second slash does
    // not escape a following semicolon: `\\;` still starts the next step.
    if (ch === '\\' && input[i + 1] === '\\') {
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '\\' && input[i + 1] === ';') {
      const nextWord = flowWordAt(input, i + 2);
      if (nextWord && flowStepHeadSet().has(nextWord) && !escapedSemicolonIsScriptBody(input, start, i)) {
        throw ambiguousEscapedSemicolonError(nextWord);
      }
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (flowQuoteOpens(atTokenStart, ch)) {
      quote = ch;
      quoteAt = i;
      atTokenStart = false;
      continue;
    }
    if (ch === ';') {
      segments.push(input.slice(start, i));
      start = i + 1;
      atTokenStart = true;
      continue;
    }
    atTokenStart = /\s/.test(ch);
  }
  if (quote) throw unclosedFlowQuoteError(input, quoteAt);
  segments.push(input.slice(start));
  return segments;
}

function splitFlowSegments(input) {
  return splitFlowSegmentsRaw(input).map(decodeFlowEscapedSemicolon);
}

function mergeFlowScriptSegments(segments) {
  const steps = [];
  let index = 0;
  while (index < segments.length) {
    if (!segments[index].trim()) {
      index++;
      continue;
    }
    const head = firstFlowToken(segments[index]);
    if (!FLOW_SCRIPT_COMMANDS.has(head)) {
      steps.push(segments[index].trim());
      index++;
      continue;
    }
    let combined = segments[index];
    let next = index + 1;
    // Only an unquoted body continues. A wrapped quote already ended the body,
    // so the next segment is the next step even when it is not a command name.
    if (!scriptSegmentClosesQuote(segments[index])) {
      while (next < segments.length) {
        const piece = segments[next];
        if (piece.trim() && flowStepHeadSet().has(firstFlowToken(piece))) break;
        combined += `;${piece}`;
        next++;
      }
    }
    steps.push(combined.trim());
    index = next;
  }
  return steps;
}

function parseFlowSteps(input) {
  if (typeof input !== 'string' || !input.trim()) return [];
  return mergeFlowScriptSegments(splitFlowSegments(input)).map(parseFlowLine);
}

async function flowStr({ run, settle, assertCondition }, input, { format = 'text', targetId = null, throwOnFailure = false } = {}) {
  const steps = parseFlowSteps(input);
  if (steps.length === 0) throw new Error('flow: no steps. Example: flow <target> "click @1; wait dom stable; summary"');
  const lines = [`Flow: ${steps.length} step(s)`];
  const stepResults = [];
  const finish = () => {
    const model = buildFlowResultModel({ targetId, input, steps, stepResults });
    const output = format === 'json' ? formatJson(model) : lines.join('\n');
    if (throwOnFailure && model.halted) {
      const error = new Error(output);
      error.code = 'FLOW_HALTED';
      throw error;
    }
    return output;
  };
  const markSkippedAfter = (startIndex) => {
    for (let j = startIndex; j < steps.length; j++) {
      stepResults.push(flowStepModel(steps[j], j, { skipped: true }));
    }
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const head = step.kind === 'wait'
      ? `[${i + 1}/${steps.length}] wait ${step.what}`
      : step.kind === 'assert'
      ? `[${i + 1}/${steps.length}] assert ${pageConditionDescription(step.condition)}`
      : `[${i + 1}/${steps.length}] ${step.cmd}${step.args.length ? ' ' + step.args.join(' ') : ''}`;
    lines.push(head);
    try {
      let body;
      if (step.kind === 'wait') {
        body = await settle(step.what);
      } else if (step.kind === 'assert') {
        if (typeof assertCondition !== 'function') throw new Error('flow: assertion probe is unavailable');
        const assertion = await assertCondition(step.condition);
        if (!assertion.matched) throw new Error(`Assertion failed: ${assertion.description}`);
        body = `Assertion passed: ${assertion.description}`;
      } else {
        const r = await run(step);
        if (!r.ok) {
          stepResults.push(flowStepModel(step, i, {
            ok: false,
            result: r.result,
            error: r.error,
          }));
          markSkippedAfter(i + 1);
          lines.push(`  ✗ ${r.error}`);
          lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
          return finish();
        }
        body = r.result ?? '';
      }
      const stepModel = flowStepModel(step, i, { ok: true, result: body });
      stepResults.push(stepModel);
      const text = (body || '').toString();
      if (text) for (const ln of text.split('\n')) lines.push('  ' + ln);
      if (!stepModel.ok) {
        markSkippedAfter(i + 1);
        lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
        return finish();
      }
    } catch (e) {
      if (e?.code === 'FLOW_HALTED') throw e;
      stepResults.push(flowStepModel(step, i, { ok: false, error: e.message }));
      markSkippedAfter(i + 1);
      lines.push(`  ✗ ${e.message}`);
      lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
      return finish();
    }
  }
  return finish();
}

// #466: the steps batch/flow/repeat/replay would run, so the session policy can refuse the whole
// command before its first step. Null when the arguments do not parse; the command reports that.
function policyCompositeSteps(cmd, args = []) {
  try {
    if (cmd === 'batch') {
      return parseBatchArgs(args).commands.map(command => ({
        cmd: String(command?.cmd || ''),
        args: Array.isArray(command?.args) ? command.args.map(String) : [],
      }));
    }
    if (cmd === 'flow') {
      // wait/assert steps stay as empty entries so step numbers match the flow text.
      return parseFlowSteps(parseFormatArgs(args, ['text', 'json']).args.join(' '))
        .map(step => (step.kind === 'command' ? { cmd: step.cmd, args: step.args } : { cmd: '', args: [] }));
    }
    if (cmd === 'repeat') {
      const opts = parseRepeatArgs(args);
      return [{ cmd: opts.cmd, args: opts.args }];
    }
    if (cmd === 'replay') {
      const { artifact } = parseReplayArgs(args);
      const actions = [
        ...(Array.isArray(artifact.environment) ? artifact.environment : []),
        ...(Array.isArray(artifact.actions) ? artifact.actions : []),
      ];
      // Steps replay skips stay as empty entries so step numbers match the artifact.
      return actions.map(replayStepFromAction)
        .map(step => (!step.skip && step.cmd ? { cmd: step.cmd, args: step.args } : { cmd: '', args: [] }));
    }
  } catch {
    return null;
  }
  return null;
}

// --- Doctor: one-call diagnostics ---
function checkNode(version = process.version, opts = {}) {
  const major = nodeMajor(version);
  if (major >= 22) return { status: 'OK', label: 'Node', detail: `${version} (>= 22)` };
  const cdpScriptPath = opts.cdpScriptPath || fileURLToPath(import.meta.url);
  const found = typeof opts.discover === 'function'
    ? opts.discover()
    : discoverNode22({
      home: opts.home,
      env: opts.env,
      fs: opts.fs,
      spawnSync: opts.spawnSync,
      execPath: opts.execPath || process.execPath,
      execVersion: version,
      timeout: opts.timeout,
    });
  if (found?.binary) {
    const rerunCommand = formatNodeRerunCommand(found.binary, cdpScriptPath, 'doctor');
    return {
      status: 'WARN',
      severity: 'advisory',
      label: 'Node',
      detail: `${version} (runtime) ; Node 22 found at ${found.binary}`,
      hint: `Rerun: ${rerunCommand}`,
      recommendedBinary: found.binary,
      recommendedVersion: found.version,
      cdpScriptPath,
      rerunCommand,
    };
  }
  return {
    status: 'FAIL',
    label: 'Node',
    detail: `${version} (need >= 22)`,
    hint: NODE22_MISSING_HINT,
  };
}

async function runDoctorChecks(opts = {}) {
  const safeLstat = (p) => { try { return lstatSync(p); } catch { return null; } };
  const fs = opts.fs || { existsSync, lstatSync: safeLstat, readdirSync };
  const checks = [];
  checks.push(checkNode(opts.nodeVersion, {
    home: opts.home,
    env: opts.env,
    fs,
    spawnSync: opts.spawnSync,
    execPath: opts.execPath,
    cdpScriptPath: opts.cdpScriptPath,
    discover: opts.discoverNode22,
  }));
  checks.push(checkSkillSymlink({ home: opts.home, env: opts.env, fs }));
  checks.push(checkDaemonSockets({ list: opts.listDaemons }));
  checks.push(checkFdLimit({ limit: opts.fdLimit, platform: opts.platform }));
  checks.push(checkRuntimeEnvironment({ platform: opts.platform, env: opts.env, fs }));
  const cdp = await checkCdpReachability({
    env: opts.env,
    fetcher: opts.fetcher,
    host: opts.host,
    lastEndpoint: opts.lastEndpoint,
    readLastEndpoint: opts.readLastEndpoint,
    connectWebSocket: opts.connectWebSocket,
    inspectOccupantProfileDir: opts.inspectOccupantProfileDir,
    inspectProfileProcess: opts.inspectProfileProcess,
    display: opts.display || cdpDisplayContext({ platform: opts.platform, env: opts.env }),
    home: opts.home,
    existsSync: fs.existsSync,
  });
  checks[4] = reconcileRuntimeEnvironmentCheck(checks[4], cdp);
  checks.push(cdp);
  const tabs = await checkBrowserTargets({ cdp, env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks.push(tabs);
  const daemons = checks.find(c => c.label === 'Daemons');
  const reconciled = reconcileCdpWithLiveDaemons(cdp, daemons, {
    prefix: doctorCliPrefix(checks.find(c => c.label === 'Node')),
  });
  const cdpIndex = checks.findIndex(c => c.label === 'CDP');
  if (cdpIndex >= 0) checks[cdpIndex] = reconciled;
  checks.push(checkBrowserPermission({
    daemons,
    tabs,
    cdp: reconciled,
    environment: checks.find(c => c.label === 'Environment'),
  }));
  checks.push(await checkBrowserProfile({
    cdp: reconciled,
    // An injected fetcher means a stubbed endpoint: do not look up a real process on that port.
    inspectBrowserArgv: opts.inspectBrowserArgv || (opts.fetcher ? async () => null : undefined),
    readUserAgent: endpoint => readCdpUserAgent({ ...endpoint, fetcher: opts.fetcher || fetch }),
  }));
  return checks;
}

async function doctorStr(opts = {}) {
  const checks = await runDoctorChecks(opts);
  return formatDoctorOutput(checks, { format: opts.format || 'text' });
}

async function minimizeBrowserWindows({ host = DEFAULT_CDP_HOST, port, targetIds = [], fetcher = fetch } = {}) {
  const cdp = new CDP();
  try {
    await cdp.connect(await wsUrlFromCdpHttp({ host, port, fetcher, remembered: null, rememberReachable: () => {} }));
    return await minimizeWindowsForTargets(cdp, targetIds);
  } finally {
    try { cdp.close(); } catch {}
  }
}

async function spawnDebugBrowserStr(args, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || { existsSync, mkdirSync, readdirSync, readFileSync };
  const launcher = deps.spawn || spawn;
  const probePort = deps.probeTcpPort || probeTcpPort;
  const waitForCdp = deps.waitForSpawnedCdp || waitForSpawnedCdp;
  const listTargets = deps.listSpawnedDebugTargets || listSpawnedDebugTargets;
  const fetcher = deps.fetcher || fetch;
  const opts = parseSpawnDebugBrowserArgs(args, env, { platform });
  if (opts.helpRequested) {
    const err = new Error('spawn-debug-browser: help requested');
    err.code = 'help_requested';
    err.helpTopic = 'spawn-debug-browser';
    throw err;
  }
  const plan = buildSpawnDebugBrowserPlan(opts, platform, fs, env);
  const portState = await probePort({ host: plan.host, port: plan.port });
  if (portState?.occupied) {
    const readiness = await waitForCdp({
      port: plan.port,
      host: plan.host,
      timeoutMs: Math.min(plan.waitMs || DEFAULT_SPAWN_READY_TIMEOUT_MS, 2000),
      fetcher,
    });
    if (!readiness.ok) {
      throw new Error(`spawn-debug-browser: port ${plan.port} is already in use on ${plan.host}. Choose another port with --port <N>.`);
    }
    if (opts.dailyProfile) {
      const occupantProfileDir = await resolveOccupantProfileDir({
        host: plan.host,
        port: plan.port,
        inspectOccupantProfileDir: deps.inspectOccupantProfileDir,
        connectWebSocket: deps.connectWebSocket,
      });
      if (isIsolatedChromeCdpExProfileDir(occupantProfileDir)) {
        throw isolatedOccupantAttachError({
          host: plan.host,
          port: plan.port,
          profileDir: occupantProfileDir,
        });
      }
    }
    const pages = await listTargets({ port: plan.port, host: plan.host, fetcher });
    const target = pickSpawnedTarget(pages, plan.url);
    const model = buildSpawnDebugBrowserModel(plan, readiness, { attached: true, target });
    if (opts.format !== 'json') {
      const text = formatSpawnDebugBrowserOutput(model, { format: 'text' })
        .replace('  Executable: (see profile)', `  Executable: ${plan.exe}`);
      return text;
    }
    return formatSpawnDebugBrowserOutput(model, { format: 'json' });
  }
  // Tests inject chromiumMajorVersion when they need 136+ behavior. Do not
  // probe the real browser binary (this machine is already Edge 136+).
  const chromiumMajor = Object.hasOwn(deps, 'chromiumMajorVersion')
    ? deps.chromiumMajorVersion
    : (process.env.NODE_ENV === 'test' && !Object.hasOwn(deps, 'spawnSyncFn')
      ? null
      : detectChromiumMajorVersion(plan.exe, {
        fs,
        platform,
        spawnSyncFn: deps.spawnSyncFn || spawnSync,
      }));
  if (
    opts.dailyProfile
    && isDefaultBrowserProfileDir(plan, { platform, env })
    && defaultProfileIgnoresRemoteDebugging(chromiumMajor)
  ) {
    throw new Error(formatDailyDefaultProfileCdpFailure(plan, '', { refusedMajor: chromiumMajor }));
  }
  if (opts.dailyProfile) {
    const locked = typeof deps.isProfileLocked === 'function'
      ? deps.isProfileLocked(plan.profileDir)
      : defaultIsProfileLocked(plan.profileDir, fs);
    if (locked) {
      const quitter = deps.quitBrowser || defaultQuitBrowser;
      await quitter(plan, { platform, fs });
    }
  }
  if (!opts.dailyProfile) {
    const remembered = typeof deps.readLastCdpEndpoint === 'function'
      ? deps.readLastCdpEndpoint()
      : (process.env.NODE_ENV === 'test' ? null : readLastCdpEndpoint());
    const livePort = await liveOtherProfilePort(plan, {
      fetcher,
      remembered,
      fs,
      inspectOccupantProfileDir: deps.inspectOccupantProfileDir,
      connectWebSocket: deps.connectWebSocket,
      readProcessArgv: deps.readBrowserProcessArgv
        || (process.env.NODE_ENV === 'test' ? null : readBrowserProcessArgv),
    });
    if (livePort) throw profileInUseSpawnError(plan, { livePort });
  }
  let child = null;
  let output = null;
  let readiness = null;
  let retriedExistingSessionHandoff = false;
  for (;;) {
    try { fs.mkdirSync(plan.profileDir, { recursive: true }); } catch {}
    child = launcher(plan.exe, plan.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    output = captureSpawnOutput(child);
    readiness = await waitForCdp({
      port: plan.port,
      host: plan.host,
      timeoutMs: plan.waitMs,
      child,
      output,
      fetcher,
    });
    const handoffText = spawnOutputHandoffText(output, readiness);
    if (opts.dailyProfile && isExistingBrowserSessionHandoff(handoffText)) {
      if (!retriedExistingSessionHandoff) {
        retriedExistingSessionHandoff = true;
        const quitter = deps.quitBrowser || defaultQuitBrowser;
        await quitter(plan, { platform, fs });
        continue;
      }
      throw new Error(formatDailyDefaultProfileCdpFailure(plan, handoffText));
    }
    if (!opts.dailyProfile && readinessIsProfileHandoff(output, readiness)) {
      throw profileInUseSpawnError(plan);
    }
    break;
  }
  if (!readiness.ok) {
    const failText = spawnOutputHandoffText(output, readiness);
    if (opts.dailyProfile && isDefaultBrowserProfileDir(plan, { platform, env })) {
      throw new Error(formatDailyDefaultProfileCdpFailure(plan, failText));
    }
    throw new Error(formatSpawnDebugBrowserReadinessFailure(plan, readiness));
  }
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.unref?.();
  const pages = await listTargets({ port: plan.port, host: plan.host, fetcher });
  const target = pickSpawnedTarget(pages, plan.url);
  if (plan.background && !plan.headless && pages.length) {
    const minimize = deps.minimizeBrowserWindows || minimizeBrowserWindows;
    try {
      await minimize({ host: plan.host, port: plan.port, targetIds: pages.map(page => page.targetId) });
    } catch {}
  }
  const remember = deps.rememberLastCdpEndpoint || rememberLastCdpEndpoint;
  try {
    remember({
      host: plan.host,
      port: plan.port,
      profileDir: plan.profileDir,
      exe: plan.exe,
      browser: plan.browser,
      // #426: relaunch-same-profile replays these (headless, no-sandbox, ...).
      launchFlags: replayableLaunchFlags(plan.args),
      // #416: recovery suggests the spawn command only for profiles this command created.
      // A --daily-profile spawn is not reproducible through --profile-dir, so it stays untagged
      // and recovery keeps the raw browser line for it.
      ...(plan.dailyProfile ? {} : { via: SPAWN_DEBUG_BROWSER_VIA }),
    });
  } catch {}
  const model = buildSpawnDebugBrowserModel(plan, readiness, { child, target });
  // Prefer executable path in text mode for operators.
  if (opts.format !== 'json') {
    const text = formatSpawnDebugBrowserOutput(model, { format: 'text' })
      .replace('  Executable: (see profile)', `  Executable: ${plan.exe}`);
    return text;
  }
  return formatSpawnDebugBrowserOutput(model, { format: 'json' });
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

const DAEMON_HANDLER_BUILDERS = Object.freeze({
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
const DAEMON_APPLICATION_COMMANDS = Object.freeze(Object.keys(DAEMON_HANDLER_BUILDERS).sort());

function preflightDaemonApplication(input = {}) {
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

async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {
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
            actionTarget.controlStateDiff = formatFormControlStateDiff(beforeControl, afterControl);
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
    fullshot: args => fullshotStr(cdp, sessionId, args[0], targetId),
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
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return formatRecordActions(session, { format: fopts.format });
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
        value = await evalStr(cdp, sessionId, eopts.expression, true, { raw: eopts.raw });
      }
      return commandResult(value, null);
    },
    eval64: async args => commandResult(
      await evalStr(cdp, sessionId, evalBase64Decode(args[0]), true),
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
      const failure = classifyActionFailure(actionError, context);
      const error = alreadyClassified || failure.kind === 'native-dialog' || (isMutatingCommand && failure.kind !== 'unknown' && failure.kind !== 'usage')
        ? formatActionFailure(actionError, context)
        : rawError;
      return { ok: false, error };
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

async function discoverLivePagesForTargetResolution({
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

function createReportCommandHandler(session, { cdp = null, sessionId = null, pageInfo = pageInfoModel } = {}) {
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

function createPerceiveCommandHandler({
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
function collectSecretNames(cmd, args = [], { readFile, cwd, depth = 0 } = {}) {
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
function cliRequestSecrets(cmd, args = [], {
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

function buildCliErrorRecovery(message, { cmd = '', targetPrefix = '', platform = process.platform, err = null, args = [] } = {}) {
  const lower = String(message || '').toLowerCase();
  const target = targetPrefix || '<target>';
  // #466: CDP_DENY_ACTIONS / CDP_ALLOWED_ORIGINS refusals (Kind: policy) and bad policy variables.
  const sessionPolicyRecovery = policyRecovery(message, { targetPrefix });
  if (sessionPolicyRecovery) return sessionPolicyRecovery;
  // #534: CDP_ISOLATED_ONLY refused a daily or unidentified profile; start an isolated browser instead.
  if (err?.code === 'daily_profile_refused') {
    const browser = err.profile?.browser || 'chrome';
    const port = '9333';
    return {
      kind: 'policy',
      strategy: 'use-isolated-browser',
      run: `cdp spawn-debug-browser ${browser} --port ${port} --user-data-dir ${shellQuoteCliArg(isolatedSpawnProfileDir(browser, port))}`,
      consentRequired: true,
      then: `CDP_PORT=${port} cdp list`,
      reason: 'CDP_ISOLATED_ONLY=1 keeps automation out of the daily profile (browser default or chrome-cdp-ex/daily-*). Launching a separate isolated browser opens a window, so ask first.',
    };
  }
  if (err?.code === 'daemon_socket_path_too_long' || lower.includes('over the 107-byte unix socket limit') || lower.includes('over the 103-byte unix socket limit')) {
    // #444: rerun the same command with a runtime dir short enough for a Unix socket path.
    const rerun = ['cdp', cmd || 'list', ...(targetPrefix ? [targetPrefix] : []), ...(args || []).map(recoveryCommandArg).filter(Boolean)];
    return {
      kind: 'runtime-dir',
      strategy: 'shorten-runtime-dir',
      run: `XDG_RUNTIME_DIR=/tmp/cdp-rt ${rerun.join(' ')}`,
      reason: 'The per-tab daemon socket path is longer than the OS allows; a shorter XDG_RUNTIME_DIR keeps each tab on its own socket.',
    };
  }
  if (lower.includes('emfile') || lower.includes('too many open files')) {
    const recovery = fdLimitRecovery({ platform });
    const commands = recovery.commands || [];
    return {
      kind: 'fd-limit',
      strategy: recovery.strategy,
      run: commands[0]?.command || 'ulimit -n 4096',
      then: commands[1]?.command || null,
      reason: 'The process ran out of file descriptors while managing Chrome, sockets, screenshots, or session files.',
      commands,
    };
  }
  if (isHiddenTabCaptureError(err) || isHiddenTabCaptureError({ message })) {
    // #488: CDP_BACKGROUND=0 on this one call activates the tab before the command runs. Only a capture
    // command is rerun whole: a flow/repeat/replay/batch may already have clicked or typed, so its
    // recovery names the capture alone and never replays the earlier steps.
    const captureCommand = HIDDEN_TAB_RERUN_COMMANDS.has(COMMAND_SURFACE.resolve(cmd)?.name || cmd);
    const rerun = captureCommand
      ? ['cdp', cmd, target, ...(args || []).map(recoveryCommandArg).filter(Boolean)]
      : ['cdp', 'shot', target];
    return {
      kind: 'hidden-tab',
      strategy: 'activate-tab',
      run: `CDP_BACKGROUND=0 ${rerun.join(' ')}`,
      reason: captureCommand
        ? 'The tab is hidden and Chrome rendered no frame for it in time. CDP_BACKGROUND=0 on this call activates the tab first (a background tab, or a minimized window); a window covered by other windows is not raised by Chrome, so uncover it yourself.'
        : 'A capture step met a hidden tab. Earlier steps already ran: do not rerun the whole command. Take the capture alone with this command (it activates the tab first), then run only the steps that did not run.',
    };
  }
  // #452: say which capture pipeline failed instead of `Kind: unknown`.
  if (
    err?.code === 'screenshot_capture_failed'
    || lower.includes('screenshot failed:')
    || lower.includes('unable to capture screenshot')
    || lower.includes('screenshot alternate capture')
  ) {
    return {
      kind: 'screenshot-capture',
      strategy: 'perceive-instead',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'Chrome returned no usable frame from the capture pipelines named in the error; the page structure is still readable.',
    };
  }
  // #469: a --secret name that is unset, empty, malformed, or a secrets file that is refused.
  if (
    err?.code === 'unknown_secret'
    || lower.includes('unknown secret')
    || lower.includes('cdp_secrets_file')
    || lower.includes('--secret')
    || /\bsecret name\b|\bsecret [a-z0-9_]+ (?:is empty|was not provided)/.test(lower)
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help fill',
      reason: 'fill --secret NAME reads CDP_SECRET_<NAME> or the NAME entry of CDP_SECRETS_FILE at call time. Set it, then rerun; only names are ever listed.',
    };
  }
  // Discovery already asked doctor's recommendation for this same CDP check (#425): use it as is.
  if (err?.cdpRecovery?.kind) return { ...err.cdpRecovery };
  if (
    err?.code === 'cdp_unreachable'
    || lower.includes('cannot reach cdp')
    || lower.includes('no devtoolsactiveport')
    || lower.includes('websocket error')
    || lower.includes('remote-debugging-port')
  ) {
    if (err?.profileDir && err?.relaunch) {
      return {
        kind: 'browser-cdp',
        strategy: 'relaunch-same-profile',
        run: err.relaunch,
        reason: 'Chrome debugging endpoint is down. Relaunch the same user-data-dir; do not invent a new profile.',
        ...(Array.isArray(err.candidates) && err.candidates.length > 1 ? { candidates: err.candidates } : {}),
      };
    }
    if (err?.code === 'cdp_unreachable' || lower.includes('cannot reach cdp')) {
      return {
        kind: 'browser-cdp',
        strategy: 'enable-existing-debugging',
        run: err?.relaunch || 'cdp doctor',
        reason: 'Chrome debugging endpoint is down. Do not invent a new --user-data-dir; enable remote debugging on the existing browser via chrome://inspect/#remote-debugging.',
      };
    }
    return {
      kind: 'browser-cdp',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: 'Chrome is not reachable through the configured debugging endpoint.',
    };
  }
  if (
    err?.code === 'unknown_alias'
    || lower.includes('unknown alias')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'list-aliases',
      run: 'cdp list',
      then: 'cdp current',
      reason: 'The named alias is not saved. List tabs or inspect current aliases.',
    };
  }
  // #538: the prefix vanished but one live page has its last-seen URL and title: rerun on that page.
  if (err?.code === 'target_successor' && err.successorPrefix) {
    // An empty or space-padded argument (`fill <t> #pw ""`) is part of the command: quote it as typed.
    const rerun = ['cdp', cmd || 'perceive', err.successorPrefix, ...(args || []).map(arg => (arg === '' ? '""' : String(arg).trim() !== String(arg) ? `'${String(arg).replace(/'/g, "'\\''")}'` : recoveryCommandArg(arg))).filter(Boolean)];
    return {
      kind: 'target-resolution',
      strategy: 'use-successor-target',
      run: rerun.join(' '),
      reason: 'Chrome gave this tab a new target id without closing it (a navigation or renderer swap). The same URL and title now live under the new prefix; update any script that keeps the old one.',
    };
  }
  if (
    lower.includes('target id required') ||
    lower.includes('no page list cached') ||
    lower.includes('no target matching prefix') ||
    lower.includes('no live target matching prefix') ||
    lower.includes('no live target matching alias') ||
    lower.includes('no page matched')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'rediscover-target',
      run: 'cdp list',
      then: 'cdp open https://example.com',
      reason: 'The requested tab target could not be resolved from the current page list. If the list is empty, open a page.',
    };
  }
  if (
    lower.includes('ambiguous prefix')
    || lower.includes('is ambiguous')
    || lower.includes('pages matched')
    || /target:\s+\d+\s+pages matched/i.test(message)
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'choose-longer-prefix',
      run: 'cdp list',
      reason: 'More than one tab matches the provided target prefix. Copy a longer target prefix.',
    };
  }
  if (cmd === 'target' && (lower.includes('provide --url') || lower.includes('and/or --title'))) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help target',
      reason: 'target requires --url and/or --title. Print usage instead of probing doctor.',
    };
  }
  if (
    (cmd === 'press' || cmd === 'key')
    && (lower.includes('unknown key') || lower.includes('key name required'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help press',
      reason: 'press requires a supported key name. Print usage instead of wrapping as an unclassified action failure.',
    };
  }
  if (
    (cmd === 'wait' || lower.includes('wait duration'))
    && (
      lower.includes('wait duration')
      || lower.includes('positive integer')
      || lower.includes('at least')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help wait',
      reason: 'wait requires a positive millisecond duration. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'repeat'
      || lower.includes('repeat requires')
      || lower.includes('repeat: count')
      || lower.includes('repeat: command name required'))
    && (
      lower.includes('repeat requires')
      || lower.includes('count must be a positive integer')
      || lower.includes('command name required')
      || lower.includes('exceeds cap')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help repeat',
      reason: 'repeat requires a positive count and a command. Print usage instead of probing status.',
    };
  }
  if (
    (cmd === 'verify-click' || cmd === 'verifyclick' || lower.includes('verify-click:'))
    && (
      lower.includes('requires')
      || lower.includes('exactly one selector')
      || lower.includes('unknown argument')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help verify-click',
      reason: 'verify-click needs a selector and paired network assertions. --expect-status alone is not a check.',
    };
  }
  if (
    (cmd === 'restore' || cmd === 'replay'
      || lower.includes('restore:')
      || lower.includes('replay:'))
    && (
      lower.includes('enoent')
      || lower.includes('no such file')
      || lower.includes('unsupported') && lower.includes('schema')
      || lower.includes('requires --file')
      || lower.includes('requires --json')
      || lower.includes('invalid checkpoint')
      || lower.includes('invalid json artifact')
      || lower.includes('artifact must be')
      || lower.includes('checkpoint artifact must')
    )
  ) {
    const helpCmd = cmd === 'replay' || lower.includes('replay') ? 'replay' : 'restore';
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: `cdp help ${helpCmd}`,
      reason: `${helpCmd} needs an existing artifact with a supported schema. Missing files are local usage, not a page failure.`,
    };
  }
  if (
    (cmd === 'diff-shot' || cmd === 'diffshot' || lower.includes('diff-shot:'))
    && (
      lower.includes('timed out')
      || lower.includes('untrusted')
      || lower.includes('capture timed out')
      || lower.includes('timeout: page.capturescreenshot')
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'retry-or-use-shot',
      run: 'cdp help diff-shot',
      reason: 'Screenshot capture timed out. Do not treat a missing capture as 0% changed.',
    };
  }
  if (
    (cmd === 'tab-group' || cmd === 'tabgroup' || cmd === 'broadcast')
    && (lower.includes('unknown group') || lower.includes('unknown action'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd === 'broadcast' ? 'cdp help broadcast' : 'cdp tab-group list',
      reason: 'The named tab group is not stored. List groups instead of probing doctor.',
    };
  }
  if (
    (cmd === 'select' || lower.includes('not a <select>') || lower.includes('no option value'))
    && (
      lower.includes('not a <select>')
      || lower.includes('no option value')
      || lower.includes('css selector or @ref required')
      || lower.includes('css selector required')
      || lower.includes('value required')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help select',
      reason: 'Pass an @ref or a CSS selector for a <select> and an option value or visible label that exists.',
    };
  }
  if (lower.includes('closetab: refusing to close the last open tab') || lower.includes('closetab: unknown argument')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help closetab',
      reason: 'closetab refuses to close the only open tab (the browser may quit). Open another tab first, or pass --force.',
    };
  }
  if (
    (cmd === 'upload' || lower.includes('upload:'))
    && (
      lower.includes('file not found')
      || lower.includes('not a readable file')
      || lower.includes('is not an <input type="file">')
      || lower.includes('css selector or @ref for <input type="file"> required')
      || lower.includes('css selector for <input type="file"> required')
      || lower.includes('refusing to guess')
      || lower.includes('does not accept several files')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help upload',
      reason: 'upload requires an existing readable file and exactly one matching file input. Do not plant a ghost file or guess between inputs.',
    };
  }
  if (
    (cmd === 'cookiedel' || lower.includes('cookie not found') || lower.includes('cookie still present'))
    && (lower.includes('cookie not found') || lower.includes('cookie still present'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: targetPrefix ? `cdp cookies ${targetPrefix}` : 'cdp help cookiedel',
      reason: lower.includes('cookie still present')
        ? 'The named cookie is still present after delete. Do not claim deletion.'
        : 'The named cookie is not present. List cookies instead of claiming a delete.',
    };
  }
  if ((cmd === 'netlog' || lower.includes('netlog:')) && lower.includes('no request #')) {
    return {
      kind: 'usage',
      strategy: 'list-requests',
      run: `cdp netlog ${target}`,
      reason: 'That request id is not in this tab\'s network log. List the captured requests and use one of their #ids.',
    };
  }
  if ((cmd === 'netlog' || lower.includes('netlog:')) && lower.includes('--out') && /request #\d+/.test(lower)) {
    const requestId = lower.match(/request #(\d+)/)[1];
    const noBody = lower.includes('has no body to save');
    return {
      kind: 'usage',
      strategy: noBody ? 'inspect-request-without-out' : 'choose-out-path',
      run: noBody
        ? `cdp netlog ${target} --id ${requestId}`
        : `cdp netlog ${target} --id ${requestId} --out <new absolute file path>`,
      reason: noBody
        ? 'This request has no response body to save (it failed, is still loading, or Chrome evicted it). Inspect it without --out.'
        : '--out needs an absolute path in an existing directory that is not a symlink and does not exist yet (or pass --overwrite).',
    };
  }
  // #577: a screenshot path whose parent is missing used to surface as raw ENOENT / Kind: unknown.
  if (lower.includes('output directory does not exist') || lower.includes('output path is not a directory')) {
    const missing = lower.includes('output directory does not exist');
    return {
      kind: 'usage',
      strategy: 'create-output-directory',
      run: cmd ? `cdp help ${commandCatalogName(cmd)}` : 'cdp help shot',
      reason: missing
        ? 'The output directory does not exist. Create it, then rerun. A relative path is resolved from the directory where you ran the command.'
        : 'That output path is not a directory. Choose a file inside a directory. A relative path is resolved from the directory where you ran the command.',
    };
  }
  if (
    lower.includes('unknown option')
    || lower.includes('unknown argument')
    || lower.includes('unknown flag')
    // #536: every `emulate:` parse error (a bad value, off/status with a setting) is a typing mistake.
    || (cmd === 'emulate' && lower.startsWith('emulate:'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd ? `cdp help ${cmd}` : 'cdp help',
      reason: 'The command received an unknown flag or argument. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'eval' || cmd === 'eval64' || cmd === 'call')
    && /syntaxerror|referenceerror|typeerror|evalerror|rangeerror|urierror/i.test(message)
  ) {
    let reason = 'The JavaScript expression threw. Fix the expression; the tab is still live.';
    if (cmd === 'eval' || cmd === 'eval64') {
      reason = /already been declared/i.test(message)
        ? 'That name is already declared in this script, or the page declared it in a scope this script shares. let, const, and class from an earlier eval end with that call. The tab is still live.'
        : 'The JavaScript expression threw. Each eval has its own let, const, and class scope and still returns the last expression. var and globalThis assignments stay on the tab. Fix the expression; the tab is still live.';
    }
    return {
      kind: 'eval',
      strategy: 'fix-expression',
      run: 'cdp help eval',
      reason,
    };
  }
  if (err?.code === 'pdf_viewer' || lower.includes('pdf viewer') || lower.includes('application/pdf')) {
    return {
      kind: 'pdf-viewer',
      strategy: 'do-not-probe-ax',
      run: `cdp eval ${target} "document.contentType"`,
      reason: 'Chrome PDF viewer has no accessibility tree. text/perceive cannot extract the PDF body.',
    };
  }
  if (
    lower.includes('target closed') ||
    lower.includes('target destroyed') ||
    lower.includes('inspector.detached') ||
    lower.includes('detached from target') ||
    lower.includes('no target with given id') ||
    lower.includes('session closed') ||
    lower.includes('page, context or browser has been closed')
  ) {
    return {
      kind: 'target-closed',
      strategy: 'rediscover-target',
      run: 'cdp list',
      then: 'cdp open https://example.com',
      reason: 'The tab target appears to be closed, detached, or no longer present in Chrome.',
    };
  }
  if (lower.includes('stale daemon')) {
    const staleTarget = targetPrefix || String(message || '').match(/stale daemon for\s+([A-Za-z0-9_-]+)/i)?.[1] || '<target>';
    return {
      kind: 'stale-daemon',
      strategy: 'restart-target-daemon',
      run: `cdp stop ${staleTarget}`,
      then: 'rerun the original command',
      reason: `The per-target daemon was started from an older checkout or cannot report metadata; restart it before using this target. Use ${ALLOW_STALE_DAEMON_FLAG} only for intentional long-running daemon sessions.`,
    };
  }
  if (
    lower.includes('connection closed before response') ||
    lower.includes('econnrefused') ||
    lower.includes('connect enoent') ||
    lower.includes('connect econnreset') ||
    lower.includes('timed out connecting to daemon socket') ||
    lower.includes('daemon failed to start') ||
    lower.includes('ipc timeout')
  ) {
    return {
      kind: 'daemon-disconnect',
      strategy: 'restart-tab-daemon',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'The per-tab daemon did not return a usable response.',
    };
  }
  if (lower.includes('unknown command')) {
    const guessed = String(message || '').match(/unknown command:\s*(\S+)/i)?.[1]
      || cmd
      || '';
    const suggestions = suggestCommands(guessed);
    if (suggestions.length) {
      return {
        kind: 'usage',
        strategy: 'suggest-command',
        run: `cdp ${suggestions[0]}`,
        reason: `Did you mean: ${suggestions.join(' / ')}? Run \`cdp help ${suggestions[0]}\` for usage.`,
      };
    }
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help',
      reason: 'The command name does not match the registered CLI commands.',
    };
  }
  if ((cmd === 'nav' || cmd === 'navigate') && lower.includes('url required')) {
    return {
      kind: 'navigation',
      strategy: 'provide-url',
      run: `cdp nav ${target} https://example.com`,
      reason: 'Navigation commands need an explicit http or https URL.',
    };
  }
  if (cmd && lower.includes('required')) {
    return {
      kind: 'usage',
      strategy: 'provide-required-argument',
      run: commandUsageTemplate(cmd, targetPrefix),
      reason: 'The command is missing required input; provide the required argument instead of retrying unchanged.',
    };
  }
  if (
    (cmd === 'waitfor' && (lower.includes('timeout') || lower.includes('not found within') || lower.includes('still present') || lower.includes('did not stabilise')))
    || /timeout:\s*.+\bnot found within\b/i.test(message)
    || /timeout:\s*.+\bstill present after\b/i.test(message)
    || /timeout:\s*.+\bdid not stabilise\b/i.test(message)
  ) {
    return {
      kind: 'timeout',
      strategy: 'adjust-wait',
      run: 'cdp help waitfor',
      reason: 'The wait condition was not met before the timeout. Increase the bound or use --text / --any-of; the tab is still live.',
    };
  }
  if (
    lower.includes('assertion failed')
    || (cmd === 'flow' && lower.includes('flow halted') && lower.includes('assert'))
  ) {
    return {
      kind: 'assertion',
      strategy: 'inspect-assertion',
      run: 'cdp help flow',
      reason: 'A flow assertion did not hold. The page is still live; inspect the selector or text, or run perceive.',
    };
  }
  if (lower.includes('unknown wait:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'flow wait accepts "dom stable", "network idle", or a millisecond count such as wait 2000. Print usage instead of probing status.',
    };
  }
  if (lower.includes('flow: unquoted \\;')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'An unquoted \\; before a command name keeps a semicolon and swallows the next step. Quote the value, or run cdp help flow.',
    };
  }
  if (lower.includes('flow: unclosed quote') || lower.includes('flow: dangling escape')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'Close the quote, or use a different quote kind, for example type "\'twas".',
    };
  }
  if (lower.includes('batch --parallel:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help batch',
      reason: 'batch --parallel only runs read-only/extraction commands. Use sequential batch or flow for mutations.',
    };
  }
  if (
    cmd === 'loadall'
    && (
      lower.includes('still present')
      || lower.includes('aborted')
      || (lower.includes('timeout') && !lower.includes('element not found'))
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'show-help',
      run: 'cdp help loadall',
      reason: 'loadall stopped before the control disappeared. [interval-ms] is the click interval; pass --timeout-ms to raise the cap.',
    };
  }
  if (
    (cmd === 'loadall' || cmd === 'click' || cmd === 'jsclick')
    && (lower.includes('element not found') || lower.includes('css selector required'))
  ) {
    return {
      kind: cmd === 'loadall' && lower.includes('css selector required') ? 'usage' : 'selector',
      strategy: cmd === 'loadall' && lower.includes('css selector required') ? 'show-help' : 'refresh-perception',
      run: lower.includes('css selector required')
        ? 'cdp help loadall'
        : (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : 'cdp help loadall'),
      reason: 'No current element matched the selector. A missing load-more control is not a successful disappear.',
    };
  }
  if (cmd === 'hover' && lower.includes('the hover was not delivered')) {
    const selector = String(args?.[0] || '').trim();
    const hidden = lower.includes('visibilitystate is hidden');
    const arg = selector ? recoveryCommandArg(selector) : '<sel|@ref>';
    const run = hidden
      ? `CDP_BACKGROUND=0 cdp hover ${target} ${arg}`
      : `cdp perceive ${target} -C -d 8`;
    return {
      kind: 'hover-not-delivered',
      strategy: hidden ? 'activate-tab' : 'refresh-perception',
      run,
      reason: hidden
        ? 'The tab is hidden, so the target did not match :hover. CDP_BACKGROUND=0 activates that tab before hover and does not raise a covered window.'
        : 'The target did not match :hover after the mouse move. Refresh perception and choose the control again.',
    };
  }
  if (lower.includes('cross-origin frame received no')) {
    return {
      kind: 'no-input-events',
      strategy: 'inspect-child-frame',
      run: targetPrefix ? `cdp shot ${targetPrefix}` : 'cdp help shot',
      reason: 'The cross-origin frame was probed and received no mouse or click events. Inspect it with shot; do not repeat the click.',
    };
  }
  if (lower.includes('has no clickable box')) {
    const selector = String(err?.noClickBox?.selector || args?.[0] || '').trim();
    const arg = selector ? recoveryCommandArg(selector) : '';
    return {
      kind: 'no-click-box',
      strategy: 'use-jsclick',
      run: (targetPrefix && arg) ? `cdp jsclick ${target} ${arg}` : `cdp perceive ${target} -C -d 8`,
      reason: 'The target has no positive-size box inside the viewport, so no mouse click was sent.',
    };
  }
  if (cmd === 'press' && lower.includes('was not delivered') && lower.includes('no keydown')) {
    const hidden = lower.includes('visibilitystate is hidden');
    const key = String(err?.pressNotDelivered?.key || args?.[0] || '').trim();
    const keyArg = key ? recoveryCommandArg(key) : '';
    return {
      kind: 'press-not-delivered',
      strategy: 'confirm-key-delivery',
      run: hidden
        ? `CDP_BACKGROUND=0 cdp press ${target}${keyArg ? ` ${keyArg}` : ''}`
        : `cdp perceive ${target} -C -d 8`,
      reason: hidden
        ? 'The tab is hidden, so the keydown was not delivered. CDP_BACKGROUND=0 activates the tab and does not raise a covered window.'
        : 'The key was not delivered. The page received no keydown.',
    };
  }
  if (
    lower.includes('received no mousedown/click events')
    || (lower.includes('mouse path failed closed') && lower.includes('jsclick'))
  ) {
    const selector = jsclickSelectorFromCliError(message, { cmd, args, err });
    return {
      kind: 'no-input-events',
      strategy: 'use-jsclick',
      run: (targetPrefix && selector)
        ? `cdp jsclick ${targetPrefix} ${recoveryCommandArg(selector)}`
        : 'cdp help click',
      reason: lower.includes('visibilitystate is hidden')
        ? 'The tab is hidden (window covered or minimised): Input.* events are dropped. Use jsclick, or bring the window to the front. For a background tab, CDP_BACKGROUND=0 on the command activates it first; that does not raise a window other windows cover. Do not treat dispatch.ok as success.'
        : 'The realistic mouse click did not deliver page events. Retry with jsclick instead of treating dispatch.ok as success.',
    };
  }
  if (lower.includes('did not navigate') || (lower.includes('try jsclick') && lower.includes('<a href'))) {
    return {
      kind: 'no-navigation',
      strategy: 'use-jsclick',
      run: targetPrefix ? `cdp jsclick ${targetPrefix} a` : 'cdp help click',
      reason: 'The realistic mouse click dispatched but the link default action did not run.',
    };
  }
  // #527: CdpClient.send rejects with exactly `Timeout: <Domain.method>` when CDP never answers;
  // the whole message must be that (after Error: wrappers), so page errors that merely contain it do not match.
  const cdpTimeoutMethod = String(message || '').trim()
    .match(/^(?:[A-Za-z]*Error:\s*)*Timeout:\s+([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)$/)?.[1];
  if (cdpTimeoutMethod) {
    if (['eval', 'eval64', 'call'].includes(cmd) && /^Runtime\.(?:evaluate|callFunctionOn)$/.test(cdpTimeoutMethod)) {
      return {
        kind: 'timeout',
        strategy: 'poll-in-page',
        run: `cdp eval ${target} --fire-and-forget "<start the work; store progress on window>"`,
        then: `cdp eval ${target} "<read the progress from window>"`,
        reason: `${cmd} waits at most ${TIMEOUT / 1000} s for its value or Promise. Start long work with eval --fire-and-forget, keep progress on window, then poll it with a short eval; the tab is still live.`,
      };
    }
    return targetPrefix ? {
      kind: 'timeout',
      strategy: 'inspect-status',
      run: `cdp status ${targetPrefix}`,
      reason: `CDP did not answer ${cdpTimeoutMethod} in time: the page may be busy (long task), blocked by a dialog, or hung. Check status before retrying.`,
    } : {
      kind: 'timeout',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: `CDP did not answer ${cdpTimeoutMethod} in time: the browser may be busy or hung. Check browser setup before retrying.`,
    };
  }
  return lower.includes('target/document readiness mismatch') ? perceiveReadinessRecovery(target)
    : targetPrefix ? {
        kind: 'unknown',
        strategy: 'inspect-status',
        run: `cdp status ${targetPrefix}`,
        reason: `The ${cmd ? `${cmd} ` : ''}failure was not classified; the Error line is the raw cause. Inspect the target status before retrying.`,
      }
    : {
        kind: 'unknown',
        strategy: 'run-doctor',
        run: 'cdp doctor',
        reason: 'The failure was not classified; check browser setup and available targets.',
      };
}

function buildCliErrorModel(err, { cmd = '', targetPrefix = '', platform = process.platform, args = [] } = {}) {
  const completionUnknown = err?.code === 'DAEMON_COMPLETION_UNKNOWN'
    && err?.completion === 'unknown'
    && err?.sideEffectMayHaveOccurred === true;
  const message = completionUnknown
    ? 'The daemon did not return a validated Action Result. The action may have taken effect; do not repeat it until page state is verified.'
    : cliErrorMessage(err);
  const target = targetPrefix || '<target>';
  const recovery = completionUnknown
    ? {
        kind: 'ambiguous-action-completion',
        strategy: 'verify-before-retry',
        run: `cdp perceive ${target} -C -d 8`,
        reason: 'The action may have occurred. Inspect current page state first; do not repeat the action until its effect is verified.',
      }
      : buildCliErrorRecovery(message, { cmd, targetPrefix, platform, err, args });
  const nextSteps = [];
  const commandSteps = Array.isArray(recovery.commands) && recovery.commands.length
    ? recovery.commands.map(command => command?.command).filter(Boolean)
    : [recovery.run, recovery.then];
  for (const step of commandSteps) {
    if (step && !nextSteps.includes(step)) nextSteps.push(step);
  }
  const model = {
    schema: 'chrome-cdp-ex.cli-error.v1',
    ok: false,
    command: cmd || null,
    targetPrefix: targetPrefix || null,
    error: { message },
    recovery,
    nextSteps,
  };
  if (err?.code === 'cdp_unreachable' || recovery.strategy === 'relaunch-same-profile' || recovery.strategy === 'enable-existing-debugging') {
    if (err?.code === 'cdp_unreachable' || /cannot reach cdp/i.test(message)) {
      model.error.code = 'cdp_unreachable';
      model.host = err?.host || null;
      model.port = err?.port || null;
      model.profileDir = err?.profileDir ?? null;
      model.relaunch = err?.relaunch ?? null;
    }
  }
  if (err?.code === 'cdp_profile_in_use' || err?.code === 'cdp_not_found') {
    model.error.code = err.code;
    model.host = err.host || null;
    model.port = err.port || null;
    model.profileDir = err.profileDir ?? null;
    model.relaunch = null;
    if (err.code === 'cdp_profile_in_use') {
      model.pid = err.pid ?? null;
      model.livePort = err.livePort ?? null;
    }
  }
  if (completionUnknown) {
    model.completion = 'unknown';
    model.sideEffectMayHaveOccurred = true;
    model.retrySafe = false;
    model.diagnostics = {
      transport: {
        phase: err.transportCause?.phase || 'awaiting-response',
        kind: err.transportCause?.kind || 'unknown',
        message: String(err.transportCause?.message || 'unknown transport failure').slice(0, 512),
        ...(err.transportCause?.code ? { code: String(err.transportCause.code).slice(0, 64) } : {}),
      },
    };
  }
  return model;
}

function formatCliError(err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform, args = [] } = {}) {
  if (format === 'json') return formatJson(buildCliErrorModel(err, { cmd, targetPrefix, platform, args }));
  if (err?.code === 'DAEMON_COMPLETION_UNKNOWN') {
    const model = buildCliErrorModel(err, { cmd, targetPrefix, platform, args });
    return [
      `Error: ${model.error.message}`,
      'Completion: unknown',
      'Side effect may have occurred: yes',
      'Retry safe: no',
      ...formatCliErrorRecovery(model.recovery),
      `Transport: ${model.diagnostics.transport.phase}/${model.diagnostics.transport.kind}: ${model.diagnostics.transport.message}`,
      ...formatNextClosingLines(model.recovery),
    ].join('\n');
  }
  const message = String(err?.message || err || '').trim();
  if (!message) {
    const recovery = buildCliErrorRecovery('unknown failure', { cmd, targetPrefix, platform, args });
    return ['Error: unknown failure', ...formatCliErrorRecovery(recovery), ...formatNextClosingLines(recovery)].join('\n');
  }
  // With `text`, classify that part alone: the err object still carries the whole message.
  const recoveryFor = (text = null) => buildCliErrorRecovery(text ?? message, { cmd, targetPrefix, platform, err: text == null ? err : null, args });
  if (isClassifiedActionFailureText(message)) return withKindOnLastNextLine(message, recoveryFor);
  const lines = [message.startsWith('Error:') ? message : `Error: ${message}`];
  if (/^Next:/m.test(message)) return withKindOnLastNextLine(lines.join('\n'), recoveryFor);

  const recovery = recoveryFor();
  lines.push(...formatCliErrorRecovery(recovery));
  lines.push(...formatNextClosingLines(recovery));
  return lines.join('\n');
}

function formatDaemonCommandError(err, options = {}) {
  const model = options.format === 'json' && options.cmd === 'flow'
    ? maybeParseJson(cliErrorMessage(err))
    : null;
  if (model?.schema === 'chrome-cdp-ex.flow.v1' && model.halted === true) {
    return formatJson(model);
  }
  return formatCliError(err, options);
}

async function waitForOpenReady(targetId, {
  timeoutMs = DEFAULT_OPEN_READY_TIMEOUT_MS,
  url = '',
  selector = null,
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
} = {}) {
  const timeout = Math.min(Math.max(timeoutMs, 0), 300000);
  if (timeout <= 0) {
    return { attempted: false, ok: false, reason: 'disabled', href: null, readyState: null, selector, selectorFound: false, timeoutMs: timeout };
  }
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (true) {
    const cdp = createCdp();
    try {
      const probeTimeoutMs = Math.min(1000, Math.max(100, deadline - Date.now()));
      await cdp.connect(await getWsUrlFn());
      const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, probeTimeoutMs);
      const result = await cdpDomains(cdp).Runtime.evaluate( {
        expression: openReadyProbeScript(selector),
        returnByValue: true,
        awaitPromise: false,
      }, attached.sessionId, probeTimeoutMs);
      if (result.exceptionDetails) {
        throw new Error(runtimeExceptionMessage(result.exceptionDetails));
      }
      const raw = result.result?.value ?? '{}';
      try {
        lastState = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        lastState = { href: null, readyState: String(raw || '').trim() || null };
      }
      const readyState = lastState?.readyState || null;
      const href = lastState?.href || null;
      const selectorReady = lastState?.selectorFound === true;
      const urlReady = !url || url === 'about:blank' || href === url;
      if (urlReady && selectorReady && /^(interactive|complete)$/.test(readyState || '')) {
        return { attempted: true, ok: true, href, readyState, selector, selectorFound: true, timeoutMs: timeout };
      }
    } catch (e) {
      lastState = { error: e.message || String(e) };
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return { attempted: true, ok: false, href: lastState?.href || null, readyState: lastState?.readyState || null, selector, selectorFound: lastState?.selectorFound === true, error: lastState?.error || null, timeoutMs: timeout };
}

async function waitForOpenTargetUrl(targetId, url, timeoutMs = 1000, {
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (!url || url === 'about:blank') return { ok: true, href: 'about:blank' };
  const deadline = now() + Math.max(0, timeoutMs);
  let lastHref = null;
  let lastError = null;
  while (now() <= deadline) {
    const cdp = createCdp();
    try {
      await cdp.connect(await getWsUrlFn());
      const { targetInfos } = await cdpDomains(cdp).Target.getTargets( {}, undefined, Math.min(1000, Math.max(100, deadline - now() + 100)));
      const target = (targetInfos || []).find(t => t.targetId === targetId);
      lastHref = target?.url || null;
      if (lastHref === url) return { ok: true, href: lastHref };
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(100, remainingMs));
  }
  return { ok: false, href: lastHref, error: lastError };
}

async function navigateOpenTarget(targetId, sp, url, {
  createCdp = () => new CDP(),
  // The open path already passed the CDP_ISOLATED_ONLY gate; readiness polls skip the profile lookup.
  getWsUrlFn = discoverWsUrl,
  waitForOpenTargetUrlFn = waitForOpenTargetUrl,
  connectToSocketFn = connectToSocket,
  sendCommandFn = sendCommand,
  background = isBackgroundMode(),
  createdUrl = OPEN_CREATED_TARGET_URL,
  navigationRequested = openTargetNavigationRequested(createdUrl),
} = {}) {
  if (!url || url === 'about:blank') return { attempted: false, ok: true, reason: 'about:blank' };
  const attempts = [];
  // #644, same class as #339: do not poll for a condition this step has not caused.
  // A blank tab cannot already equal the requested URL, so look once and do not sleep.
  // One observation still accepts a target created directly at that URL. The 1500 ms
  // poll remains only when navigation was already requested and the URL has not landed.
  const initialTimeoutMs = navigationRequested ? 1500 : 0;
  const initialUrl = await waitForOpenTargetUrlFn(targetId, url, initialTimeoutMs);
  if (initialUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.createTarget', href: initialUrl.href, error: null };
  }
  const cdp = createCdp();
  try {
    await cdp.connect(await getWsUrlFn());
    if (!background) await cdpDomains(cdp).Target.activateTarget( { targetId }, undefined, 5000).catch(() => {});
    const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, 5000);
    const sid = attached.sessionId;
    await cdpDomains(cdp).Page.enable( {}, sid, 2000).catch(() => {});
    try {
      const nav = await cdpDomains(cdp).Page.navigate( { url }, sid, 5000);
      if (nav?.errorText) throw new Error(nav.errorText);
      return { attempted: true, ok: true, method: 'Page.navigate', error: null };
    } catch (e) {
      attempts.push({ method: 'Page.navigate', error: e.message || String(e) });
    }
    try {
      await cdpDomains(cdp).Runtime.evaluate( {
        expression: openNavigationScript(url),
        returnByValue: false,
        awaitPromise: false,
      }, sid, 5000);
      return { attempted: true, ok: true, method: 'Runtime.evaluate location.assign', error: null, attempts };
    } catch (e) {
      attempts.push({ method: 'Runtime.evaluate location.assign', error: e.message || String(e) });
    }
  } catch (e) {
    attempts.push({ method: 'direct-cdp', error: e.message || String(e) });
  } finally {
    try { cdp.close(); } catch {}
  }

  const afterDirectUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
  if (afterDirectUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDirectUrl.href, attempts, error: null };
  }

  let conn = null;
  try {
    conn = await connectToSocketFn(sp);
    const resp = await sendCommandFn(conn, { cmd: 'eval', args: [openNavigationScript(url)] });
    return {
      attempted: true,
      ok: resp.ok === true,
      method: 'daemon eval location.assign',
      attempts,
      error: resp.ok ? null : (resp.error || 'navigation failed'),
    };
  } catch (e) {
    attempts.push({ method: 'daemon eval location.assign', error: e.message || String(e) });
    const afterDaemonUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
    if (afterDaemonUrl.ok) {
      return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDaemonUrl.href, attempts, error: null };
    }
    return { attempted: true, ok: false, method: 'daemon eval location.assign', attempts, error: e.message || String(e) };
  } finally {
    try { conn?.end(); } catch {}
  }
}

function formatOpenAutoPerceiveFailure(err, targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Auto-perceive failed after the tab was attached.',
    formatCliError(err, { cmd: 'perceive', targetPrefix: target }),
  ].join('\n');
}

function cdpRuntimeIdentity(processLike = process) {
  return Object.freeze({
    execPath: processLike.execPath,
    scriptPath: fileURLToPath(import.meta.url),
  });
}

export async function executeCdpCli(command, { runMain = main, hostProcess = process } = {}) {
  const argv = [...command];
  let stdout = '';
  let stderr = '';
  const write = channel => (chunk, encoding, callback) => {
    if (typeof encoding === 'function') callback = encoding;
    if (channel === 'stdout') stdout += String(chunk);
    else stderr += String(chunk);
    callback?.();
    return true;
  };
  const cliProcess = Object.create(hostProcess);
  Object.defineProperties(cliProcess, {
    argv: { value: [hostProcess.execPath, fileURLToPath(import.meta.url), ...argv], writable: true },
    env: { value: hostProcess.env, writable: true },
    exitCode: { value: 0, writable: true },
    stdout: { value: Object.freeze({ write: write('stdout') }) },
    stderr: { value: Object.freeze({ write: write('stderr') }) },
    exit: { value: code => { throw new CliExitSignal(code); } },
  });
  const cliConsole = Object.freeze({
    log: (...values) => { stdout += `${formatValue(...values)}\n`; },
    error: (...values) => { stderr += `${formatValue(...values)}\n`; },
  });
  let code = 0;
  try {
    await runMain({ argv, process: cliProcess, console: cliConsole, usageVia: 'mcp' });
    code = Number(cliProcess.exitCode) || 0;
  } catch (error) {
    if (error instanceof CliExitSignal) {
      code = error.code;
    } else {
      const [cmd, ...args] = argv;
      cliConsole.error(formatCliError(error, { cmd, format: detectCliErrorFormat(args) }));
      code = 1;
    }
  }
  const normalized = { code, stdout: stdout.trim(), stderr: stderr.trim() };
  if (normalized.code === 0
    && !classifyCommandResultSemantics(normalized, { command: command[0] }).ok) {
    normalized.code = 1;
  }
  return normalized;
}

function emitTargetCommandResponse(response, {
  cmd,
  targetPrefix,
  args = [],
  format = 'text',
  targetResolution = null,
  console = globalThis.console,
  process = globalThis.process,
} = {}) {
  if (targetResolution?.status === 'followed-url' || targetResolution?.followedUrl === true) {
    const from = targetResolution.requestedTargetPrefix || targetPrefix || '';
    const to = targetResolution.successorPrefix || String(targetResolution.resolvedTargetId || '').slice(0, 8);
    console.error(`Re-bound target ${from} to ${to} (same URL and title).`);
  }
  const hasResult = response?.result !== undefined
    && response?.result !== null
    && response.result !== '';
  if (hasResult) {
    let output = format === 'json' && targetResolution
      && !isDeterministicTableContinuationResult(cmd, response.result)
      ? attachTargetResolutionDiagnostics(response.result, targetResolution)
      : response.result;
    if (cmd === 'table' && !isDeterministicTableContinuationResult(cmd, response.result)) {
      output = format === 'json'
        ? boundedTableObservationEmissionJson(output)
        : boundedTableObservationEmissionText(output);
    }
    const notice = typeof response?.restartNotice === 'string' ? response.restartNotice : '';
    if (notice) {
      console.log(notice);
      if (output === notice) return;
      const prefix = `${notice}\n`;
      if (typeof output === 'string' && output.startsWith(prefix)) output = output.slice(prefix.length);
    }
    // #466: present only when CDP_CONTENT_BOUNDARIES=1 asked the daemon for it.
    console.log(isContentBoundary(response?.contentBoundary)
      ? wrapContentBoundary(output, response.contentBoundary, { format })
      : output);
    const semantics = classifyCommandResultSemantics(
      { ok: response?.ok === true, result: output },
      { command: cmd },
    );
    if (response?.ok === false || !semantics.ok) process.exitCode = 1;
    return;
  }
  if (response?.ok === false) {
    const notice = typeof response?.restartNotice === 'string' ? response.restartNotice : '';
    if (notice) console.log(notice);
    let error = response.error;
    const prefix = notice ? `${notice}\n` : '';
    if (prefix && typeof error === 'string' && error.startsWith(prefix)) error = error.slice(prefix.length);
    // The arguments let a recovery rerun the same command (#488 hidden-tab).
    console.error(formatDaemonCommandError(error, { cmd, targetPrefix, format, args }));
    process.exitCode = 1;
  }
}

async function main(options = {}) {
  const process = options.process || globalThis.process;
  const console = options.console || globalThis.console;
  const finish = code => options.process ? (process.exitCode = code) : process.exit(code);
  const runtimeIdentity = cdpRuntimeIdentity(process);
  const applicationPreflight = preflightDaemonApplication();
  ensureRuntimeDir();
  const exitCliError = (err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform } = {}) => {
    console.error(formatCliError(err, { cmd, targetPrefix, format, platform }));
    process.exit(1);
  };
  let [cmd, ...args] = options.argv || process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0], applicationPreflight); return; }
  // #532: opt-in local usage counter (CDP_USAGE_LOG=1); command name only, never its arguments.
  recordCommandUsage(cmd, { env: process.env, via: options.usageVia || 'cli' });

  // #466: opt-in session policy. Read on every run, refused before anything else when invalid.
  let sessionPolicy = null;
  try {
    sessionPolicy = readSessionPolicy(process.env);
  } catch (e) {
    console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
    return finish(1);
  }
  const deniedCommand = deniedCommandMessage(sessionPolicy, cmd, args);
  if (deniedCommand) {
    const deniedTarget = NEEDS_TARGET.has(cmd) && args[0] && !String(args[0]).startsWith('-') ? args[0] : '';
    console.error(formatCliError(deniedCommand, {
      cmd: commandMeta(cmd)?.name || cmd,
      targetPrefix: deniedTarget,
      format: detectCliErrorFormat(args),
    }));
    return finish(1);
  }

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(helpStr()); return finish(0);
  }
  if (cmd === 'help') {
    try {
      console.log(args[0] ? helpTopicStr(args[0]) : helpStr());
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'help' }));
      return finish(1);
    }
  }

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls' || cmd === 'tabs') {
    const listOpts = parseListArgs(args);
    if (listOpts.unknown) {
      console.error(formatCliError(`list: unknown argument ${listOpts.unknown}`, { cmd, format: listOpts.format }));
      return finish(1);
    }
    let pages = isolatedOnlyEnabled() ? null : await listPagesFromMatchingDaemon();
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      await cdp.connect(await getWsUrl());
      try { await rememberLiveCdpEndpointFromSession(cdp); } catch {}
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    const aliasStore = readTargetAliases();
    console.log(formatPageListOutput(pages, _browserInfo, {
      format: listOpts.format,
      aliases: aliasStore.aliases,
      unsafeFull: listOpts.unsafeFull,
    }));
    await new Promise(resolveWrite => process.stdout.write('', resolveWrite));
    return finish(0);
  }

  // tab-group management (no target required)
  if (cmd === 'tab-group' || cmd === 'tabgroup') {
    try {
      const opts = parseTabGroupArgs(args);
      let store = readTabGroups();
      if (opts.action === 'list') {
        console.log(formatTabGroupStore(store, { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'create') {
        const [name, ...members] = opts.args;
        if (!name) throw new Error('tab-group create: name required');
        const liveTargetIds = listKnownLiveTargetIds();
        store = upsertTabGroup(store, {
          name,
          members: resolveTabGroupMembers(members, { targetIds: liveTargetIds }),
        });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'add') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group add: name and target required');
        store = upsertTabGroup(store, {
          name,
          members: resolveTabGroupMembers([member], { targetIds: listKnownLiveTargetIds() }),
        });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'remove') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group remove: name and target required');
        store = removeTabGroupMember(store, name, member);
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'delete') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group delete: name required');
        store = deleteTabGroup(store, name);
        writeTabGroups(store);
        console.log(opts.format === 'json'
          ? formatJson({ schema: 'chrome-cdp-ex.tab-group-delete.v1', removed: normalizeTabGroupName(name) })
          : `Deleted tab group ${normalizeTabGroupName(name)}`);
        return finish(0);
      }
      if (opts.action === 'show') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group show: name required');
        const group = getTabGroup(store, name);
        if (!group) throw new Error(`tab-group: unknown group "${normalizeTabGroupName(name)}"`);
        console.log(formatTabGroup(group, { format: opts.format }));
        return finish(0);
      }
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'tab-group', format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // broadcast a command to every member of a tab-group
  if (cmd === 'broadcast') {
    try {
      const opts = parseBroadcastArgs(args);
      const group = getTabGroup(readTabGroups(), opts.groupName);
      if (!group) throw new Error(`broadcast: unknown group "${opts.groupName}"`);
      if (!group.members.length) throw new Error(`broadcast: group "${opts.groupName}" has no members`);
      const broadcastBlocked = policyPreflightMessage(sessionPolicy, opts.command, opts.commandArgs, {
        compositeSteps: policyCompositeSteps,
      });
      if (broadcastBlocked) throw new Error(broadcastBlocked);
      // #534: broadcast reuses tab daemons directly, so under CDP_ISOLATED_ONLY each member is checked
      // against its own endpoint and must be a tab of that checked browser.
      const assertIsolatedMember = isolatedOnlyEnabled() ? createIsolatedMemberGate() : null;
      if (assertIsolatedMember && group.members.some(member => !resolveTargetAlias(member)?.port)) await assertIsolatedMember.prime();
      const results = [];
      for (const member of group.members) {
        const entry = { target: member, targetPrefix: String(member).slice(0, 8), ok: false, result: null, error: null };
        try {
          // Resolve alias or prefix to a live target, then run via daemon IPC.
          let targetId = null;
          const alias = resolveTargetAlias(member);
          if (alias?.targetId) targetId = alias.targetId;
          else {
            const daemonIds = listDaemonSockets().map(d => d.targetId);
            const matches = daemonIds.filter(id => id.toUpperCase().startsWith(String(member).toUpperCase()));
            if (matches.length === 1) targetId = matches[0];
            else if (existsSync(PAGES_CACHE)) {
              const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
              targetId = resolvePrefix(member, pages.map(p => p.targetId), 'target');
            } else {
              throw new Error(`cannot resolve target ${member}; run cdp list`);
            }
          }
          entry.targetPrefix = targetPrefixForDisplay(targetId);
          if (assertIsolatedMember) await assertIsolatedMember(alias, targetId);
          const conn = await getOrStartTabDaemon(targetId, {
            env: aliasEnv(alias),
            ...runtimeIdentity,
          });
          const resp = await sendCommand(conn, {
            cmd: opts.command,
            args: opts.commandArgs,
            ...policyRequestFields(sessionPolicy, opts.command, { contentBoundary: false }),
          }, { targetId });
          try { conn.end(); } catch {}
          if (resp.ok) {
            entry.ok = true;
            entry.result = resp.result;
          } else {
            entry.error = resp.error || 'command failed';
          }
        } catch (e) {
          entry.error = e.message || String(e);
          if (e?.code === 'DAEMON_COMPLETION_UNKNOWN') {
            entry.completion = 'unknown';
            entry.sideEffectMayHaveOccurred = e.sideEffectMayHaveOccurred === true;
            entry.retrySafe = false;
            entry.transportCause = e.transportCause || null;
          }
        }
        results.push(entry);
      }
      const model = buildBroadcastModel({
        groupName: opts.groupName,
        command: opts.command,
        commandArgs: opts.commandArgs,
        results,
        fullResults: opts.fullResults,
      });
      console.log(opts.format === 'json' ? formatJson(model) : formatBroadcastResult(model));
      return finish(model.failed ? 1 : 0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'broadcast', format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // Target selection by URL/title (no target prefix required)
  if (cmd === 'target') {
    try {
      const opts = parseTargetSelectArgs(args);
      let pages = isolatedOnlyEnabled() ? null : await listPagesFromMatchingDaemon();
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      const selection = selectPageTarget(pages, opts);
      console.log(formatTargetSelect(selection, pages, { format: opts.format }));
      await new Promise(resolveWrite => process.stdout.write('', resolveWrite));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // Open new tab
  if (cmd === 'open') {
    const opts = parseOpenArgs(args);
    const url = opts.url;
    if (url !== 'about:blank') validateUrl(url);
    const openBlocked = navigationBlockedMessage(sessionPolicy, url, 'open');
    if (openBlocked) {
      console.error(formatCliError(openBlocked, { cmd: 'open', format: opts.format }));
      return finish(1);
    }

    // Reuse an existing tab with the same/similar URL when requested.
    if (opts.reuseUrl && url !== 'about:blank') {
      let pages = isolatedOnlyEnabled() ? null : await listPagesFromMatchingDaemon();
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      try {
        const selection = selectPageTarget(pages, { url, exact: false });
        const model = buildOpenModel({
          targetId: selection.targetId,
          url: selection.page.url || url,
          attached: true,
          navigation: { attempted: false, ok: true, method: 'reuse-url', href: selection.page.url || url },
          ready: { attempted: false, ok: true, reason: 'reused-existing-tab' },
          autoPerceive: { attempted: false, ok: false, reason: 'reuse-url' },
        });
        model.reused = true;
        if (opts.format === 'json') {
          console.log(formatJson(model));
          return;
        }
        console.log(`Reused existing tab: ${selection.targetPrefix}  ${selection.page.url || url}`);
        console.log(formatOpenNextPerceiveCommand(selection.targetId));
        return;
      } catch (e) {
        // Zero matches: fall through and open a new tab.
        // Ambiguous matches: fail closed so agents do not open yet another duplicate.
        if (/pages matched/i.test(e.message || '')) {
          console.error(formatCliError(e, { cmd: 'open', format: opts.format }));
          return finish(1);
        }
      }
    }

    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const targetId = await createOpenTarget(cdp, { background: opts.background });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    if (opts.format === 'text') {
      console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    }

    // Auto-attach: start daemon and wait for user to click "Allow debugging?"
    // The daemon itself removes a stale socket, and only after a probe (#458).
    const sp = sockPath(targetId);
    // An explicit mode belongs to this tab, so a daemon restarted later by a call that does not choose
    // one keeps it (#441, #488). The default needs no record.
    if (opts.backgroundExplicit) writeTabBackgroundMode(targetId, { background: opts.background });
    const child = spawn(runtimeIdentity.execPath, [runtimeIdentity.scriptPath, '_daemon', targetId], {
      detached: true,
      stdio: 'ignore',
      env: withoutSecretEnv(backgroundDaemonEnv(opts.background)),
    });
    child.unref();
    let attached = false;
    let announcedWait = false;
    let failedConnects = 0;
    const attachStartedAt = Date.now();
    const attachDeadline = attachStartedAt + opts.attachTimeoutMs;
    while (Date.now() < attachDeadline) {
      const remainingMs = attachDeadline - Date.now();
      try {
        const conn = await connectToSocket(sp, { timeoutMs: Math.min(DAEMON_ALLOW_DELAY, Math.max(1, remainingMs)) });
        conn.end();
        attached = true;
        break;
      } catch {
        failedConnects += 1;
        if (opts.format === 'text' && !announcedWait && shouldAnnounceOpenAttachWait({
          failedConnects,
          elapsedMs: Date.now() - attachStartedAt,
        })) {
          console.log(formatOpenAttachWaitMessage(opts.attachTimeoutMs));
          announcedWait = true;
        }
      }
      await sleep(Math.min(DAEMON_ALLOW_DELAY, remainingMs));
    }
    const navigation = attached
      ? await navigateOpenTarget(targetId, sp, url, {
          background: opts.background,
          createdUrl: OPEN_CREATED_TARGET_URL,
        })
      : { attempted: false, ok: false, reason: 'not-attached' };
    const ready = attached
      ? await waitForOpenReady(targetId, { timeoutMs: opts.readyTimeoutMs, url, selector: opts.readySelector })
      : { attempted: false, ok: false, reason: 'not-attached', timeoutMs: opts.readyTimeoutMs };
    if (opts.format === 'json') {
      console.log(formatJson(buildOpenModel({
        targetId,
        url,
        attached,
        navigation,
        ready,
        autoPerceive: attached
          ? { attempted: false, ok: false, reason: 'json-output' }
          : { attempted: false, ok: false, reason: 'not-attached' },
      })));
      return;
    }
    if (attached) {
      if (opts.perceive) {
        console.log(formatOpenReadyMessage(targetId, url));
        try {
          const conn = await connectToSocket(sp);
          const resp = await sendCommand(conn, { cmd: 'perceive', args: [], ...policyRequestFields(sessionPolicy, 'perceive') }, { targetId });
          conn.end();
          if (resp.ok && resp.result) {
            console.log('---\n' + (isContentBoundary(resp.contentBoundary)
              ? wrapContentBoundary(resp.result, resp.contentBoundary)
              : resp.result));
          }
        } catch (e) {
          console.error(formatOpenAutoPerceiveFailure(e, targetId));
        }
      } else {
        console.log(formatOpenNextPerceiveCommand(targetId));
      }
    } else {
      console.log(formatOpenTimeoutMessage(targetId));
    }
    return;
  }

  // Stop
  if (cmd === 'stop') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.includes('--help') || fopts.args.includes('-h')) {
      console.log(helpTopicStr('stop'));
      return finish(0);
    }
    if (fopts.args.length > 1) exitCliError(`stop: unknown argument ${fopts.args[1]}`, { cmd, format: fopts.format });
    try {
      const requested = fopts.args[0] === '--all' ? undefined : fopts.args[0];
      const result = await stopDaemons(requested);
      console.log(formatStopResult(result, { format: fopts.format }));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: fopts.format }));
      return finish(1);
    }
  }

  // Doctor / ready — one-call diagnostics, no target needed
  if (cmd === 'doctor' || cmd === 'ready') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) {
      console.error(formatCliError(`doctor: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format }));
      return finish(1);
    }
    const checks = await runDoctorChecks();
    console.log(formatDoctorOutput(checks, { format: fopts.format }));
    return finish(checks.some(check => check.status === 'FAIL') ? 1 : 0);
  }

  // spawn-debug-browser / spawn — launch isolated debug profile (no target)
  if (cmd === 'spawn-debug-browser' || cmd === 'spawn') {
    try {
      // #466: the start page is a navigation too.
      const spawnBlocked = navigationBlockedMessage(sessionPolicy, urlFlagValue(args), 'spawn-debug-browser');
      if (spawnBlocked) throw new Error(spawnBlocked);
      const out = await spawnDebugBrowserStr(args);
      console.log(out);
      return finish(0);
    } catch (e) {
      if (e?.code === 'help_requested') {
        console.log(helpTopicStr(e.helpTopic || 'spawn-debug-browser'));
        return finish(0);
      }
      console.error(formatCliError(e, { cmd }));
      return finish(1);
    }
  }

  if (cmd === 'attach' || cmd === 'use') {
    try {
      const parsed = parseAliasCommandArgs(args, cmd);
      const attachEnv = parsed.port ? {
        ...process.env,
        CDP_PORT: String(parsed.port),
        CDP_HOST: parsed.host || process.env.CDP_HOST || DEFAULT_CDP_HOST,
      } : null;
      if (parsed.port) {
        const check = await checkCdpReachability({ env: attachEnv, host: attachEnv.CDP_HOST });
        if (check.status === 'FAIL') {
          throw cdpUnreachableError({
            host: check.host || attachEnv.CDP_HOST,
            port: check.port || attachEnv.CDP_PORT,
            cause: check.detail,
            lastEndpoint: {
              host: check.host,
              port: check.port,
              profileDir: check.profileDir,
              exe: check.exe,
              browser: check.browser,
              history: check.candidates,
            },
          });
        }
      }
      const store = readTargetAliases();
      const next = await bindAndSaveTargetAlias(parsed, {
        store,
        env: process.env,
      });
      console.log(formatAliasRecord(next.aliases[normalizeAliasName(parsed.name)], { format: parsed.format }));
      return finish(0);
    } catch (e) {
      const format = detectCliErrorFormat(args);
      console.error(formatCliError(e, { cmd, format }));
      return finish(1);
    }
  }

  if (cmd === 'forget') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    const name = fopts.args[0];
    if (!name) exitCliError('forget requires an alias name', { cmd, format: fopts.format });
    try {
      const store = readTargetAliases();
      const { next, removed } = forgetTargetAlias(store, name);
      writeTargetAliases(next);
      console.log(fopts.format === 'json'
        ? formatJson({ schema: 'chrome-cdp-ex.alias-forget.v1', removed: removed.name, current: next.current })
        : `Forgot @${removed.name}`);
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: fopts.format }));
      return finish(1);
    }
  }

  if (cmd === 'current') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) exitCliError(`current: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format });
    console.log(formatCurrentAlias(readTargetAliases(), { format: fopts.format }));
    return finish(0);
  }

  // Targetless wait: avoids shell sleep policy for simple delays.
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && !args[1]) {
    try {
      console.log(await waitStr(args[0]));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'wait' }));
      return finish(1);
    }
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    const cliErrorFormat = detectCliErrorFormat(args);
    console.error(formatCliError(unknownCommandMessage(cmd), { cmd, format: cliErrorFormat }));
    return finish(1);
  }

  // Canonicalize aliases (key→press, resize→viewport, …) before daemon IPC.
  cmd = commandMeta(cmd)?.name || cmd;

  const targetCommandArgs = [...args];
  let allowStaleDaemon = process.env.CDP_ALLOW_STALE_DAEMON === '1';
  const allowStaleDaemonFlagIndex = targetCommandArgs.indexOf(ALLOW_STALE_DAEMON_FLAG);
  if (allowStaleDaemonFlagIndex !== -1) {
    allowStaleDaemon = true;
    targetCommandArgs.splice(allowStaleDaemonFlagIndex, 1);
  }

  let followUrl = false;
  try {
    const taken = takeFollowUrlFlag(cmd, targetCommandArgs);
    followUrl = taken.followUrl;
    targetCommandArgs.splice(0, targetCommandArgs.length, ...taken.args);
  } catch (error) {
    console.error(formatCliError(error, { cmd, format: detectCliErrorFormat(targetCommandArgs) }));
    return finish(1);
  }

  let { targetPrefix, cmdArgs } = parseTargetAndCommandArgs(cmd, targetCommandArgs);
  let cliErrorFormat = targetCommandCliErrorFormat(targetPrefix, cmdArgs, targetCommandArgs);
  if (
    targetPrefix === '--help'
    || targetPrefix === '-h'
    || cmdArgs.includes('--help')
    || cmdArgs.includes('-h')
    || targetCommandArgs.includes('--help')
    || targetCommandArgs.includes('-h')
  ) {
    console.log(helpTopicStr(cmd));
    return finish(0);
  }
  if (targetPrefix && String(targetPrefix).startsWith('--')) {
    try {
      const fopts = parseFormatArgs(targetCommandArgs, ['text', 'json']);
      cliErrorFormat = fopts.format;
      targetPrefix = fopts.args[0];
      cmdArgs = fopts.args.slice(1);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      return finish(1);
    }
  }
  if (targetPrefix && String(targetPrefix).startsWith('--')) {
    console.error(formatCliError(`${cmd}: target prefix is required`, { cmd, format: cliErrorFormat }));
    return finish(1);
  }
  if (!targetPrefix) {
    console.error(formatCliError('target ID required. Run "cdp list" first.', { cmd, format: cliErrorFormat }));
    return finish(1);
  }
  // #469: resolve --secret names here, before any daemon starts; values never join cmdArgs.
  let requestSecrets = null;
  try {
    requestSecrets = cliRequestSecrets(cmd, cmdArgs);
  } catch (error) {
    console.error(formatCliError(error, { cmd, targetPrefix, format: cliErrorFormat }));
    return finish(1);
  }
  // #466: a disallowed `nav` URL or a denied step fails here, before a daemon attaches; the
  // daemon checks again for the steps it runs.
  const policyBlocked = policyPreflightMessage(sessionPolicy, cmd, cmdArgs, { compositeSteps: policyCompositeSteps });
  if (policyBlocked) {
    console.error(formatCliError(policyBlocked, { cmd, targetPrefix, format: cliErrorFormat }));
    return finish(1);
  }

  // Resolve against live discovery before trusting daemon or cache state.
  const targetAlias = resolveTargetAlias(targetPrefix);
  if (!targetAlias && looksLikeAliasToken(targetPrefix)) {
    console.error(formatCliError(unknownAliasError(targetPrefix), { cmd, format: cliErrorFormat }));
    return finish(1);
  }
  // #538: the previous page list remembers the URL and title last seen for a prefix that may be gone.
  const lastSeenPages = readCachedPages();
  let livePages;
  let targetResolution;
  try {
    ({ livePages, targetResolution } = await resolvePageCommandTarget({
      targetPrefix,
      targetAlias,
      lastSeenPages,
      followUrl,
      onPages: livePages => writeFileSync(PAGES_CACHE, JSON.stringify(livePages), { mode: 0o600 }),
    }));
  } catch (error) {
    if (error?.code !== 'target_successor') throw error;
    // The recovery reruns this command, with its arguments, on the successor page.
    console.error(formatCliError(error, { cmd, targetPrefix, args: cmdArgs, format: cliErrorFormat }));
    return finish(1);
  }
  const targetId = targetResolution.resolvedTargetId;

  let rebound = false;
  let daemonAssessment = null;
  const browserIdentity = { kind: 'browser', id: 'browser-runtime', revision: 0 };
  const openTabDaemon = resolvedTargetId => getOrStartTabDaemon(resolvedTargetId, {
    env: aliasEnv(targetAlias),
    liveTargetPresent: livePages.some(page => page.targetId === resolvedTargetId),
    ...runtimeIdentity,
  });
  const runtimeSupervisor = createBrowserSupervisor({
    discover: async () => {
      const pages = targetAlias?.port
        ? livePages
        : await discoverLivePagesForTargetResolution();
      return buildExactTargetSupervisorCandidates(pages, targetId, browserIdentity);
    },
    endpointFor: resolvedTargetId => sockPath(resolvedTargetId),
    open: async (resolvedTargetId, endpoint) => ({
      targetId: resolvedTargetId,
      endpoint,
      initialConnection: await openTabDaemon(resolvedTargetId),
    }),
    inspect: async runtime => {
      if (allowStaleDaemon) return { boundTargetId: runtime.targetId, endpoint: runtime.endpoint };
      daemonAssessment = await assertFreshDaemonForCommand(runtime.initialConnection, {
        targetPrefix: targetPrefixForDisplay(runtime.targetId),
        expectedTargetId: runtime.targetId,
        currentMetadata: collectDaemonMetadata({ scriptPath: runtimeIdentity.scriptPath }),
      }, { reopen: () => openTabDaemon(runtime.targetId) });
      return {
        boundTargetId: daemonAssessment?.daemon?.boundTargetId || runtime.targetId,
        endpoint: runtime.endpoint,
      };
    },
    request: async (runtime, request) => {
      if (allowStaleDaemon && runtime.initialConnection) {
        const connection = runtime.initialConnection;
        runtime.initialConnection = null;
        return sendCommand(connection, request, { targetId: runtime.targetId });
      }
      return sendCommand(await connectToSocket(runtime.endpoint), request, { targetId: runtime.targetId });
    },
    stop: async resolvedTargetId => {
      const stopResult = await stopDaemons(resolvedTargetId);
      if (stopResult.failedTargets?.length) {
        const why = stopResult.results?.find(entry => entry.status === 'failed')?.reason || 'unknown reason';
        throw new Error(`daemon ${stopResult.failedTargets.join(', ')} did not stop: ${why}`);
      }
      await sleep(100);
      rebound = true;
    },
  });
  const runtimeHandle = await runtimeSupervisor.resolve(createLocatorPlan({
    schema: 'chrome-cdp-ex.locator-plan.v1',
    strategy: 'exact-target',
    value: targetId,
    scope: browserIdentity,
    fallbacks: [],
  }));
  if (cmd === 'eval') {
    try {
      cmdArgs = normalizeEvalCliArgs(cmdArgs);
    } catch (error) {
      exitCliError(error.message, { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'eval64') {
    const b64 = cmdArgs.join('').trim();
    if (!b64) exitCliError('base64 expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, b64);
  } else if (cmd === 'call') {
    const expr = cmdArgs.join(' ');
    if (!expr) exitCliError('expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, expr);
  } else if (cmd === 'click') {
    // The daemon keeps the working directory of the CLI that started it; send --out absolute (#472).
    cmdArgs = absolutizeExpectDownloadOut(cmdArgs);
  } else if (cmd === 'elshot') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('CSS selector required', { cmd, targetPrefix, format: cliErrorFormat });
    try {
      cmdArgs = absolutizeElshotFileArg(cmdArgs);
    } catch (error) {
      exitCliError(error.message, { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'type') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'fill') {
    const fillError = fillCliArgError(cmdArgs);
    if (fillError) exitCliError(fillError, { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) exitCliError('CDP method required', { cmd, targetPrefix, format: cliErrorFormat });
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'cookieset') {
    if (!cmdArgs[0]) exitCliError('cookie string required (e.g. "name=value; domain=.example.com")', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs[0] = cmdArgs.join(' '); // join in case of spaces in cookie string
  } else if (cmd === 'cookiedel') {
    if (!cmdArgs[0]) exitCliError('cookie name required', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'netlog') {
    cmdArgs = absolutizeNetlogOutArg(cmdArgs);
  } else if (cmd === 'upload') {
    if (!cmdArgs[0] || !cmdArgs[1]) exitCliError('CSS selector or @ref and file path(s) required', { cmd, targetPrefix, format: cliErrorFormat });
    // args[0] = selector, args[1] = comma-separated file paths (no join needed)
  } else if (cmd === 'batch') {
    const filtered = cmdArgs.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact');
    if (!filtered[0]) exitCliError('commands required (pipe syntax or JSON array)', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'flow') {
    const fopts = parseFormatArgs(cmdArgs, ['text', 'json']);
    if (!fopts.args[0]) exitCliError('flow steps required (semicolon-separated). Example: flow <target> "click @1; wait dom stable; summary"', { cmd, targetPrefix, format: cliErrorFormat });
    // Preserve multi-word/unquoted step recipes as one daemon argument.
    cmdArgs.splice(0, cmdArgs.length, ...formatArgSuffix(fopts.format), fopts.args.join(' '));
  } else if (cmd === 'replay') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('replay --json requires a record-actions JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('replay requires --file <path> or --json <record-actions-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'restore') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('restore --json requires a checkpoint JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('restore requires --file <path> or --json <checkpoint-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  }

  // The daemon keeps the cwd of whichever CLI started it. Send caller paths absolute (#577).
  try {
    cmdArgs = absolutizeCallerFileArgs(cmd, cmdArgs);
  } catch (error) {
    exitCliError(error.message, { cmd, targetPrefix, format: cliErrorFormat });
  }

  if (cmd === 'nav' || cmd === 'navigate') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('URL required', { cmd, targetPrefix, format: cliErrorFormat });
  }

  // An explicit foreground choice on this call brings a hidden tab forward first, even when its daemon
  // already runs in background mode (#488). Best effort: the command itself reports what it meets.
  const activation = foregroundActivationRequest();
  if (activation) {
    try { await runtimeSupervisor.execute(runtimeHandle, activation); } catch {}
  }

  let response;
  try {
    response = await runtimeSupervisor.execute(runtimeHandle, {
      cmd,
      args: cmdArgs,
      ...policyRequestFields(sessionPolicy, cmd, { args: cmdArgs }),
      ...(requestSecrets ? { secrets: requestSecrets } : {}),
    });
  } catch (error) {
    console.error(formatCliError(error, { cmd, targetPrefix: targetPrefixForDisplay(targetId), format: cliErrorFormat, args: cmdArgs }));
    return finish(1);
  }
  targetResolution = completeTargetResolution(targetResolution, {
    boundTargetId: daemonAssessment?.daemon?.boundTargetId || targetId,
    rebound,
  });

  emitTargetCommandResponse(response, {
    cmd,
    targetPrefix,
    args: cmdArgs,
    format: cliErrorFormat,
    targetResolution,
    console,
    process,
  });
}

function perceiveReadinessRecovery(target) {
  return {
    kind: 'loading',
    strategy: 'retry-perceive',
    run: `cdp perceive ${target} -C -d 8`,
    reason: 'Target metadata advertises an HTTP(S) page, but the renderer stayed blank through bounded readiness sampling. Retry perceive without navigating.',
  };
}

const PERCEIVE_READINESS_DELAYS_MS = Object.freeze([0, 250, 500, 1000]);

async function readPerceiveTargetMetadata(cdp, targetId) {
  const pages = await getPages(cdp);
  return pages.find(page => page.targetId === targetId) || null;
}

async function readPerceiveDocumentState(cdp, sid) {
  const value = await evalStr(
    cdp,
    sid,
    'JSON.stringify({ url: window.location.href, readyState: document.readyState })',
    false,
    { timeoutMs: STATUS_PAGE_INFO_TIMEOUT },
  );
  const state = JSON.parse(value);
  return {
    url: String(state?.url || ''),
    readyState: String(state?.readyState || 'unknown'),
  };
}

async function ensurePerceiveTargetReady({ cdp, sessionId, targetId, ops = {} }) {
  const readTargetMetadata = ops.readPerceiveTargetMetadata || readPerceiveTargetMetadata;
  const readDocumentState = ops.readPerceiveDocumentState || readPerceiveDocumentState;
  const sampleDelaysMs = ops.perceiveReadinessDelaysMs || PERCEIVE_READINESS_DELAYS_MS;
  const wait = ops.sleep || sleep;
  const now = ops.now || Date.now;
  let target;
  try {
    target = await readTargetMetadata(cdp, targetId);
  } catch {
    return;
  }
  const advertisedUrl = String(target?.url || '').trim();
  if (!/^https?:\/\//i.test(advertisedUrl)) return;

  const delays = Array.isArray(sampleDelaysMs) && sampleDelaysMs.length
    ? sampleDelaysMs
    : PERCEIVE_READINESS_DELAYS_MS;
  const startedAt = now();
  let observed = { url: '', readyState: 'unknown' };
  for (let index = 0; index < delays.length; index++) {
    const delayMs = Math.max(0, Number(delays[index]) || 0);
    if (delayMs > 0) await wait(delayMs);
    observed = await readDocumentState(cdp, sessionId);
    if (!isBlankPageUrl(observed?.url)) return;
  }

  const observedUrl = String(observed?.url || '');
  const readyState = String(observed?.readyState || 'unknown');
  throw new Error(
    'perceive: target/document readiness mismatch; ' +
    `targetId=${targetId}; requestedTargetId=${targetId}; resolvedTargetId=${targetId}; ` +
    `boundTargetId=${targetId}; advertisedUrl=${advertisedUrl}; observedUrl=${observedUrl}; ` +
    `readyState=${readyState}; attempts=${delays.length}/${delays.length}; elapsedMs=${Math.max(0, now() - startedAt)}. ` +
    'The target metadata advertises a loaded HTTP(S) page while its renderer is still blank; retry the same perceive command.'
  );
}

// #594: a main-frame navigation cuts console and exception reads to the document
// that just committed. The ring still holds earlier entries so an action delta
// can report a throw that landed after its baseline and before the commit.
const documentCutSeqs = new WeakMap();

function consoleDocumentEntries(buf) {
  if (typeof buf?.since === 'function' && documentCutSeqs.has(buf)) return buf.since(documentCutSeqs.get(buf) || 0);
  if (typeof buf?.all === 'function') return buf.all();
  return [];
}

function consoleDocumentSince(buf, seq) {
  if (typeof buf?.since !== 'function') return [];
  const cut = documentCutSeqs.has(buf) ? Number(documentCutSeqs.get(buf)) || 0 : 0;
  return buf.since(Math.max(Number(seq) || 0, cut));
}

function cutDocumentConsoleBuffers(buffers) {
  if (!buffers) return;
  for (const buf of [buffers.console, buffers.exception]) {
    if (typeof buf?.latest === 'function') documentCutSeqs.set(buf, buf.latest());
  }
}

function documentConsoleCutSeq(buf) {
  if (!buf || !documentCutSeqs.has(buf)) return null;
  return documentCutSeqs.get(buf);
}

function cutDocumentConsoleBuffersAt(buffers, seqs = {}) {
  if (!buffers) return;
  if (buffers.console && seqs.console != null) documentCutSeqs.set(buffers.console, seqs.console);
  if (buffers.exception && seqs.exception != null) documentCutSeqs.set(buffers.exception, seqs.exception);
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(e => {
    const [cmd, ...args] = process.argv.slice(2);
    console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
    process.exit(1);
  });
}
export const __test__ = process.env.NODE_ENV === 'test' ? {
  // Data structures
  RingBuffer, CDP,
  MAX_CAPTURED_CONSOLE_CHARS, ACTION_TEXT_REDACT_WINDOW, consoleEntryFromEvent, exceptionEntryFromEvent, boundedConsoleLineText, consoleStr, sliceAtCodePoint, compactActionText,
  // Utilities
  resolvePrefix, getDisplayPrefixLength, daemonEndpointForPlatform, sockPath, isRef, validateUrl,
  emptyAliasStore, readTargetAliases, writeTargetAliases, upsertTargetAlias,
  removeTargetAlias, forgetTargetAlias, resolveTargetAlias, aliasesForTarget, parseAliasCommandArgs,
  aliasEnv, discoverOptionsForTargetAlias, selectLivePagesForAliasResolution, bindAliasTargetFromPages,
  bindAndSaveTargetAlias, livePagesForTargetCommand, discoverLivePagesForTargetResolution,
  listPagesFromMatchingDaemon, daemonCommandResetsIdle, daemonIdleExitsSoon, assertFreshDaemonForCommand, createDaemonIdleTimer, idleTrackedDaemonRequestHandler, createRuntimePruneScheduler, DAEMON_REQUEST_IDLE_PAUSE_MAX_MS, RUNTIME_PRUNE_FALLBACK_MS,
  pruneRuntimeArtifacts, liveRuntimeArtifactTargetIds, RUNTIME_ARTIFACT_MAX_AGE_MS, RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS, SESSION_LOG_ROTATE_BYTES,
  createEarlyResponseStatusStore, createDaemonNetworkObserver, EARLY_RESPONSE_STATUS_MAX, EARLY_RESPONSE_STATUS_MAX_AGE_MS, cdpEndpointFromWsUrl, requestedCdpEndpoint, validateDaemonProtocolRequest,
  formatDaemonStartFailure,
  aliasLookupKey, looksLikeAliasToken, looksLikeHexTargetPrefix, unknownAliasError, formatCurrentAlias,
  // AX tree helpers
  shouldShowAxNode, formatAxNode, axNodeTokenState, orderedAxChildren,
  // Perceive & snapshot
  parsePerceiveArgs, pickPrimaryScrollMetrics, omitTypeaheadListboxNodes, TYPEAHEAD_OMITTED_NOTICE,
  buildPerceiveDiffModel, formatPerceiveDiffOutput, buildPerceiveTree, shouldPreservePerceiveRefs, perceivePageScript, renderedInteractiveSource, perceiveStr,
  perceiveTextboxValueFromOutput,
  filterPerceiveExcludedAxNodes, perceiveInteractiveNoiseHint,
  buildCardsModel, formatCardsJson, formatCardsText,
  parseControlsArgs, visibleControlsCollectorSource, visibleControlsPageScript, compactVisibleControlsModel, formatVisibleControlLine, formatVisibleControlsText, dedupeRepeatedLines, controlsStr,
  offsetCssRect, offsetCursorInteractiveItem, mergeMissingDomInteractiveAxNodes, syntheticAxNodeFromDomControl,
  attachRefToVisibleControl, refAnnotationsFromTreeLines, nativeVisibleControlTag,
  isSynthesizableDomControl, shouldSynthesizeMissingFrameInteractives, listDomInteractiveControls,
  collectDomInteractiveControls, countedInteractiveElements, axInteractiveBackendCount,
  rankPerceiveCursorItems, isSearchListingHref, isSearchListingText, isSearchListingControl,
  searchListingSelector, rankSearchListingFirst, PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP,
  pressFeedbackPolicy, fillFeedbackPolicy, isSearchSubmitPressCommand, batchCommandLookahead,
  runWithBatchLookahead,
  hoverFeedbackPolicy, isHoverConfirmEvalCommand, dispatchHoverWithLeftoverPolicy,
  hoverRevealStateExpression, parseHoverRevealState, formatHoverRevealClause,
  probeSearchSubmit, formatSearchSubmitPressText, isEnterKeyName,
  searchSubmitProbeExpression, searchListingProbeFromQuery, submitSearchListing,
  waitForSearchListingHref, waitForSearchSubmitProbe, navigateSearchListingIssued,
  SEARCH_SUBMIT_PROBE_WAIT_MS,
  createPerceptionModel, formatPerceptionJson, perceptionModelFromText, perceiveModel, perceiveDiffModel,
  createSessionState, invalidateSessionRefs, createActionDiagnosis,
  classifyActionFailure, formatActionFailure,
  buildActionRecoveryPlan, buildNoChangeOutcomeRecommendation,
  isExpectedNoChange, overlaySelectorArg,
  createActionResult, buildActionReceipt, formatActionText, formatActionResultOutput, runActionWithFeedback,
  stripLeftoverAxScrollCensusChrome, stripLeftoverAxScrollNoChangeIdentityChrome,
  stripLeftoverAxScrollNoChangeAxBodyChrome,
  parseVerifyClickArgs, buildSemanticInteractionModel, formatSemanticInteractionResult, formatActionWorkflowCommandOutput,
  parseQaArgs, buildQaPageModel, formatQaPageReport, qaPageStr,
  captureViewportSize, restoreAuditViewport,
  qaScreenshotCaptureOptions, QA_SCREENSHOT_TIMEOUT_MS,
  diffShotScreenshotCaptureOptions,
  FULLSHOT_TIMEOUT_MS, screenshotCaptureUsesSessionTier, fullshotFitsViewport, fullshotStr, scanshotStr,
  VERIFY_CLICK_SETTLE_MS, VERIFY_CLICK_REQUEST_WAIT_MS,
  HOVER_MOUSE_ACK_TIMEOUT_MS, HOVER_DELIVERY_WAIT_MS, HOVER_MUTATION_TIMEOUT_MS, HOVER_MUTATION_MARKER, HOVER_REVEAL_MARKER, CLICK_MOUSE_ACK_TIMEOUT_MS,
  CLICK_POPUP_COMMIT_WAIT_MS, CLICK_POPUP_NAVIGATION_CAP_MS, CLICK_OPENER_RESPOND_TIMEOUT_MS,
  CLICK_OPENER_TERMINATE_TIMEOUT_MS, CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS, CLICK_STUCK_OPENER_BUDGET_MS,
  stuckOpenerBeforeClick,
  LOADALL_DEFAULT_INTERVAL_MS, LOADALL_DEFAULT_TIMEOUT_MS, LOADALL_MAX_TIMEOUT_MS,
  CLICK_NAVIGATION_WAIT_MS, CLICK_HREF_PROBE_TIMEOUT_MS,
  daemonRequestStorage, sleep,
  actionabilityFunctionSource, parseActionabilityWaitArgs, normalizeActionabilityWaitMs, formatActionabilityWaitNote,
  actionDisabledError, ACTIONABILITY_WAIT_DEFAULT_MS, ACTIONABILITY_WAIT_MAX_MS,
  dispatchClick, dispatchMouseEventAllowingAckTimeout, dispatchClickMouseEvent, handledLater, resolveRef,
  daemonCrashReportPath, recordDaemonCrash, readDaemonCrashReport, installDaemonCrashRecorder, REF_SETTLE_BUDGET_MS, REF_RESOLVE_TIMEOUT,
  dragStr, dispatchDrag, parseDragArgs, formatDragEventCounts, dragEventProbeInstallScript, dragEventProbeReadScript,
  parseClickEventProbeOutput, clickProbeSawPageEvent,
  clickEventProbeInstallOnNodeDeclaration, clickEventProbeReadOnNodeDeclaration,
  clickEventProbeInstallAtPointScript, clickEventProbeReadAtPointScript,
  pinClickPointOnNodeDeclaration,
  isNamedClickQuery, namedClickQueryName, textSelectorName, isLikelyCssSelector, clickFeedbackPolicy, jsclickFeedbackPolicy,
  namedClickActionTarget, namedInViewportClickExpression, NAMED_IN_VIEWPORT_CLICK_OUTCOME,
  isNavigatingHref, confirmClickFollowedHref, evalPageHref, waitForSettle,
  rememberSessionTarget, forgetSessionTarget, linkOpensNewBrowsingContext, findClickOpenedTab,
  parseClickOpenedTab,
  waitForHoverDomChange, hoverRecaptureShowsChange, discardHoverIdleBaseline,
  shouldSkipActionDomSettle, formatActionNavigationDiff, actionNavigationEvidence,
  actionFailurePage,
  createActionObservationBaseline, buildActionObservationDelta, applyActionObservationDelta,
  summarizeActionObservationEffects, shouldTrackActionNetworkRequest, isNetworkFailure,
  appendSessionActionLog, appendSessionEventLog, appendSessionScreenshot,
  appendSessionEnvironmentLog, buildRecordEnvironmentModel,
  initializeSessionLog, appendSessionExitLog, createDaemonExitLog, parseReportArgs, buildSessionReportModel, formatSessionReport, sessionScreenshotDir, sessionDownloadDir,
  ensureSessionScreenshotDir, nextSessionScreenshotPath,
  buildRecordActionsModel, formatRecordActions,
  playwrightStepFromCommand, formatPlaywrightSpecFromRecordActions, formatExportPlaywright,
  parseDiffShotArgs, diffShotCompareScript, diffShotRegionsSource, diffShotReceiptRegion, formatDiffShotRegionLines, formatDiffShotResult, diffShotStr,
  checkpointPageScript, sanitizeCheckpointCookies, sanitizeCheckpointStorage, parseCheckpointArgs, checkpointModel, checkpointStr,
  parseCheckpointArtifact, parseRestoreArgs, redactRestoreCommandArgs, redactExternalInputActionError, redactRestoreActionError,
  checkpointCookieToSetCookieParams, isRestorableCheckpointCookie, cookiesForRestore,
  restoreStorageScript, restoreCheckpointStr,
  // Command implementations
  getPages, formatPageList, buildPageListModel, formatPageListOutput, dialogStr, netlogStr, netlogRequestStr, absolutizeNetlogOutArg, parseNetlogArgs, filterNetlogEntries, netStr, checkpointSessionEvent, redactSensitiveArtifactValue,
  readNetlogResponseBody, describeFailedActionRequests, formatFailedRequestLine, failedRequestNextCommand, insertBeforeNextLine,
  javascriptDialogHandleParams, createJavaScriptDialogSession, handleOpeningJavaScriptDialog,
  shouldSkipActionPageEvaluate, formatDialogBlockedObserveText, observeAfterActionGuardingDialogs,
  parseMockArgs, formatNetworkMocksSummary, buildMockModel, formatMockText, mockStr, handleMockRequestPaused,
  parseClockArgs, clockPageScript, formatClockSummary, buildClockModel, formatClockText, clockStr,
  parseThrottleArgs, formatThrottleSummary, throttleModel, formatThrottleText, throttleStr,
  injectStr, cascadeStr, recordStr, parseRecordArgs,
  isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, sendCommand, parseTargetAndCommandArgs, normalizeTargetCommandArgs,
  parseFormatArgs, parseListArgs, formatJson, parseConsoleArgs, clearConsoleBaseline, buildConsoleModel, buildStatusModel, summaryModel, formatSummaryText, summaryStr,
  evalStr, evalFireAndForgetStr, parseEvalArgs, normalizeEvalCliArgs, formatEvalValue, wrapAwaitExpression, callStr, formatCallResult, evalBase64Decode,
  parseEmulateArgs, buildEmulateFeatures, buildEmulateModel, formatEmulateText, emulateStr, emptyEmulateState, viewportStr,
  assessViewportReadback, rememberViewportReadback,
  cookieDelStr, cookieDeleteParams, cookiesStr, parseCookieArgs, uploadStr, assertReadableUploadFiles, parseClosetabArgs,
  navStr, reloadStr, reloadActionDispatch, createNavigationCancelWatch, navigationCancelledError, dispatchGuardingCancelledNavigation, navActionDispatch, NAVIGATION_CANCEL_EVIDENCE_WAIT_MS, observeReloadPage, observeNavPage, observePageState, clickStr, clickXyStr, jsClickStr, pointerClickStr, pointerClickFunctionDeclaration, fillStr, fillReactStr, waitForStr, hoverStr, dispatchHoverMove, rememberHoverSettleBaseline, parseScrollEdge, splitScrollEdgeArgs, normalizeScrollArgs, scrollByExpression, formatScrollByContainerText, parseScrollContainerArg, scrollFeedbackPolicy, scrollActionTarget, documentScrollEdgeExpression, scrollEdgeExpression, documentScrollReachedEdge, formatDocumentScrollEdgeText, formatDocumentScrollEdgeFailure, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, DOCUMENT_SCROLL_EDGE_OUTCOME, scrollStr, selectStr, loadAllStr, parseLoadAllArgs, closetabStr, snapshotStr,
  waitForCommittedDocumentReady, parseNavigationDocumentProbe, actionNetworkQuietOptions, waitForActionNetworkQuiet,
  statusStr, runtimeMetricsStr, webVitalsModel, clearObservationBuffers,
  selectConsoleEntries, locateObservedEntries,
  buildLocatedActionObservationDelta, loadSourceMapText,
  parsePageConditionArgs, pageConditionDescription, probePageCondition, parseRepeatArgs, repeatStr, autoActionJsonArgs,
  classifyCommandResultSemantics,
  emitTargetCommandResponse,
  isBatchParallelUnsafeCommand,
  parseReplayArgs, parseReplayArtifact, replayStepFromAction, replayActionsStr,
  collectDaemonMetadata, assessDaemonFreshness, formatStaleDaemonMessage, resolveScriptIdentityPath,
  enableDaemonDomains,
  getOrStartTabDaemon,
  suggestCommands, unknownCommandMessage, editDistance, commandUsageTemplate,
  resolveLiveTargetBinding, resolvePageCommandTarget, completeTargetResolution, attachTargetResolutionDiagnostics,
  commandAcceptsFollowUrl, takeFollowUrlFlag, FOLLOW_URL_FLAG,
  buildExactTargetSupervisorCandidates,
  cdpRuntimeIdentity,
  // 3y-mud feedback additions
  KEY_MAP, PUNCT_KEY_MAP, SHIFTED_PUNCT_KEY_MAP, keyForPress, pressStr, pressUsageError,
  parsePressArgs, pressSearchSubmitPlan, pressHelpLines, PRESS_SEARCH_SUBMIT_FLAG,
  PRESS_PROBE_MARKER, PRESS_DELIVERY_WAIT_MS,
  formatUnknownRefError, resolveRefNode, scrollSettledRectFunctionDeclaration, clickableBoxHelpersSource, assertClickPointNotCovered, formatRefRect, isPriorityPerceiveTextLine,
  parseFrameOnlyRef, parseFrameRef, parseFrameArgs, flattenFrameTree, formatFrameTreeText, framesModel, framesStr,
  resolveFrameRef, storeFrameScopedRefs, qualifyFrameRefsInLines, frameRefFromActionTarget,
  rememberFramePerceiveOutput, baselineOutputForActionTarget, perceiveStoreDiffSource, frameViewportOffset,
  parseTextArgs, textPageScript, textStr, formatTextNoMatchError, htmlStr,
  isPdfViewerContentType, formatPdfViewerOutput, pdfViewerError, assertNotPdfViewerPage, pageInfoModel,
  extractPdfPageText, loadPdfBytesForText,
  pdfViewerHandoffModelFromOutput,
  actionObservationPerceiveOpts, actionResultPdfViewerMeta, actionSettleBaseline, isCardsPerceiveOutput,
  leftoverCardsCount, isScrollActionTarget, isLeftoverFeedCardsSettle,
  isDocumentScrollEdgeTarget, tagScrollLeftoverSettle,
  isLeftoverDefaultAxScrollSettle, stripPerceiveRectChrome, stripPerceiveIdentityChrome,
  isPerceiveDecorativeTitleChrome, isVisibleControlTimestampName, visibleControlNameFromLine, extractVisibleControlLabels,
  uniqueVisibleControlCapSwapSamples,
  isPdfViewerPerceiveOutput, pdfViewerSettleDiffText,
  isFramedPerceiveOutput, shouldCaptureTopLevelActionSettle, actionSettleObserveOpts,
  actionDomDiffShowsChange, noBaselineActionDiffText, noBaselineActionDiff,
  shouldCaptureFirstActionBaseline, captureFirstActionBaseline, resolveActionSettleBaseline,
  formControlStateChanged, formatFormControlStateDiff, shouldSnapshotFormControlState,
  parseFormControlStateSnapshot, snapshotFormControlState,
  sampleRootFrameTables, tableObservationStr, tableCollectionStr, buildTableCollectorBootstrapExpression,
  parseShotArgs, shotStr, elshotStr, parseElshotArgs, absolutizeElshotFileArg, absolutizeCallerFileArgs, RUNTIME_DIR, formatScreenshotCaptureDiagnostics, elementScreenshotClip,
  parseSpawnDebugBrowserArgs, SPAWN_DEBUG_BROWSER_FLAGS, detectBrowserPath, buildSpawnDebugBrowserPlan,
  isBackgroundMode, explicitBackgroundChoice, attachDaemonTarget, createOpenTarget, backgroundDaemonEnv,
  foregroundActivationRequest, revealHiddenTab, REVEAL_POLL_TIMEOUT_MS, setBackgroundCaptureGuard, hiddenTabCaptureError,
  isHiddenTabCaptureError, HIDDEN_TAB_CAPTURE_TIMEOUT_MS, BATCH_BLOCKED, REPEAT_BLOCKED, REPLAY_BLOCKED,
  tabModePath, writeTabBackgroundMode, readTabBackgroundMode, readTabMode, removeTabMode, listTabModeRecords, TAB_MODE_RECORDS_MAX,
  tabEnvPath, readTabEnvironment, writeTabEnvironment, removeTabEnvironment, rememberTabEnvironment,
  tabObservePath, rememberTabObservation, restoreTabObservation, removeTabObservation,
  setDialogMode, applySavedTabEnvironment, formatDaemonRestartNotice, armDaemonRestartNotice, applyDaemonRestartNotice,
  savedDialogAccepts, environmentRestoreOutcome, takeAcceptDialogFlag, nativeDialogShouldAccept,
  dismissedDecisionDialogSince, nativeDialogDismissedError, errorYieldingToDismissedDialog, ACCEPT_DIALOG_FLAG,
  daemonBackgroundMode, cdpProfileKey, lastCdpEndpointPath, createSystemTempRootReader, minimizeWindowsForTargets, minimizeBrowserWindows,
  probeTcpPort,
  recordCommandUsage, USAGE_LOG_MAX_BYTES, getWsUrl, classifyBrowserProfile, checkBrowserProfile, splitCommandLine, readBrowserProcessArgv, macCommandLineArgv, readBrowserArgvViaCdp, createIsolatedMemberGate, readCdpUserAgent, waitForSpawnedCdp, formatSpawnDebugBrowserReadinessFailure, spawnDebugBrowserStr,
  isExistingBrowserSessionHandoff, formatExistingBrowserSessionHandoffError, formatDailyDefaultProfileCdpFailure,
  detectChromiumMajorVersion, defaultProfileIgnoresRemoteDebugging,
  listSpawnedDebugTargets, pickSpawnedTarget, buildSpawnDebugBrowserModel, formatSpawnDebugBrowserOutput,
  readLastCdpEndpoint, writeLastCdpEndpoint, rememberLastCdpEndpoint, formatCdpRelaunchCommand,
  cdpUnreachableError, profileDirFromCommandLine, profileDirFromDevToolsActivePort,
  inspectCdpOccupantProfileDirViaCdp,
  isDisposableSpawnProfileDir, isIsolatedChromeCdpExProfileDir,
  isTempCdpProfileDir, rankCdpRelaunchCandidates,
  replayableLaunchFlags, inspectCdpProfileProcess, isBrowserDefaultUserDataDir, cdpDiscoveryMiss, withLiveLaunchFlags, readProcessArgv,
  findListeningBrowserProcess, listeningSocketInodes,
  persistentDailyUserDataDir, isolatedSpawnProfileDir,
  overlayDetectorScript, formatOverlayReport, resolveOverlayTargetPoint, overlayStr,
  dismissModalStr, dismissModalScript, openDialogCountScript, dialogVisibleFunctionSource,
  // Screenshot
  captureScreenshot, screencastFallback,
  resetScreenshotTier, getScreenshotTier, createScreenshotTierState, screenshotFallbackReason, SCREENSHOT_TIMEOUT,
  // Constants
  ENRICHED_ROLES, INTERACTIVE_ROLES, CONTENT_REF_ROLES,
  isSkipLinkAxNode, isSkipLinkName, isLicenseBlobUrl,
  perceiveSnapshotOpts, resolveSinceActionPerceiveOpts, perceiveArgsIncludeSnapshotShape,
  DOCTOR_LIST_TARGET_PLACEHOLDER,
  // Cascade source mapping
  decodeVLQ, mapLineToSource, mapInlineSourceMap, stripVitePathQuery, mapStyleSource,
  // Batch / flow / doctor
  formatBatchResults, runBatchCommands, parseBatchArgs, parseFlowSteps, settleFlow, flowStr,
  formatCliError, formatDaemonCommandError, buildCliErrorModel, parseOpenArgs, openNavigationScript, openReadyProbeScript, waitForOpenReady, waitForOpenTargetUrl, navigateOpenTarget, openTargetNavigationRequested, OPEN_CREATED_TARGET_URL, buildOpenModel, formatOpenReadyMessage, formatOpenNextPerceiveCommand, formatOpenAttachWaitMessage, shouldAnnounceOpenAttachWait, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure,
  DEFAULT_OPEN_ATTACH_TIMEOUT_MS,
  CLI_HELP_LAYOUT, CLI_HELP_TEMPLATE, CATALOG_USAGE, renderCliHelp, renderCardHelp,
  SURVIVOR_COMMANDS, helpStr, helpTopicStr,
  checkNode, checkSkillSymlink, checkDaemonSockets, checkFdLimit, checkCdpReachability, checkBrowserTargets, checkBrowserPermission,
  detectRuntimeEnvironment, checkRuntimeEnvironment,
  discoverNode22, resolveChromeCdpNodeLaunch, formatNodeRerunCommand, nodeMajor,
  doctorWizardModel, doctorWizardSummary, doctorCheckSeverity,
  doctorNextSteps, doctorStatusSummary, buildDoctorModel, formatDoctorOutput,
  formatDoctorReport, runDoctorChecks, doctorStr,
  doctorProbeFromTargets, doctorProbeFromChecks,
  buildStopResult, formatStopResult, stopDaemons,
  daemonRecordPath, writeDaemonRecord, readDaemonRecord, removeDaemonRecord, listDaemonRecords, processIsTargetDaemon, isProcessAlive,
  removeOwnDaemonRecord, createDaemonEndpointLifecycle, daemonAlreadyServes,
  // Issues #82-#87 helpers
  isBlankPageUrl, pageTargetScore, rankPageTargets, matchPageTargets, selectPageTarget,
  parseTargetSelectArgs, buildTargetSelectModel, formatTargetSelect,
  parseQaModeArgs, buildQaSummaryModel, formatQaSummaryText, livePageIdentity, truncateTextLines,
  pdfViewerNextCommand, pdfViewerHandoffModel, pdfViewerReportRecommendation,
  classifyPageHealth, pageHealthScript, collectPageHealth,
  parseResponsiveAuditArgs, buildResponsiveAuditModel, formatResponsiveAuditReport,
  responsiveAuditViewportScript, responsiveAuditStr, countNetworkFailures,
  stylesStr,
  emptyTabGroupStore, normalizeTabGroupName, normalizeTabGroupStore, readTabGroups, writeTabGroups,
  upsertTabGroup, removeTabGroupMember, deleteTabGroup, getTabGroup,
  parseTabGroupArgs, formatTabGroupStore, formatTabGroup,
  listKnownLiveTargetIds, resolveTabGroupMember, resolveTabGroupMembers,
  parseBroadcastArgs, buildBroadcastModel, formatBroadcastResult,
  parseComponentsArgs, frameworkDetectorScript, reactComponentsTreeScript, vueComponentsTreeScript,
  sanitizeComponentValue, sanitizeComponentResult, componentsStr, chooseAdaptivePerceiveLast,
  COMMANDS, NEEDS_TARGET, commandMeta, buildApplicationCommandSpecs, createApplicationCommandRegistry,
  DAEMON_APPLICATION_COMMANDS, DAEMON_HANDLER_BUILDERS, preflightDaemonApplication,
  createReportCommandHandler, createPerceiveCommandHandler,
  createClickCommandHandler, parseClickArgs, parseFillArgs, createEvalrawCommandHandler,
  buildCliErrorRecovery,
  authorizeDaemonApplicationCommand, executeDaemonApplicationRoute,
  daemonRequestMayHaveSideEffects,
  fillableControlProbeDeclaration, notFillableControlError,
  fillLiveValueAccepted, fillValueRejectedError, fillLiveValuePageScript,
  applyFillValueState, markSensitiveFillTarget, isSensitiveActionTarget, buildFillValueState, fillCliArgError, buildActionOutcome, compactFillReceiptForJson,
  cliRequestSecrets, resolveRequestSecret, rememberSessionSecret, scrubSessionSecrets, scrubDaemonResponse,
  TYPE_SECRET_UNSUPPORTED, runDaemonRequestScope, createDaemonFillCapability, collectSecretNames,
  looksLikeClipboardControl, isExpectedClipboardNoChange,
  TABLE_COLLECTION_DEADLINES, TableCollectionDeadlineError,
  createDaemonRequestExecutionContext, createTableCollectionRuntime,
  runTableCollectionLifecycle, createDaemonRequestConnection, MAX_DAEMON_REQUEST_LINE_BYTES,
  createDaemonShutdown, enforceDaemonTableCollectionGate,
  policyCompositeSteps, markSessionActionsPolicyFailed, currentSessionActionSequence,
} : undefined;
