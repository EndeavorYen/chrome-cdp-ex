#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { actionFailurePage, buildActionRecoveryPlan, buildNoChangeOutcomeRecommendation, classifyActionFailure, formatActionFailure, isExpectedClipboardNoChange, isExpectedNoChange, isTimeoutError, looksLikeClipboardControl, overlaySelectorArg } from './lib/action-recovery.mjs';
import { detectBrowserPath } from './lib/browser-paths.mjs';
import { buildCardsModel, formatCardsJson, formatCardsText } from './lib/cards-model.mjs';
import { SURVIVOR_COMMANDS } from './lib/command-surface.mjs';
import { daemonEndpointForPlatform, ipcTimeoutForRequest } from './lib/daemon-transport.mjs';
import { parseNetlogArgs } from './lib/netlog.mjs';
import { discoverNode22, formatNodeRerunCommand, nodeMajor, resolveChromeCdpNodeLaunch } from './lib/node-runtime.mjs';
import { classifyPageHealth, pageHealthScript } from './lib/page-health.mjs';
import { extractPdfPageText } from './lib/pdf-text.mjs';
import { createPerceptionModel, formatPerceptionJson } from './lib/perception-model.mjs';
import { removeTabObservation, tabObservePath } from './lib/tab-observation.mjs';
import { attachTargetResolutionDiagnostics, completeTargetResolution, resolveLiveTargetBinding } from './lib/target-binding.mjs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { actionDomDiffShowsChange, actionNavigationEvidence, actionObservationPerceiveOpts, actionResultPdfViewerMeta, actionSettleBaseline, actionSettleObserveOpts, applyActionObservationDelta, buildActionObservationDelta, buildActionOutcome, buildActionReceipt, buildLocatedActionObservationDelta, captureFirstActionBaseline, compactActionText, compactFillReceiptForJson, createActionDiagnosis, createActionObservationBaseline, createActionResult, describeFailedActionRequests, failedRequestNextCommand, formatActionNavigationDiff, formatActionResultOutput, formatActionText, formatFailedRequestLine, formatSummaryText, insertBeforeNextLine, isCardsPerceiveOutput, isDocumentScrollEdgeTarget, isFramedPerceiveOutput, isLeftoverDefaultAxScrollSettle, isLeftoverFeedCardsSettle, isNetworkFailure, isPdfViewerPerceiveOutput, isScrollActionTarget, leftoverCardsCount, locateObservedEntries, noBaselineActionDiff, noBaselineActionDiffText, parseVerifyClickArgs, pdfViewerSettleDiffText, perceiveStoreDiffSource, redactSensitiveArtifactValue, resolveActionSettleBaseline, shouldCaptureFirstActionBaseline, shouldCaptureTopLevelActionSettle, shouldSkipActionDomSettle, shouldTrackActionNetworkRequest, stripLeftoverAxScrollCensusChrome, stripLeftoverAxScrollNoChangeAxBodyChrome, stripLeftoverAxScrollNoChangeIdentityChrome, summarizeActionObservationEffects, tagScrollLeftoverSettle } from './lib/cdp-action-result.mjs';
import { ACCEPT_DIALOG_FLAG, ERROR_KINDS, ACTIONABILITY_WAIT_DEFAULT_MS, ACTIONABILITY_WAIT_MAX_MS, ACTION_TEXT_REDACT_WINDOW, BATCH_BLOCKED, CATALOG_USAGE, CLICK_HREF_PROBE_TIMEOUT_MS, CLICK_MOUSE_ACK_TIMEOUT_MS, CLICK_NAVIGATION_WAIT_MS, CLICK_OPENER_RESPOND_TIMEOUT_MS, CLICK_OPENER_TERMINATE_TIMEOUT_MS, CLICK_POPUP_COMMIT_WAIT_MS, CLICK_POPUP_NAVIGATION_CAP_MS, CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS, CLICK_STUCK_OPENER_BUDGET_MS, CLI_HELP_LAYOUT, CLI_HELP_TEMPLATE, COMMANDS, CONTENT_REF_ROLES, DAEMON_REQUEST_IDLE_PAUSE_MAX_MS, DEFAULT_OPEN_ATTACH_TIMEOUT_MS, DOCTOR_LIST_TARGET_PLACEHOLDER, DOCUMENT_SCROLL_EDGE_OUTCOME, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, EARLY_RESPONSE_STATUS_MAX, EARLY_RESPONSE_STATUS_MAX_AGE_MS, ENRICHED_ROLES, FOLLOW_URL_FLAG, FULLSHOT_MAX_CAPTURE_HEIGHT, FULLSHOT_TIMEOUT_MS, HIDDEN_TAB_CAPTURE_TIMEOUT_MS, HOVER_DELIVERY_WAIT_MS, HOVER_MOUSE_ACK_TIMEOUT_MS, HOVER_MUTATION_MARKER, HOVER_MUTATION_TIMEOUT_MS, HOVER_REVEAL_MARKER, INTERACTIVE_ROLES, KEY_MAP, LOADALL_DEFAULT_INTERVAL_MS, LOADALL_DEFAULT_TIMEOUT_MS, LOADALL_MAX_TIMEOUT_MS, MAX_CAPTURED_CONSOLE_CHARS, MAX_DAEMON_REQUEST_LINE_BYTES, NAMED_IN_VIEWPORT_CLICK_OUTCOME, NAVIGATION_CANCEL_EVIDENCE_WAIT_MS, NEEDS_TARGET, OPEN_CREATED_TARGET_URL, PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP, PRESS_DELIVERY_WAIT_MS, PRESS_PROBE_MARKER, PRESS_SEARCH_SUBMIT_FLAG, PUNCT_KEY_MAP, QA_SCREENSHOT_TIMEOUT_MS, REF_RESOLVE_TIMEOUT, REF_SETTLE_BUDGET_MS, REPEAT_BLOCKED, REPLAY_BLOCKED, REVEAL_POLL_TIMEOUT_MS, RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS, RUNTIME_ARTIFACT_MAX_AGE_MS, RUNTIME_DIR, RUNTIME_PRUNE_FALLBACK_MS, SCREENSHOT_TIMEOUT, SEARCH_SUBMIT_PROBE_WAIT_MS, SESSION_LOG_ROTATE_BYTES, SHIFTED_PUNCT_KEY_MAP, SPAWN_DEBUG_BROWSER_FLAGS, TABLE_COLLECTION_DEADLINES, TAB_MODE_RECORDS_MAX, TYPEAHEAD_OMITTED_NOTICE, TYPE_SECRET_UNSUPPORTED, USAGE_LOG_MAX_BYTES, VERIFY_CLICK_REQUEST_WAIT_MS, VERIFY_CLICK_SETTLE_MS, cdpProfileKey, createSystemTempRootReader, daemonRequestStorage, findListeningBrowserProcess, listeningSocketInodes, profileDirFromCommandLine, readProcessArgv, renderCardHelp, renderCliHelp, sleep } from './lib/cdp-base.mjs';
import { CDP, aliasEnv, aliasLookupKey, aliasesForTarget, assessDaemonFreshness, bindAliasTargetFromPages, bindAndSaveTargetAlias, buildBroadcastModel, buildQaSummaryModel, buildTargetSelectModel, cdpDiscoveryMiss, cdpUnreachableError, classifyBrowserProfile, collectDaemonMetadata, commandAcceptsFollowUrl, createIsolatedMemberGate, deleteTabGroup, discoverOptionsForTargetAlias, emptyTabGroupStore, forgetTargetAlias, formatBroadcastResult, formatCurrentAlias, formatDaemonStartFailure, formatJson, formatQaSummaryText, formatStaleDaemonMessage, formatTabGroup, formatTabGroupStore, formatTargetSelect, getDisplayPrefixLength, getTabGroup, getWsUrl, inspectCdpProfileProcess, isBlankPageUrl, isBrowserDefaultUserDataDir, isLicenseBlobUrl, listKnownLiveTargetIds, livePageIdentity, livePagesForTargetCommand, looksLikeAliasToken, looksLikeHexTargetPrefix, macCommandLineArgv, matchPageTargets, normalizeTabGroupName, normalizeTabGroupStore, pageTargetScore, parseAliasCommandArgs, parseBroadcastArgs, parseDelayMs, parseFormatArgs, parseListArgs, parseQaModeArgs, parseTabGroupArgs, parseTargetSelectArgs, profileDirFromDevToolsActivePort, rankPageTargets, readBrowserArgvViaCdp, readBrowserProcessArgv, readCdpUserAgent, readTabGroups, recordCommandUsage, removeTabGroupMember, removeTargetAlias, resolvePageCommandTarget, resolvePrefix, resolveScriptIdentityPath, resolveTabGroupMember, resolveTabGroupMembers, resolveTargetAlias, selectLivePagesForAliasResolution, selectPageTarget, splitCommandLine, takeFollowUrlFlag, truncateTextLines, unknownAliasError, upsertTabGroup, upsertTargetAlias, waitStr, withLiveLaunchFlags, writeTabGroups } from './lib/cdp-browser.mjs';
import { absolutizeCallerFileArgs, authorizeDaemonApplicationCommand, backgroundDaemonEnv, buildApplicationCommandSpecs, buildCliErrorModel, buildCliErrorRecovery, buildExactTargetSupervisorCandidates, buildOpenModel, commandUsageTemplate, createApplicationCommandRegistry, createClickCommandHandler, createEvalrawCommandHandler, createOpenTarget, detectCliErrorFormat, editDistance, executeDaemonApplicationRoute, fillCliArgError, formatCliError, formatDaemonCommandError, cliErrorFromDaemonResponse, formatOpenAttachWaitMessage, formatOpenAutoPerceiveFailure, formatOpenNextPerceiveCommand, formatOpenReadyMessage, formatOpenTimeoutMessage, helpStr, helpTopicStr, navigateOpenTarget, normalizeTargetCommandArgs, openNavigationScript, openReadyProbeScript, openTargetNavigationRequested, parseClickArgs, parseFillArgs, parseOpenArgs, parseTargetAndCommandArgs, shouldAnnounceOpenAttachWait, suggestCommands, unknownCommandMessage, waitForOpenReady, waitForOpenTargetUrl } from './lib/cdp-cli.mjs';
import { RingBuffer, TableCollectionDeadlineError, applyDaemonRestartNotice, applySavedTabEnvironment, armDaemonRestartNotice, boundedConsoleLineText, consoleEntryFromEvent, createDaemonIdleTimer, createDaemonNetworkObserver, createDaemonRequestConnection, createDaemonRequestExecutionContext, createDaemonShutdown, createEarlyResponseStatusStore, createTableCollectionRuntime, daemonBackgroundMode, daemonCrashReportPath, daemonRecordPath, emptyAliasStore, enforceDaemonTableCollectionGate, environmentRestoreOutcome, exceptionEntryFromEvent, explicitBackgroundChoice, formatCdpRelaunchCommand, formatDaemonRestartNotice, idleTrackedDaemonRequestHandler, inspectCdpOccupantProfileDirViaCdp, installDaemonCrashRecorder, isBackgroundMode, isDisposableSpawnProfileDir, isIsolatedChromeCdpExProfileDir, isTempCdpProfileDir, lastCdpEndpointPath, listDaemonRecords, listTabModeRecords, rankCdpRelaunchCandidates, readDaemonCrashReport, readDaemonRecord, readLastCdpEndpoint, readTabBackgroundMode, readTabEnvironment, readTabMode, readTargetAliases, recordDaemonCrash, rememberLastCdpEndpoint, rememberTabEnvironment, rememberTabObservation, removeDaemonRecord, removeOwnDaemonRecord, removeTabEnvironment, removeTabMode, replayableLaunchFlags, restoreTabObservation, runTableCollectionLifecycle, savedDialogAccepts, sliceAtCodePoint, sockPath, tabEnvPath, tabModePath, validateDaemonProtocolRequest, writeDaemonRecord, writeLastCdpEndpoint, writeTabBackgroundMode, writeTabEnvironment, writeTargetAliases } from './lib/cdp-core.mjs';
import { DAEMON_APPLICATION_COMMANDS, DAEMON_HANDLER_BUILDERS, assertFreshDaemonForCommand, attachDaemonTarget, buildStopResult, cdpEndpointFromWsUrl, cliRequestSecrets, collectSecretNames, createDaemonEndpointLifecycle, createPerceiveCommandHandler, createReportCommandHandler, daemonAlreadyServes, daemonCommandResetsIdle, daemonIdleExitsSoon, daemonRequestMayHaveSideEffects, discoverLivePagesForTargetResolution, enableDaemonDomains, foregroundActivationRequest, formatStopResult, getOrStartTabDaemon, isProcessAlive, listPagesFromMatchingDaemon, loadSourceMapText, preflightDaemonApplication, processIsTargetDaemon, requestedCdpEndpoint, revealHiddenTab, sendCommand, stopDaemons } from './lib/cdp-daemon.mjs';
import { buildDoctorModel, buildSpawnDebugBrowserModel, buildSpawnDebugBrowserPlan, checkBrowserPermission, checkBrowserProfile, checkBrowserTargets, checkCdpReachability, checkDaemonSockets, checkFdLimit, checkNode, checkRuntimeEnvironment, defaultProfileIgnoresRemoteDebugging, detectChromiumMajorVersion, detectRuntimeEnvironment, dialogVisibleFunctionSource, dismissModalScript, dismissModalStr, doctorCheckSeverity, doctorNextSteps, doctorProbeFromChecks, doctorProbeFromTargets, doctorStatusSummary, doctorStr, doctorWizardModel, doctorWizardSummary, formatDailyDefaultProfileCdpFailure, formatDoctorOutput, formatDoctorReport, formatExistingBrowserSessionHandoffError, formatOverlayReport, formatSpawnDebugBrowserOutput, formatSpawnDebugBrowserReadinessFailure, isExistingBrowserSessionHandoff, isolatedSpawnProfileDir, listSpawnedDebugTargets, minimizeBrowserWindows, minimizeWindowsForTargets, openDialogCountScript, overlayDetectorScript, overlayStr, parseSpawnDebugBrowserArgs, persistentDailyUserDataDir, pickSpawnedTarget, probeTcpPort, resolveOverlayTargetPoint, runDoctorChecks, spawnDebugBrowserStr, waitForSpawnedCdp } from './lib/cdp-doctor.mjs';
import { autoActionJsonArgs, cascadeStr, checkSkillSymlink, classifyCommandResultSemantics, closetabStr, commandMeta, createNavigationCancelWatch, decodeVLQ, dispatchGuardingCancelledNavigation, flowStr, formatBatchResults, injectStr, isBatchParallelUnsafeCommand, mapInlineSourceMap, mapLineToSource, mapStyleSource, navActionDispatch, navigationCancelledError, observeNavPage, observePageState, observeReloadPage, pageConditionDescription, parseBatchArgs, parseClosetabArgs, parseFlowSteps, parsePageConditionArgs, parseRecordArgs, parseRepeatArgs, parseReplayArgs, parseReplayArtifact, policyCompositeSteps, probePageCondition, recordStr, reloadStr, repeatStr, replayActionsStr, replayStepFromAction, runBatchCommands, settleFlow, stripVitePathQuery } from './lib/cdp-flow.mjs';
import { absolutizeElshotFileArg, actionDisabledError, actionabilityFunctionSource, applyFillValueState, assertClickPointNotCovered, batchCommandLookahead, buildFillValueState, clickEventProbeInstallAtPointScript, clickEventProbeInstallOnNodeDeclaration, clickEventProbeReadAtPointScript, clickEventProbeReadOnNodeDeclaration, clickFeedbackPolicy, clickProbeSawPageEvent, clickStr, clickXyStr, confirmClickFollowedHref, dispatchClick, dispatchClickMouseEvent, dispatchDrag, dispatchHoverMove, dispatchHoverWithLeftoverPolicy, dispatchMouseEventAllowingAckTimeout, documentScrollEdgeExpression, documentScrollReachedEdge, dragEventProbeInstallScript, dragEventProbeReadScript, dragStr, evalPageHref, fillFeedbackPolicy, fillLiveValueAccepted, fillLiveValuePageScript, fillReactStr, fillStr, fillValueRejectedError, fillableControlProbeDeclaration, findClickOpenedTab, forgetSessionTarget, formControlStateChanged, formatActionabilityWaitNote, formatDocumentScrollEdgeFailure, formatDocumentScrollEdgeText, formatDragEventCounts, formatFormControlStateDiff, formatHoverRevealClause, formatScrollByContainerText, formatSearchSubmitPressText, handledLater, hoverFeedbackPolicy, hoverRevealStateExpression, hoverStr, isEnterKeyName, isHoverConfirmEvalCommand, isLikelyCssSelector, isNamedClickQuery, isNavigatingHref, isSearchSubmitPressCommand, jsClickStr, jsclickFeedbackPolicy, keyForPress, linkOpensNewBrowsingContext, markSensitiveFillTarget, namedClickActionTarget, namedClickQueryName, namedInViewportClickExpression, navigateSearchListingIssued, normalizeActionabilityWaitMs, normalizeScrollArgs, notFillableControlError, parseActionabilityWaitArgs, parseClickEventProbeOutput, parseClickOpenedTab, parseDragArgs, parseFormControlStateSnapshot, parseHoverRevealState, parsePressArgs, parseScrollContainerArg, parseScrollEdge, pinClickPointOnNodeDeclaration, pointerClickFunctionDeclaration, pointerClickStr, pressFeedbackPolicy, pressHelpLines, pressSearchSubmitPlan, pressStr, pressUsageError, probeSearchSubmit, reloadActionDispatch, rememberHoverSettleBaseline, rememberSessionTarget, runWithBatchLookahead, scrollActionTarget, scrollByExpression, scrollEdgeExpression, scrollFeedbackPolicy, scrollStr, searchListingProbeFromQuery, searchSubmitProbeExpression, selectStr, shouldSnapshotFormControlState, snapshotFormControlState, splitScrollEdgeArgs, stuckOpenerBeforeClick, submitSearchListing, textSelectorName, waitForSearchListingHref, waitForSearchSubmitProbe, waitForStr } from './lib/cdp-input.mjs';
import { cdpRuntimeIdentity, emitTargetCommandResponse, main } from './lib/cdp-main.mjs';
import { assertNotPdfViewerPage, axNodeTokenState, buildEmulateFeatures, buildEmulateModel, buildPageListModel, callStr, captureScreenshot, collectPageHealth, createScreenshotTierState, diffShotCompareScript, diffShotReceiptRegion, diffShotRegionsSource, diffShotStr, elshotStr, emptyEmulateState, emulateStr, evalBase64Decode, evalFireAndForgetStr, evalStr, formatAxNode, formatCallResult, formatDiffShotRegionLines, formatDiffShotResult, formatEmulateText, formatEvalValue, formatPageList, formatPageListOutput, formatPdfViewerOutput, formatScreenshotCaptureDiagnostics, fullshotStr, getPages, getScreenshotTier, hiddenTabCaptureError, htmlStr, isHiddenTabCaptureError, isPdfViewerContentType, isPriorityPerceiveTextLine, loadPdfBytesForText, navStr, netStr, normalizeEvalCliArgs, orderedAxChildren, parseConsoleArgs, parseDiffShotArgs, parseEmulateArgs, parseEvalArgs, parseNavigationDocumentProbe, parseShotArgs, pdfViewerError, pdfViewerHandoffModel, pdfViewerHandoffModelFromOutput, pdfViewerNextCommand, pdfViewerReportRecommendation, resetScreenshotTier, runtimeMetricsStr, scanshotStr, screencastFallback, screenshotCaptureUsesSessionTier, screenshotFallbackReason, setBackgroundCaptureGuard, shotStr, shouldShowAxNode, snapshotStr, waitForCommittedDocumentReady, webVitalsModel, wrapAwaitExpression } from './lib/cdp-page.mjs';
import { absolutizeNetlogOutArg, actionNetworkQuietOptions, assertReadableUploadFiles, assessViewportReadback, buildClockModel, buildMockModel, buildTableCollectorBootstrapExpression, checkpointCookieToSetCookieParams, checkpointModel, checkpointPageScript, checkpointSessionEvent, checkpointStr, clearObservationBuffers, clockPageScript, clockStr, componentsStr, cookieDelStr, cookieDeleteParams, cookiesForRestore, cookiesStr, createJavaScriptDialogSession, dialogStr, dismissedDecisionDialogSince, errorYieldingToDismissedDialog, filterNetlogEntries, formatClockSummary, formatClockText, formatDialogBlockedObserveText, formatMockText, formatNetworkMocksSummary, formatTextNoMatchError, formatThrottleSummary, formatThrottleText, frameworkDetectorScript, capFullshotHeight, formatFullshotOutput, formatFullshotReceipt, fullshotFitsViewport, fullshotPlanError, fullshotScrollPlanExpression, parseFullshotArgs, handleMockRequestPaused, handleOpeningJavaScriptDialog, isRestorableCheckpointCookie, javascriptDialogHandleParams, loadAllStr, mockStr, nativeDialogDismissedError, nativeDialogShouldAccept, netlogRequestStr, netlogStr, observeAfterActionGuardingDialogs, parseCheckpointArgs, parseCheckpointArtifact, parseClockArgs, parseComponentsArgs, parseCookieArgs, parseLoadAllArgs, parseMockArgs, parseRestoreArgs, parseTextArgs, parseThrottleArgs, reactComponentsTreeScript, readNetlogResponseBody, redactExternalInputActionError, redactRestoreActionError, redactRestoreCommandArgs, rememberViewportReadback, restoreCheckpointStr, restoreStorageScript, sampleRootFrameTables, sanitizeCheckpointCookies, sanitizeCheckpointStorage, sanitizeComponentResult, sanitizeComponentValue, setDialogMode, shouldSkipActionPageEvaluate, stylesStr, tableCollectionStr, tableObservationStr, takeAcceptDialogFlag, textPageScript, textStr, throttleModel, throttleStr, uploadStr, viewportStr, vueComponentsTreeScript, waitForActionNetworkQuiet } from './lib/cdp-page-commands.mjs';
import { attachRefToVisibleControl, axInteractiveBackendCount, baselineOutputForActionTarget, buildPerceiveDiffModel, buildPerceiveTree, chooseAdaptivePerceiveLast, clickableBoxHelpersSource, collectDomInteractiveControls, compactVisibleControlsModel, controlsStr, countedInteractiveElements, dedupeRepeatedLines, discardHoverIdleBaseline, elementScreenshotClip, extractVisibleControlLabels, filterPerceiveExcludedAxNodes, flattenFrameTree, formatFrameTreeText, formatPerceiveDiffOutput, formatRefRect, formatUnknownRefError, formatVisibleControlLine, formatVisibleControlsText, frameRefFromActionTarget, frameViewportOffset, framesModel, framesStr, hoverRecaptureShowsChange, invalidateSessionRefs, isPerceiveDecorativeTitleChrome, isRef, isSearchListingControl, isSearchListingHref, isSearchListingText, isSkipLinkAxNode, isSkipLinkName, isSynthesizableDomControl, isVisibleControlTimestampName, listDomInteractiveControls, mergeMissingDomInteractiveAxNodes, nativeVisibleControlTag, offsetCssRect, offsetCursorInteractiveItem, omitTypeaheadListboxNodes, parseControlsArgs, parseElshotArgs, parseFrameArgs, parseFrameOnlyRef, parseFrameRef, parsePerceiveArgs, perceiveArgsIncludeSnapshotShape, perceiveDiffModel, perceiveInteractiveNoiseHint, perceiveModel, perceivePageScript, perceiveSnapshotOpts, perceiveStr, perceiveTextboxValueFromOutput, perceptionModelFromText, pickPrimaryScrollMetrics, qualifyFrameRefsInLines, rankPerceiveCursorItems, rankSearchListingFirst, refAnnotationsFromTreeLines, rememberFramePerceiveOutput, renderedInteractiveSource, resolveFrameRef, resolveRef, resolveRefNode, resolveSinceActionPerceiveOpts, scrollSettledRectFunctionDeclaration, searchListingSelector, shouldPreservePerceiveRefs, shouldSynthesizeMissingFrameInteractives, storeFrameScopedRefs, stripPerceiveIdentityChrome, stripPerceiveNodeIdentity, stripPerceiveRectChrome, syntheticAxNodeFromDomControl, uniqueVisibleControlCapSwapSamples, validateUrl, visibleControlNameFromLine, visibleControlsCollectorSource, visibleControlsPageScript, waitForHoverDomChange, waitForSettle } from './lib/cdp-perceive.mjs';
import { appendSessionActionLog, appendSessionEnvironmentLog, appendSessionEventLog, appendSessionExitLog, appendSessionScreenshot, buildConsoleModel, buildQaPageModel, buildRecordActionsModel, buildRecordEnvironmentModel, buildResponsiveAuditModel, buildSemanticInteractionModel, buildSessionReportModel, buildStatusModel, captureViewportSize, clearConsoleBaseline, consoleStr, countNetworkFailures, createDaemonExitLog, createDaemonFillCapability, createRuntimePruneScheduler, createSessionState, currentSessionActionSequence, diffShotScreenshotCaptureOptions, ensureSessionScreenshotDir, formatActionWorkflowCommandOutput, formatExportPlaywright, formatPlaywrightSpecFromRecordActions, formatQaPageReport, formatRecordActions, clearRecordedActions, parseRecordActionsArgs, recordActionsClearModel, formatResponsiveAuditReport, formatSemanticInteractionResult, formatSessionReport, initializeSessionLog, isSensitiveActionTarget, liveRuntimeArtifactTargetIds, markSessionActionsPolicyFailed, nextSessionScreenshotPath, pageInfoModel, parseQaArgs, parseReportArgs, parseResponsiveAuditArgs, playwrightStepFromCommand, pruneRuntimeArtifacts, qaPageStr, qaScreenshotCaptureOptions, rememberSessionSecret, resolveRequestSecret, responsiveAuditStr, responsiveAuditViewportScript, restoreAuditViewport, runActionWithFeedback, runDaemonRequestScope, scrubDaemonResponse, scrubSessionSecrets, selectConsoleEntries, sessionDownloadDir, sessionScreenshotDir, statusStr, summaryModel, summaryStr } from './lib/cdp-session-report.mjs';


const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
export { executeCdpCli } from './lib/cdp-main.mjs';

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
  FULLSHOT_MAX_CAPTURE_HEIGHT, FULLSHOT_TIMEOUT_MS, screenshotCaptureUsesSessionTier, capFullshotHeight, formatFullshotOutput, formatFullshotReceipt, fullshotFitsViewport, fullshotPlanError, fullshotScrollPlanExpression, parseFullshotArgs, fullshotStr, scanshotStr,
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
  buildRecordActionsModel, formatRecordActions, parseRecordActionsArgs, clearRecordedActions, recordActionsClearModel,
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
  isLeftoverDefaultAxScrollSettle, stripPerceiveRectChrome, stripPerceiveIdentityChrome, stripPerceiveNodeIdentity,
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
  buildCliErrorRecovery, cliErrorFromDaemonResponse, ERROR_KINDS,
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
