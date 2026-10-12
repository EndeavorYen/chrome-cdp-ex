// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { COMMAND_SURFACE } from './command-surface.mjs';
import { claimDaemonEndpoint, connectToDaemon, daemonEndpointForPlatform, daemonEndpointTooLongError, probeDaemonEndpoint, requestDaemon, watchDaemonSocket } from './daemon-transport.mjs';
import { withoutSecretEnv } from './secrets.mjs';
import { isTableCollectArgs } from './table-contract.mjs';
import { spawn, spawnSync } from 'child_process';
import { lstatSync, statSync, unlinkSync } from 'fs';
import { DAEMON_CONNECT_DELAY, DAEMON_CONNECT_RETRIES, DAEMON_IDLE_EXIT_GRACE_MS, DAEMON_IDLE_EXIT_MARGIN_MS, DAEMON_PAGE_LIST_PROBE_TIMEOUT_MS, DAEMON_SIDE_EFFECT_AUTHORIZATIONS, DEFAULT_CDP_HOST, ENDPOINT_ABSENT_CODES, FOREGROUND_ACTIVATE_COMMAND, MIN_TARGET_PREFIX_LEN, REVEAL_POLL_TIMEOUT_MS, RUNTIME_DIR, SOURCE_MAP_LATE_REPLY_TIMEOUT_MS, STOP_KILL_POLLS, STOP_KILL_POLL_MS, STOP_PROBE_TIMEOUT_MS, STOP_REQUEST_TIMEOUT_MS, sleep } from './cdp-base.mjs';
import { assessDaemonFreshness, formatDaemonStartFailure, formatJson, formatStaleDaemonMessage, getDisplayPrefixLength, listDaemonSockets, parseDaemonMetadataResult, resolvePrefix } from './cdp-browser.mjs';
import { createDaemonShutdown, explicitBackgroundChoice, listDaemonRecords, readDaemonCrashReport, readDaemonRecord, removeDaemonRecord, removeOwnDaemonRecord, writeDaemonRecord } from './cdp-core.mjs';
import { probePageVisibility } from './cdp-input.mjs';
import { cdpDomains } from './cdp-page.mjs';

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
