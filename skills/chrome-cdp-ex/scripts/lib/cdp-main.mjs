// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { createLocatorPlan } from './browser-resources.mjs';
import { createBrowserSupervisor } from './browser-supervisor.mjs';
import { absolutizeExpectDownloadOut } from './click-download.mjs';
import { withoutSecretEnv } from './secrets.mjs';
import { deniedCommandMessage, isContentBoundary, navigationBlockedMessage, policyPreflightMessage, policyRequestFields, readSessionPolicy, urlFlagValue, wrapContentBoundary } from './session-policy.mjs';
import { attachTargetResolutionDiagnostics, completeTargetResolution } from './target-binding.mjs';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { format as formatValue } from 'util';
import { ALLOW_STALE_DAEMON_FLAG, CDP_SCRIPT_PATH, DAEMON_ALLOW_DELAY, DEFAULT_CDP_HOST, NEEDS_TARGET, OPEN_CREATED_TARGET_URL, PAGES_CACHE, sleep } from './cdp-base.mjs';
import { CDP, _browserInfo, aliasEnv, bindAndSaveTargetAlias, buildBroadcastModel, cdpUnreachableError, collectDaemonMetadata, createIsolatedMemberGate, deleteTabGroup, forgetTargetAlias, formatAliasRecord, formatBroadcastResult, formatCurrentAlias, formatJson, formatTabGroup, formatTabGroupStore, formatTargetSelect, getTabGroup, getWsUrl, isolatedOnlyEnabled, listDaemonSockets, listKnownLiveTargetIds, looksLikeAliasToken, normalizeTabGroupName, parseAliasCommandArgs, parseBroadcastArgs, parseFormatArgs, parseListArgs, parseTabGroupArgs, parseTargetSelectArgs, readCachedPages, readTabGroups, recordCommandUsage, rememberLiveCdpEndpointFromSession, removeTabGroupMember, resolvePageCommandTarget, resolvePrefix, resolveTabGroupMembers, resolveTargetAlias, selectPageTarget, takeFollowUrlFlag, unknownAliasError, upsertTabGroup, waitStr, writeTabGroups } from './cdp-browser.mjs';
import { CliExitSignal, absolutizeCallerFileArgs, argsWithoutFormat, backgroundDaemonEnv, buildExactTargetSupervisorCandidates, buildOpenModel, createOpenTarget, detectCliErrorFormat, fillCliArgError, formatArgSuffix, formatCliError, formatDaemonCommandError, cliErrorFromDaemonResponse, formatOpenAttachWaitMessage, formatOpenAutoPerceiveFailure, formatOpenNextPerceiveCommand, formatOpenReadyMessage, formatOpenTimeoutMessage, helpStr, helpTopicStr, isDeterministicTableContinuationResult, navigateOpenTarget, normalizeTargetCommandArgs, parseOpenArgs, parseTargetAndCommandArgs, shouldAnnounceOpenAttachWait, targetCommandCliErrorFormat, targetPrefixForDisplay, unknownCommandMessage, waitForOpenReady } from './cdp-cli.mjs';
import { ensureRuntimeDir, normalizeAliasName, readTargetAliases, sockPath, writeTabBackgroundMode, writeTargetAliases } from './cdp-core.mjs';
import { assertFreshDaemonForCommand, cliRequestSecrets, connectToSocket, discoverLivePagesForTargetResolution, foregroundActivationRequest, formatStopResult, getOrStartTabDaemon, listPagesFromMatchingDaemon, preflightDaemonApplication, runDaemon, sendCommand, stopDaemons } from './cdp-daemon.mjs';
import { checkCdpReachability, formatDoctorOutput, runDoctorChecks, spawnDebugBrowserStr } from './cdp-doctor.mjs';
import { classifyCommandResultSemantics, commandMeta, policyCompositeSteps } from './cdp-flow.mjs';
import { absolutizeElshotFileArg } from './cdp-input.mjs';
import { formatPageListOutput, getPages, normalizeEvalCliArgs } from './cdp-page.mjs';
import { absolutizeNetlogOutArg, boundedTableObservationEmissionJson, boundedTableObservationEmissionText } from './cdp-page-commands.mjs';
import { validateUrl } from './cdp-perceive.mjs';

export function cdpRuntimeIdentity(processLike = process) {
  return Object.freeze({
    execPath: processLike.execPath,
    scriptPath: CDP_SCRIPT_PATH,
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
    argv: { value: [hostProcess.execPath, CDP_SCRIPT_PATH, ...argv], writable: true },
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
export function emitTargetCommandResponse(response, {
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
    if (response.errorSource && typeof error === 'string') {
      error = cliErrorFromDaemonResponse({ ...response, error });
    }
    // The arguments let a recovery rerun the same command (#488 hidden-tab).
    console.error(formatDaemonCommandError(error, { cmd, targetPrefix, format, args }));
    process.exitCode = 1;
  }
}
export async function main(options = {}) {
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
