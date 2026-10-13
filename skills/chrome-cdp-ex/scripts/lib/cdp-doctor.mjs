// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { actionTargetCommandPrefix, recoveryCommandArg } from './action-recovery.mjs';
import { BROWSER_COMMANDS, defaultBrowserPaths, detectBrowserPath } from './browser-paths.mjs';
import { ASK_HUMAN_FIRST_LINE, formatNextLine } from './next-line.mjs';
import { NODE22_MISSING_HINT, discoverNode22, formatNodeRerunCommand, nodeMajor } from './node-runtime.mjs';
import { spawn, spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import net from 'net';
import { homedir } from 'os';
import { resolve, win32 as win32Path } from 'path';
import { BACKGROUND_THROTTLE_FLAGS, CDP_SCRIPT_PATH, CHROMIUM_VERSION_DIR_RE, DAILY_BROWSER_APP_NAMES, DEFAULT_CDP_HOST, DEFAULT_CDP_PROBE_PORT, DEFAULT_DEBUG_PORT, DEFAULT_PROFILE_REMOTE_DEBUGGING_BLOCKED_MAJOR, DEFAULT_SPAWN_READY_TIMEOUT_MS, DISMISS_MODAL_ESCAPE_CHECKS, DISMISS_MODAL_ESCAPE_CHECK_MS, DOCTOR_LIST_TARGET_PLACEHOLDER, IS_WINDOWS, OCCLUDED_WINDOWS_FLAG, SPAWN_ALIVE_WAIT_CAP_MS, SPAWN_DEBUG_BROWSER_FLAGS, SPAWN_DEBUG_BROWSER_NOTES, SPAWN_DEBUG_BROWSER_VIA, cdpProfileKey, pathApiForPlatform, pathApiForRoot, profileDirFromCommandLine, sleep } from './cdp-base.mjs';
import { CDP, browserWebSocketOpens, cdpCheckFromDiagnosis, cdpDiscoveryMiss, cdpUnreachableDiagnosis, classifyBrowserProfile, describeBrowserProfile, devToolsActivePortCandidates, fetchFailureText, formatDuration, formatJson, getDisplayPrefixLength, isElectronUserAgent, listDaemonSockets, parseFormatArgs, profileDirFromDevToolsActivePort, rankPageTargets, readBrowserProcessArgv, readCdpUserAgent, rememberedCdpProbePort, selectPageTarget, withLiveLaunchFlags, wsUrlFromCdpHttp } from './cdp-browser.mjs';
import { parseNonNegativeInteger } from './cdp-cli.mjs';
import { cdpDisplayContext, explicitBackgroundChoice, formatCdpCandidateList, inspectCdpOccupantProfileDirViaCdp, isDisposableSpawnProfileDir, isIsolatedChromeCdpExProfileDir, isolatedOccupantAsk, isolatedOccupantAttachError, isolatedOccupantCdpCheck, readLastCdpEndpoint, rememberLastCdpEndpoint, replayableLaunchFlags, resolveOccupantProfileDir, shellQuoteCliArg } from './cdp-core.mjs';
import { checkSkillSymlink, doctorCliPrefix } from './cdp-flow.mjs';
import { pressStr } from './cdp-input.mjs';
import { cdpDomains, evalStr } from './cdp-page.mjs';
import { isRef, parseFrameRef, resolveRefRectNoScroll } from './cdp-perceive.mjs';

// --- Doctor: one-call diagnostics ---
export function checkNode(version = process.version, opts = {}) {
  const major = nodeMajor(version);
  if (major >= 22) return { status: 'OK', label: 'Node', detail: `${version} (>= 22)` };
  const cdpScriptPath = opts.cdpScriptPath || CDP_SCRIPT_PATH;
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
export function checkDaemonSockets({ list = listDaemonSockets } = {}) {
  const daemons = list();
  if (!daemons || daemons.length === 0) {
    return { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] };
  }
  const ids = daemons.map(d => (d.targetId || '').slice(0, 8)).filter(Boolean);
  return {
    status: 'OK', label: 'Daemons',
    detail: `${daemons.length} live: ${ids.join(', ')}`,
    targetPrefixes: ids,
  };
}
export function detectFdLimit({ runner = spawnSync } = {}) {
  if (IS_WINDOWS) return null;
  try {
    const res = runner('/bin/sh', ['-lc', 'ulimit -n'], { encoding: 'utf8', timeout: 1000 });
    if (res.status !== 0) return null;
    const raw = String(res.stdout || '').trim();
    if (raw === 'unlimited') return Number.POSITIVE_INFINITY;
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : null;
  } catch {
    return null;
  }
}
export function fdLimitRecovery({ platform = process.platform } = {}) {
  const commands = [
    {
      scope: 'current-shell',
      command: 'ulimit -n 4096',
      reason: 'Raise the open-files limit for this terminal before starting long chrome-cdp-ex sessions.',
      requiresAdmin: false,
    },
  ];
  if (platform === 'darwin') {
    commands.push({
      scope: 'macos-login-session',
      command: 'sudo launchctl limit maxfiles 65536 200000',
      reason: 'Raise the macOS launchd limit for GUI apps and future shells; rerun doctor afterwards.',
      requiresAdmin: true,
    });
  }
  return {
    schema: 'chrome-cdp-ex.fd-limit-recovery.v1',
    strategy: 'raise-open-files-limit',
    commands,
  };
}
export function checkFdLimit({ limit = detectFdLimit(), platform = process.platform } = {}) {
  const recovery = fdLimitRecovery({ platform });
  if (limit == null) {
    return {
      status: 'WARN',
      label: 'FD limit',
      detail: 'open-files limit unavailable',
      hint: 'If you see "Too many open files", rerun commands with: ulimit -n 4096',
      recovery,
    };
  }
  if (limit >= 1024) {
    const text = limit === Number.POSITIVE_INFINITY ? 'unlimited' : String(limit);
    return { status: 'OK', label: 'FD limit', detail: `${text} open files` };
  }
  return {
    status: 'WARN',
    label: 'FD limit',
    detail: `${limit} open files (low for long browser sessions)`,
    hint: 'Raise for this shell with: ulimit -n 4096',
    recovery,
  };
}
export function defaultSpawnProbePorts(env = {}) {
  const ports = [String(DEFAULT_DEBUG_PORT)];
  const lastPort = env.CDP_LAST_PORT;
  if (lastPort && String(lastPort) !== ports[0]) ports.push(String(lastPort));
  return ports;
}
export async function checkCdpReachability({
  env = process.env,
  fetcher = fetch,
  host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1',
  lastEndpoint,
  readLastEndpoint = readLastCdpEndpoint,
  rememberEndpoint = rememberLastCdpEndpoint,
  connectWebSocket,
  inspectOccupantProfileDir,
  inspectProfileProcess,
  display = cdpDisplayContext(),
  home = homedir(),
  existsSync: pathExists = existsSync,
} = {}) {
  const port = env.CDP_PORT;
  const remembered = lastEndpoint !== undefined ? lastEndpoint : readLastEndpoint();
  const rememberReachable = (record) => {
    try { rememberEndpoint(withLiveLaunchFlags(record, { remembered, inspectProfileProcess })); } catch {}
  };
  const unreachable = (p, cause) => cdpCheckFromDiagnosis(cdpUnreachableDiagnosis({
    host,
    port: p,
    cause,
    lastEndpoint: remembered,
    display,
    inspectProfileProcess,
  }));
  const tryPaths = devToolsActivePortCandidates({
    home,
    localAppData: env.LOCALAPPDATA || process.env.LOCALAPPDATA || '',
    portFile: env.CDP_PORT_FILE,
  });
  const activeWsPath = (p) => {
    try {
      const file = tryPaths.find(pathExists);
      if (!file) return null;
      const [filePort, wsPath] = readFileSync(file, 'utf8').trim().split('\n');
      return String(filePort) === String(p) ? wsPath : null;
    } catch {
      return null;
    }
  };
  const tryFetch = async (p) => {
    const res = await fetcher(`http://${host}:${p}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  const describe = (info) => {
    const product = info.Browser || info.product || 'unknown browser';
    const ua = info['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    return m ? `${product} (Electron ${m[1]})` : product;
  };
  const checkExplicitPort = async (p) => {
    try {
      const info = await tryFetch(p);
      if (!info.webSocketDebuggerUrl) {
        return {
          status: 'WARN', label: 'CDP', detail: `port ${p}: no webSocketDebuggerUrl`,
          hint: 'Browser exposes /json/version but not the debugger WebSocket — toggle remote debugging again',
          host,
          port: String(p),
        };
      }
      rememberReachable({ host, port: p });
      return { status: 'OK', label: 'CDP', detail: `${host}:${p} → ${describe(info)}`, host, port: String(p) };
    } catch (e) {
      // Chrome 136+ / websocket-only: HTTP 404 still has a live /devtools/browser socket.
      // Connection refused, timeout, and other HTTP failures must fail fast.
      if (await browserWebSocketOpens(e, { host, port: p, wsPath: activeWsPath(p), connectWebSocket })) {
        rememberReachable({ host, port: p });
        return { status: 'OK', label: 'CDP', detail: `${host}:${p} → connected via WebSocket fallback`, host, port: String(p) };
      }
      return { unreachable: true, cause: fetchFailureText(e) };
    }
  };
  const classifyDefaultProbe = async (result) => {
    if (!result || result.unreachable || result.status !== 'OK') return result;
    const profileDir = await resolveOccupantProfileDir({
      host: result.host || host,
      port: result.port,
      remembered,
      inspectOccupantProfileDir,
      connectWebSocket,
    });
    if (isIsolatedChromeCdpExProfileDir(profileDir)) {
      return isolatedOccupantCdpCheck({
        host: result.host || host,
        port: result.port,
        profileDir,
      });
    }
    return result;
  };
  // Why each probed port failed, for the one miss diagnosis below (shared with every attach).
  const probed = {};
  const probeAttach = async (candidate, note) => {
    const result = await checkExplicitPort(candidate);
    if (result.unreachable) {
      probed[String(candidate)] = result.cause;
      return null;
    }
    if (result.status !== 'OK') return null;
    return classifyDefaultProbe({ ...result, detail: `${result.detail} (${note})` });
  };
  if (port) {
    const result = await checkExplicitPort(port);
    if (result.unreachable) return unreachable(port, result.cause);
    return result;
  }
  for (const candidate of defaultSpawnProbePorts(env)) {
    const result = await probeAttach(candidate, 'probed default spawn port');
    if (result) return result;
  }

  // Auto-discover via DevToolsActivePort (light reuse — avoids full ws connect)
  const found = tryPaths.find(p => pathExists(p));
  // 9224, then the remembered port. Shared by a missing file (#425) and a file whose
  // port did not answer (#558). Null when neither answers.
  const laterUnprefixedPort = async () => {
    if (!Object.hasOwn(probed, String(DEFAULT_CDP_PROBE_PORT))) {
      const probedDefault = await checkExplicitPort(DEFAULT_CDP_PROBE_PORT);
      if (!probedDefault.unreachable) return probedDefault;
      probed[DEFAULT_CDP_PROBE_PORT] = probedDefault.cause;
    }
    const rememberedPort = rememberedCdpProbePort(remembered, host, probed);
    if (!rememberedPort) return null;
    return probeAttach(rememberedPort, 'remembered last endpoint');
  };
  if (!found) {
    const later = await laterUnprefixedPort();
    if (later) return later;
    // Unset CDP_PORT: empty 9222 is daily-profile (ask first), not a stale default-profile relaunch
    // (Chrome leftover must not beat preferred Edge). Same diagnosis as every attach (#425).
    return cdpCheckFromDiagnosis(cdpDiscoveryMiss({ host, remembered, probed, display, inspectProfileProcess }));
  }
  let lines;
  try {
    lines = readFileSync(found, 'utf8').trim().split('\n');
  } catch (e) {
    return { status: 'WARN', label: 'CDP', detail: `cannot read ${found}: ${e.message}`, host };
  }
  if (lines.length < 2 || !lines[0]) {
    return { status: 'WARN', label: 'CDP', detail: `invalid DevToolsActivePort at ${found}`, host };
  }
  const discoveredPort = lines[0];
  const discoveredProfile = profileDirFromDevToolsActivePort(found);
  try {
    const info = await tryFetch(discoveredPort);
    rememberReachable({ host, port: discoveredPort, profileDir: discoveredProfile });
    return { status: 'OK', label: 'CDP', detail: `${host}:${discoveredPort} → ${describe(info)} (auto-discovered)`, host, port: String(discoveredPort) };
  } catch (e) {
    if (await browserWebSocketOpens(e, { host, port: discoveredPort, wsPath: lines[1], connectWebSocket })) {
      rememberReachable({ host, port: discoveredPort, profileDir: discoveredProfile });
      return { status: 'OK', label: 'CDP', detail: `${host}:${discoveredPort} → connected via WebSocket (auto-discovered)`, host, port: String(discoveredPort) };
    }
    // The file named a dead port. Probe 9224 and the remembered endpoint before
    // telling the agent the browser is down (#558). Do not remember this port.
    probed[String(discoveredPort)] = fetchFailureText(e);
    const later = await laterUnprefixedPort();
    if (later) return later;
    return {
      status: 'WARN', label: 'CDP',
      detail: `DevToolsActivePort points to ${discoveredPort} but /json/version unreachable: ${e.message}`,
      hint: 'Browser may have stopped — re-toggle chrome://inspect/#remote-debugging',
      host,
      port: String(discoveredPort),
    };
  }
}
export function normalizeBrowserTargetInfo(target) {
  return {
    targetId: target.targetId || target.id || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
  };
}
export function isDebuggablePageTarget(target) {
  return target.type === 'page'
    && target.targetId
    && !target.url.startsWith('chrome://')
    && !target.url.startsWith('edge://')
    && !target.url.startsWith('devtools://');
}
export async function checkBrowserTargets({ cdp = null, env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  if (cdp?.status !== 'OK') {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'skipped until CDP is reachable',
      hint: 'Fix CDP first, then rerun: cdp doctor',
      targetPrefixes: [],
    };
  }
  const port = cdp.port || env.CDP_PORT;
  const cdpHost = cdp.host || host;
  if (!port) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'cannot list tabs without a CDP port',
      hint: 'Rerun: cdp doctor, then use the printed CDP/open path.',
      targetPrefixes: [],
    };
  }

  let targets = [];
  try {
    const res = await fetcher(`http://${cdpHost}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    targets = Array.isArray(raw) ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
  } catch (e) {
    try {
      const wsUrl = `ws://${cdpHost}:${port}/devtools/browser`;
      const ws = new WebSocket(wsUrl);
      const targetsResult = await new Promise((resolveWs, rejectWs) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.id === 1 && data.result?.targetInfos) {
              resolveWs(data.result.targetInfos);
            }
          } catch {}
        };
        ws.onerror = (err) => rejectWs(err);
        setTimeout(() => { ws.close(); rejectWs(new Error('WebSocket timeout')); }, 3000);
      });
      ws.close();
      targets = Array.isArray(targetsResult) ? targetsResult.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
    } catch {
      return {
        status: 'WARN',
        label: 'Tabs',
        detail: `cannot list debuggable page targets (${e.message})`,
        hint: 'Run: cdp list. If it is empty, run: cdp open https://example.com',
        targetPrefixes: [],
      };
    }
  }

  if (targets.length === 0) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'no debuggable page targets',
      hint: 'Create one with: cdp open https://example.com',
      targetPrefixes: [],
      noTargets: true,
    };
  }
  const ranked = rankPageTargets(targets);
  const prefixLen = getDisplayPrefixLength(targets.map(target => target.targetId));
  const targetPrefixes = ranked.map(target => target.targetId.slice(0, prefixLen));
  const labels = ranked.slice(0, 3).map((target, index) => {
    const title = target.title || (target.url === 'about:blank' ? '(blank tab)' : target.url || '(untitled)');
    return `${targetPrefixes[index]} ${title}`.trim();
  });
  const suffix = ranked.length > labels.length ? `, +${ranked.length - labels.length} more` : '';
  return {
    status: 'OK',
    label: 'Tabs',
    detail: `${targets.length} debuggable page target${targets.length === 1 ? '' : 's'}: ${labels.join(', ')}${suffix}`,
    targetPrefixes,
    pages: ranked.map(target => ({
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      type: target.type,
    })),
  };
}
export function doctorTabCount(tabs = {}, daemons = {}, permission = {}) {
  if (Array.isArray(tabs.pages) && tabs.pages.length) return tabs.pages.length;
  if (Array.isArray(tabs.targetPrefixes) && tabs.targetPrefixes.length) return tabs.targetPrefixes.length;
  if (Array.isArray(permission.targetPrefixes) && permission.targetPrefixes.length) {
    return permission.targetPrefixes.length;
  }
  return (daemons.targetPrefixes || []).length;
}
export function doctorRankedTargetPrefix(tabs = {}, daemons = {}, permission = {}) {
  const pages = Array.isArray(tabs.pages) ? tabs.pages : [];
  if (pages.length) {
    const ranked = rankPageTargets(pages);
    const prefixLen = getDisplayPrefixLength(pages.map(page => page.targetId || page.id || ''));
    const id = ranked[0]?.targetId || ranked[0]?.id || '';
    if (id) return id.slice(0, prefixLen);
  }
  return tabs.targetPrefixes?.[0]
    || permission.targetPrefixes?.[0]
    || daemons.targetPrefixes?.[0]
    || null;
}
export function doctorProbeFromTargets({ tabs = {}, daemons = {}, permission = {}, prefix = 'cdp' } = {}) {
  const tabCount = doctorTabCount(tabs, daemons, permission);
  const targetPrefix = doctorRankedTargetPrefix(tabs, daemons, permission);
  const multi = tabCount > 1;
  const exampleTarget = multi ? DOCTOR_LIST_TARGET_PLACEHOLDER : (targetPrefix || '<target>');
  return {
    tabCount,
    targetPrefix,
    exampleTarget,
    multi,
    provenCommand: `${prefix} list`,
    probeNote: multi ? `${tabCount} tabs — pick with ${prefix} list / ${prefix} target --url` : null,
    listIsSourceOfTruth: true,
  };
}
export function doctorProbeFromChecks(checks = []) {
  const node = checks.find(check => check.label === 'Node');
  return doctorProbeFromTargets({
    tabs: checks.find(check => check.label === 'Tabs') || {},
    daemons: checks.find(check => check.label === 'Daemons') || {},
    permission: checks.find(check => check.label === 'Permission') || {},
    prefix: doctorCliPrefix(node),
  });
}
export function checkBrowserPermission({ daemons = null, tabs = null, cdp = null, environment = null } = {}) {
  const daemonPrefixes = daemons?.targetPrefixes || [];
  const probe = doctorProbeFromTargets({ tabs: tabs || {}, daemons: daemons || {} });
  if (daemonPrefixes.length > 0) {
    return {
      status: 'OK',
      label: 'Permission',
      detail: `debugging approved for ${daemonPrefixes.join(', ')}`,
      severity: 'ok',
      provenCommand: probe.provenCommand,
      probeNote: probe.probeNote,
      targetPrefixes: daemonPrefixes,
    };
  }

  const tabPrefixes = tabs?.targetPrefixes || [];
  const headless = Boolean(environment?.environment?.headlessLikely || environment?.headlessLikely);
  const cdpReachable = cdp?.status === 'OK';
  if (tabPrefixes.length > 0) {
    const target = probe.targetPrefix || tabPrefixes[0];
    const next = probe.provenCommand;
    // CDP + tabs are enough for agents to proceed; missing daemon approval is advisory.
    return {
      status: 'WARN',
      label: 'Permission',
      detail: headless && cdpReachable
        ? `headless CDP is reachable; tab daemon not attached yet for ${target}`
        : `browser debugging approval not confirmed for ${target}`,
      hint: headless && cdpReachable
        ? `Non-blocking. Run: ${next}. UI "Allow debugging?" is not required for headless sessions when CDP works.`
        : `Run: ${next}; if Chrome asks "Allow debugging?", click Allow`,
      severity: 'advisory',
      provenCommand: cdpReachable ? next : null,
      nextProbe: next,
      probeNote: probe.probeNote,
      targetPrefixes: tabPrefixes,
    };
  }

  if (tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '')) {
    return {
      status: 'WARN',
      label: 'Permission',
      detail: 'no target available to request browser debugging approval',
      hint: 'Run: cdp open https://example.com; if Chrome asks "Allow debugging?", click Allow',
      severity: 'warning',
      targetPrefixes: [],
    };
  }

  return {
    status: 'WARN',
    label: 'Permission',
    detail: 'skipped until CDP and tabs are reachable',
    hint: 'Fix CDP/tabs first, then rerun: cdp doctor',
    severity: 'warning',
    targetPrefixes: [],
  };
}
export function normalizePreferredBrowserName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'edge' || raw === 'msedge' || raw === 'microsoft-edge') return 'edge';
  if (raw === 'chrome' || raw === 'google-chrome' || raw === 'chromium' || raw === 'google chrome') return 'chrome';
  if (raw === 'brave' || raw === 'brave-browser') return 'brave';
  if (/edgemac|microsoft\.edge/.test(raw)) return 'edge';
  if (/google\.chrome|chromium/.test(raw)) return 'chrome';
  if (/brave/.test(raw)) return 'brave';
  return null;
}
export function pickPreferredBrowser(candidates, { env = {}, defaultBrowser } = {}) {
  const named = normalizePreferredBrowserName(env.CDP_DEBUG_BROWSER || env.CDP_DAILY_BROWSER || defaultBrowser);
  if (named) {
    const match = candidates.find(candidate => candidate.browser === named);
    if (match) return match;
  }
  return candidates.find(candidate => candidate.browser === 'chrome') || candidates[0] || null;
}
export function detectDefaultBrowserName({
  platform = process.platform,
  env = process.env,
  home,
  spawnSyncFn = spawnSync,
} = {}) {
  if (platform !== 'darwin') return null;
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  const plist = resolve(resolvedHome, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
  try {
    const result = spawnSyncFn('plutil', ['-convert', 'json', '-o', '-', plist], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (result?.status !== 0 || !result.stdout) return null;
    const data = JSON.parse(result.stdout);
    const handlers = Array.isArray(data?.LSHandlers) ? data.LSHandlers : [];
    const http = [...handlers].reverse().find(handler => (
      handler?.LSHandlerURLScheme === 'http' || handler?.LSHandlerURLScheme === 'https'
    ));
    return normalizePreferredBrowserName(http?.LSHandlerRoleAll || http?.LSHandlerRoleViewer || '');
  } catch {
    return null;
  }
}
export function detectRuntimeEnvironment({
  platform = process.platform,
  env = process.env,
  fs = { existsSync, readdirSync },
  defaultBrowser,
  spawnSyncFn,
} = {}) {
  const displayAvailable = Boolean(env?.DISPLAY || env?.WAYLAND_DISPLAY);
  const remoteSignals = [
    env?.SSH_CONNECTION,
    env?.SSH_CLIENT,
    env?.REMOTE_CONTAINERS,
    env?.CODESPACES,
    env?.CI,
    env?.CONTAINER,
  ].filter(Boolean);
  const headlessLikely = platform === 'linux' && !displayAvailable;
  const browserCandidates = ['chrome', 'edge', 'brave']
    .map(browser => ({ browser, executable: detectBrowserPath(browser, platform, fs, env) }))
    .filter(candidate => candidate.executable);
  const detectedDefault = defaultBrowser !== undefined
    ? defaultBrowser
    : detectDefaultBrowserName({ platform, env, spawnSyncFn });
  const preferredRaw = pickPreferredBrowser(browserCandidates, { env, defaultBrowser: detectedDefault });
  const preferred = preferredRaw?.executable
    ? {
      ...preferredRaw,
      major: detectChromiumMajorVersion(preferredRaw.executable, {
        fs,
        platform,
        spawnSyncFn: spawnSyncFn || spawnSync,
      }),
    }
    : preferredRaw;
  return {
    platform,
    displayAvailable,
    remoteLikely: remoteSignals.length > 0,
    headlessLikely,
    sandboxMayNeedNoSandbox: platform === 'linux' && (headlessLikely || Boolean(env?.CI) || Boolean(env?.CONTAINER)),
    browserCandidates,
    preferredBrowser: preferred,
  };
}
export function preferredDebugBrowserName(environment) {
  return environment?.environment?.preferredBrowser?.browser
    || environment?.preferredBrowser?.browser
    || 'edge';
}
export function isolatedSpawnProfileDir(browser, port, env = process.env) {
  const tmp = String((env && env.TMPDIR) || '/tmp').replace(/\/$/, '');
  return `${tmp}/chrome-cdp-ex-${browser}-debug-profile-${port}`;
}
export function persistentDailyUserDataDir(browser, { platform = process.platform, env = process.env, home } = {}) {
  const p = pathApiForPlatform(platform);
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  const name = browser === 'chrome' || browser === 'brave' ? browser : 'edge';
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || p.resolve(resolvedHome, 'AppData', 'Local');
    return p.resolve(local, 'chrome-cdp-ex', `daily-${name}`);
  }
  if (platform === 'darwin') {
    return p.resolve(resolvedHome, 'Library', 'Application Support', 'chrome-cdp-ex', `daily-${name}`);
  }
  const xdg = env.XDG_CONFIG_HOME || p.resolve(resolvedHome, '.config');
  return p.resolve(xdg, 'chrome-cdp-ex', `daily-${name}`);
}
export function persistentDailyDirOptions(environment) {
  const info = environment?.environment || environment || {};
  return {
    platform: info.platform || process.platform,
    env: info.env || process.env,
    home: info.home,
  };
}
export function defaultIsolatedSpawnCommand(environment, prefix = 'cdp') {
  const browser = preferredDebugBrowserName(environment);
  const dir = isolatedSpawnProfileDir(browser, DEFAULT_DEBUG_PORT);
  return `${prefix} spawn-debug-browser ${browser} --port ${DEFAULT_DEBUG_PORT} --user-data-dir ${shellQuoteCliArg(dir)} --url https://example.com`;
}
export function defaultPersistentDailySpawnCommand(environment, prefix = 'cdp') {
  const browser = preferredDebugBrowserName(environment);
  const dir = persistentDailyUserDataDir(browser, persistentDailyDirOptions(environment));
  return `${prefix} spawn-debug-browser ${browser} --port ${DEFAULT_DEBUG_PORT} --user-data-dir ${shellQuoteCliArg(dir)}`;
}
export function preferredBrowserMajor(environment) {
  const pb = environment?.environment?.preferredBrowser || environment?.preferredBrowser;
  const n = Number(pb?.major ?? pb?.chromiumMajor);
  return Number.isFinite(n) ? n : null;
}
export function emptyCdpBlockedOnDefaultProfile(environment) {
  return defaultProfileIgnoresRemoteDebugging(preferredBrowserMajor(environment));
}
export function emptyCdpEnableCommand(environment, prefix = 'cdp') {
  return defaultPersistentDailySpawnCommand(environment, prefix);
}
export function emptyCdpEnableAsk(environment, prefix = 'cdp') {
  const browser = preferredDebugBrowserName(environment);
  const cmd = defaultPersistentDailySpawnCommand(environment, prefix);
  if (emptyCdpBlockedOnDefaultProfile(environment)) {
    const platform = environment?.environment?.platform || environment?.platform;
    const running = platform === 'darwin' ? `Dock/default ${browser}` : `the running default ${browser}`;
    return `Chrome 136+ and Microsoft Edge ignore --remote-debugging-port on the default user-data-dir. Quit+relaunch of daily ${browser} does not enable CDP. Launch the persistent daily dir (${cmd}); do not kill ${running}. Isolated spawn is fallback only and is not the daily profile; cookies will not transfer.`;
  }
  return isolatedSpawnFallbackAsk(environment, prefix);
}
export function isolatedSpawnFallbackAsk(environment, prefix = 'cdp') {
  const browser = preferredDebugBrowserName(environment);
  return `Enable debug on the persistent daily ${browser} dir first (${defaultPersistentDailySpawnCommand(environment, prefix)}). Isolated spawn is fallback only and is not the daily profile (${defaultIsolatedSpawnCommand(environment, prefix)}).`;
}
export function environmentRecoveryCommand(envInfo, env = process.env) {
  const candidate = envInfo.preferredBrowser;
  if (!candidate) return null;
  const args = ['cdp spawn-debug-browser', candidate.browser];
  if (envInfo.headlessLikely) args.push('--headless');
  if (envInfo.sandboxMayNeedNoSandbox) args.push('--no-sandbox');
  args.push('--port', '9222');
  args.push('--user-data-dir', shellQuoteCliArg(isolatedSpawnProfileDir(candidate.browser, 9222, env)));
  args.push('--exe', candidate.executable);
  args.push('--url', 'https://example.com');
  return args.join(' ');
}
export function checkRuntimeEnvironment(opts = {}) {
  const info = detectRuntimeEnvironment(opts);
  const command = environmentRecoveryCommand(info, opts.env || process.env);
  if (info.headlessLikely || info.remoteLikely) {
    const traits = [
      info.platform,
      info.remoteLikely ? 'remote/container-like' : null,
      info.headlessLikely ? 'headless/no DISPLAY' : null,
      info.preferredBrowser ? `${info.preferredBrowser.browser} at ${info.preferredBrowser.executable}` : 'no browser executable detected',
    ].filter(Boolean).join(', ');
    return {
      status: info.preferredBrowser ? 'WARN' : 'FAIL',
      label: 'Environment',
      detail: `detected ${traits}`,
      hint: command || 'Install Chrome/Chromium or pass --exe to spawn-debug-browser.',
      environment: info,
      recovery: command ? {
        strategy: 'spawn-headless-debug-browser',
        command,
        requiresUserAction: true,
        consentRequired: true,
      } : null,
    };
  }
  return {
    status: 'OK',
    label: 'Environment',
    detail: `${info.platform}${info.displayAvailable ? ', display available' : ''}`,
    environment: info,
    recovery: null,
  };
}
export function reconcileRuntimeEnvironmentCheck(environment, cdp) {
  if (environment?.label !== 'Environment' || environment.status === 'OK') {
    return environment;
  }
  if (cdp?.status === 'OK') {
    return {
      ...environment,
      status: 'OK',
      detail: `${environment.detail}; CDP reachable`,
      hint: null,
      recovery: null,
    };
  }
  // Configured CDP is down. Do not advertise a blank isolated profile.
  if (cdp?.port || cdp?.profileDir) {
    return {
      ...environment,
      hint: 'CDP_PORT is set; enable remote debugging on that existing browser. Do not spawn a new user-data-dir.',
      recovery: null,
    };
  }
  return environment;
}
export function liveDoctorDaemonPrefixes(checks = []) {
  const daemons = Array.isArray(checks)
    ? checks.find(c => c.label === 'Daemons')
    : checks;
  return (daemons?.targetPrefixes || []).filter(Boolean);
}
export function liveTabSessionCdpHint(prefixes, prefix = 'cdp') {
  return `Live tab daemon already attached (${prefixes.join(', ')}). Do not occupy 9222. Set CDP_PORT=<port> and rerun: CDP_PORT=<port> ${prefix} list.`;
}
export function reconcileCdpWithLiveDaemons(cdp, daemons, { prefix = 'cdp' } = {}) {
  const prefixes = liveDoctorDaemonPrefixes(daemons?.label === 'Daemons' ? [daemons] : daemons);
  if (!prefixes.length || !cdp) return cdp;
  if (cdp.status === 'OK' || cdp.liveTabSession) return cdp;
  // Explicit CDP_PORT / remembered relaunch still describes that endpoint.
  // Isolated leftover on 9222 is not daily attach; a live tab daemon wins.
  if ((cdp.port || cdp.relaunch) && !cdp.isolatedOccupant) return cdp;
  return {
    ...cdp,
    status: 'WARN',
    severity: 'advisory',
    liveTabSession: true,
    detail: `${cdp.detail}; live tab daemon ${prefixes.join(', ')} already attached`,
    hint: liveTabSessionCdpHint(prefixes, prefix),
  };
}
export function normalizeDoctorChecks(checks = []) {
  const list = Array.isArray(checks) ? checks.slice() : [];
  const daemons = list.find(c => c.label === 'Daemons');
  const node = list.find(c => c.label === 'Node');
  const idx = list.findIndex(c => c.label === 'CDP');
  if (idx >= 0) {
    list[idx] = reconcileCdpWithLiveDaemons(list[idx], daemons, {
      prefix: doctorCliPrefix(node),
    });
  }
  return list;
}
export function doctorHasLiveTabSession(cdp, checks = []) {
  if (cdp?.liveTabSession) return true;
  const prefixes = liveDoctorDaemonPrefixes(checks);
  if (!prefixes.length || cdp?.status === 'OK') return false;
  // Isolated leftover on 9222 must not hide a live tab daemon.
  if (cdp?.isolatedOccupant) return true;
  if (cdp?.port || cdp?.relaunch) return false;
  return true;
}
export function doctorWizardSummary(checks) {
  const wizard = doctorWizardModel(checks);
  return [
    'Wizard:',
    `  Status: ${wizard.status}`,
    `  Current step: ${wizard.currentStep}`,
    `  Golden path: ${wizard.goldenPath.join(' -> ')}`,
  ];
}
export function doctorWizardModel(checks) {
  checks = normalizeDoctorChecks(checks);
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const environment = checks.find(c => c.label === 'Environment');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const prefix = doctorCliPrefix(node);

  let status = 'ready for live browser perception';
  let currentStep = `${prefix} list`;
  if (node?.status === 'FAIL') {
    status = 'blocked at Node.js';
    currentStep = node.hint || NODE22_MISSING_HINT;
  } else if (doctorHasLiveTabSession(cdp, checks)) {
    status = 'usable via live tab daemon';
    currentStep = `${prefix} list`;
  } else if (cdp?.status === 'FAIL') {
    status = 'blocked at browser CDP';
    currentStep = cdp.isolatedOccupant
      ? defaultPersistentDailySpawnCommand(environment, prefix)
      : cdp.profileInUse
        ? (cdp.run || cdp.hint)
      : cdp.relaunch
        ? cdp.relaunch
        : cdp.port
          ? `enable browser remote debugging, then rerun: ${prefix} doctor`
          : (environment?.recovery?.command || emptyCdpEnableCommand(environment, prefix));
  } else if (cdp?.status === 'WARN') {
    const rec = doctorRecommendationModel(checks);
    status = 'waiting for stable browser CDP';
    currentStep = rec.run || rec.ask || `${prefix} list`;
  } else if (noTargets) {
    status = 'waiting for a debuggable page';
    currentStep = `${prefix} open https://example.com`;
  } else if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      status = 'usable with advisory notes (CDP reachable)';
      currentStep = `${prefix} list`;
    } else {
      status = 'waiting for browser debugging approval';
      currentStep = `${prefix} list`;
    }
  }

  return {
    status,
    currentStep,
    goldenPath: ['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report'],
    commands: doctorNextStepCommands(checks),
  };
}
export function doctorWarningCommands(checks) {
  const fd = checks.find(c => c.label === 'FD limit');
  const warnings = [];
  if (fd?.status === 'WARN') {
    const commands = Array.isArray(fd.recovery?.commands) && fd.recovery.commands.length
      ? fd.recovery.commands
      : [{ scope: 'current-shell', command: 'ulimit -n 4096', reason: fd.detail || 'open-files limit is low for long browser sessions', requiresAdmin: false }];
    warnings.push({
      label: 'FD limit',
      command: commands[0].command,
      reason: fd.detail || 'open-files limit is low for long browser sessions',
      commands,
    });
  }
  return warnings;
}
export function doctorRecommendationModel(checks) {
  checks = normalizeDoctorChecks(checks);
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const environment = checks.find(c => c.label === 'Environment');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const prefix = doctorCliPrefix(node);
  const base = {
    source: 'doctor-onboarding',
    stage: 'list',
    run: `${prefix} list`,
    ask: null,
    after: null,
    requiresUserAction: false,
    consentRequired: false,
    reason: 'list is the source of truth for which tab.',
    commands: [],
    warnings: doctorWarningCommands(checks),
  };

  if (node?.status === 'FAIL') {
    return {
      ...base,
      stage: 'node',
      run: null,
      ask: NODE22_MISSING_HINT,
      after: `${prefix} doctor`,
      requiresUserAction: true,
      reason: node.detail || null,
    };
  }
  if (doctorHasLiveTabSession(cdp, checks)) {
    const prefixes = liveDoctorDaemonPrefixes(checks);
    return {
      ...base,
      stage: 'list',
      strategy: 'use-live-tab-daemon',
      run: `${prefix} list`,
      ask: `Unprefixed doctor did not find CDP on 9222. Re-run with CDP_PORT=<port> ${prefix} list. Do not occupy 9222.`,
      after: null,
      requiresUserAction: false,
      consentRequired: false,
      reason: `Live tab daemon already attached (${prefixes.join(', ')}).`,
    };
  }
  if (cdp?.status === 'FAIL') {
    if (cdp.isolatedOccupant) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'enable-persistent-daily-dir',
        run: defaultPersistentDailySpawnCommand(environment, prefix),
        ask: isolatedOccupantAsk(environment, { port: cdp.port, profileDir: cdp.profileDir }, prefix),
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: cdp.detail || null,
      };
    }
    if (cdp.profileInUse) {
      // The profile's browser still runs: point at its CDP port, never at a relaunch (#425/#426).
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'profile-in-use',
        run: cdp.run || null,
        ask: cdp.hint || null,
        after: cdp.run ? null : `${prefix} doctor`,
        requiresUserAction: !cdp.run,
        consentRequired: false,
        reason: cdp.detail || null,
      };
    }
    if (cdp.profileDir && cdp.relaunch) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'relaunch-same-profile',
        run: cdp.relaunch,
        ask: ['Relaunch the same debug browser profile. Do not invent DISPLAY, a new user-data-dir, or a second Chrome profile.', formatCdpCandidateList(cdp.candidates)].filter(Boolean).join(' '),
        ...(Array.isArray(cdp.candidates) && cdp.candidates.length > 1 ? { candidates: cdp.candidates } : {}),
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: false,
        reason: cdp.detail || null,
      };
    }
    if (cdp.port) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'enable-existing-debugging',
        run: cdp.relaunch || null,
        ask: `Open chrome://inspect/#remote-debugging or edge://inspect, enable remote debugging, then run: ${prefix} doctor. Do not invent a new --user-data-dir.`,
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: cdp.detail || null,
      };
    }
    if (environment?.recovery?.command) {
      return {
        ...base,
        stage: 'browser-cdp',
        run: environment.recovery.command,
        ask: isolatedSpawnFallbackAsk(environment, prefix),
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: `${cdp.detail || 'Chrome is not reachable.'} Environment looks ${environment.detail || 'headless/remote'}. Isolated spawn is fallback only and is not the daily profile.`,
      };
    }
    return {
      ...base,
      stage: 'browser-cdp',
      run: emptyCdpEnableCommand(environment, prefix),
      ask: emptyCdpEnableAsk(environment, prefix),
      after: `${prefix} list`,
      requiresUserAction: true,
      consentRequired: true,
      reason: cdp.detail || null,
    };
  }
  if (cdp?.status === 'WARN') {
    if (/DevToolsActivePort/i.test(cdp.detail || '')) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'enable-persistent-daily-dir',
        run: emptyCdpEnableCommand(environment, prefix),
        ask: emptyCdpEnableAsk(environment, prefix),
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: cdp.detail || null,
      };
    }
    return {
      ...base,
      stage: 'browser-cdp',
      run: null,
      ask: 'Re-toggle browser remote debugging, or restart the app with CDP_PORT set.',
      after: `${prefix} list`,
      requiresUserAction: true,
      consentRequired: true,
      reason: cdp.detail || null,
    };
  }
  if (noTargets) {
    return {
      ...base,
      stage: 'open-page',
      run: `${prefix} open https://example.com`,
      ask: null,
      after: `${prefix} list`,
      reason: tabs?.detail || null,
    };
  }
  if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      return {
        ...base,
        stage: 'list',
        run: `${prefix} list`,
        ask: null,
        after: null,
        requiresUserAction: false,
        reason: permission.detail || 'CDP is usable; permission approval is advisory until a tab daemon attaches.',
      };
    }
    return {
      ...base,
      stage: 'browser-permission',
      run: `${prefix} list`,
      ask: 'Click Allow if Chrome asks.',
      after: `${prefix} list`,
      requiresUserAction: true,
      reason: permission.detail || null,
    };
  }
  return base;
}
export function doctorNextSteps(checks) {
  checks = normalizeDoctorChecks(checks);
  const recommendation = doctorRecommendationModel(checks);
  const node = checks.find(c => c.label === 'Node');
  const prefix = doctorCliPrefix(node);
  if (node?.status === 'FAIL') return [node.hint || NODE22_MISSING_HINT];
  const lines = [];
  if (recommendation.run) lines.push(recommendation.run);
  else if (recommendation.ask) lines.push(recommendation.ask);
  if (recommendation.after && recommendation.after !== recommendation.run) lines.push(recommendation.after);
  return lines.length ? lines : [`${prefix} list`];
}
export function formatDoctorReport(checks) {
  const model = buildDoctorModel(checks);
  const node = model.checks.find(c => c.label === 'Node');
  const cdp = model.checks.find(c => c.label === 'CDP');
  const recommendation = model.recommendation || {};
  const prefix = doctorCliPrefix(node);
  const command = recommendation.run || recommendation.after || `${prefix} list`;
  // #534: say so when the attached browser runs a daily profile; quiet otherwise.
  const profile = model.checks.find(c => c.label === 'Profile' && c.status === 'WARN');
  // Nothing answered on the probe ports: the logged-in session is the inspect toggle.
  // Next stays one spawn command, and that spawn is a profile without those logins (#635).
  const nothingAnswered = /nothing answered/i.test(cdp?.detail || '')
    && !cdp?.liveTabSession
    && /\bspawn-debug-browser\b/.test(command);
  return [
    `Node: ${node?.detail || 'unknown'}`,
    `CDP: ${cdp?.detail || 'unknown'}`,
    profile ? `Profile: ${profile.detail}` : null,
    nothingAnswered ? 'First: chrome://inspect/#remote-debugging' : null,
    nothingAnswered ? 'Or set CDP_PORT=<port> for Electron or a browser started with its own port.' : null,
    nothingAnswered ? "The spawn suggestion is a profile without the user's logins." : null,
    !recommendation.run && recommendation.ask ? recommendation.ask : null,
    recommendation.consentRequired && recommendation.run ? ASK_HUMAN_FIRST_LINE : null,
    formatNextLine(command),
  ].filter(Boolean).join('\n');
}
export function doctorCheckSeverity(check = {}) {
  if (check.severity) return check.severity;
  if (check.status === 'FAIL') return 'blocking';
  if (check.status === 'WARN') {
    // Direct checkout invocation is operationally valid even when the skill is
    // not copied into the conventional Claude installation directory.
    if (check.label === 'Skill install') return 'advisory';
    // Permission without a live daemon is advisory when CDP/tabs are otherwise usable.
    if (check.label === 'Permission' && !/no target|skipped until/i.test(check.detail || '')) return 'advisory';
    return 'warning';
  }
  return 'ok';
}
export function doctorStatusSummary(checks) {
  const annotated = (checks || []).map(check => ({
    ...check,
    severity: doctorCheckSeverity(check),
  }));
  const failures = annotated.filter(c => c.status === 'FAIL' || c.severity === 'blocking').length;
  const warnings = annotated.filter(c => c.severity === 'warning').length;
  const advisories = annotated.filter(c => c.severity === 'advisory').length;
  let readiness = 'ready';
  if (failures > 0) readiness = 'blocked';
  else if (warnings > 0 || advisories > 0) readiness = 'usable-with-warnings';
  return {
    status: readiness,
    readiness,
    ready: failures === 0 && warnings === 0,
    operationalReady: failures === 0 && warnings === 0,
    failures,
    warnings,
    actionableWarnings: warnings,
    advisories,
  };
}
export function stripDoctorStepPrefix(line) {
  return String(line || '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .replace(/^Then run:\s*/i, '')
    .replace(/^If list is empty:\s*/i, '')
    .replace(/^Use the target id printed by open:\s*/i, '')
    .trim();
}
export function doctorNextStepCommands(checks) {
  return doctorNextSteps(checks)
    .map(stripDoctorStepPrefix)
    .filter(line => line.startsWith('cdp ') || /\bcdp\.mjs\b/.test(line) || /--remote-debugging-port=/.test(line) || /node\b/.test(line));
}
export function buildDoctorModel(checks) {
  checks = normalizeDoctorChecks(checks);
  const summary = doctorStatusSummary(checks);
  const annotatedChecks = checks.map(check => ({ ...check, severity: doctorCheckSeverity(check) }));
  const recommendation = doctorRecommendationModel(checks);
  recommendation.commands = doctorNextStepCommands(checks);
  const node = annotatedChecks.find(c => c.label === 'Node');
  const cdpOk = annotatedChecks.find(c => c.label === 'CDP')?.status === 'OK';
  const tabsOk = annotatedChecks.find(c => c.label === 'Tabs')?.status === 'OK';
  const probe = doctorProbeFromChecks(annotatedChecks);
  const provenCommand = cdpOk && tabsOk
    ? probe.provenCommand
    : (recommendation?.run || node?.rerunCommand || null);
  return {
    schema: 'chrome-cdp-ex.doctor.v1',
    ...summary,
    provenCommand,
    probeNote: cdpOk && tabsOk ? probe.probeNote : null,
    listIsSourceOfTruth: Boolean(cdpOk && tabsOk && probe.listIsSourceOfTruth),
    recommendedTargetPrefix: cdpOk && tabsOk ? probe.targetPrefix : null,
    wizard: doctorWizardModel(checks),
    recommendation,
    routeRecommendation: {
      schema: 'chrome-cdp-ex.route-recommendation.v1',
      claude: 'cli',
      cursor: 'mcp',
      'claude-code-skill': 'cli',
      'claude-desktop-mcp': 'mcp',
      codex: 'cli',
      hermes: 'cli',
      'hermes-shell': 'cli',
      openclaw: 'mcp',
      pi: 'cli',
      notes: 'Matched MCP/CLI campaigns favor CLI for output tokens; MCP is the portable host socket.',
    },
    checks: annotatedChecks,
    nextSteps: doctorNextStepCommands(checks),
  };
}
export function formatDoctorOutput(checks, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(buildDoctorModel(checks));
  return formatDoctorReport(checks);
}
export async function runDoctorChecks(opts = {}) {
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
// #534: an advisory check, never blocking. WARN only when the attached browser runs a daily profile.
export async function checkBrowserProfile({ cdp = null, inspectBrowserArgv, readUserAgent } = {}) {
  if (cdp?.status !== 'OK' || !cdp.port) {
    return { status: 'OK', label: 'Profile', detail: 'skipped until CDP is reachable', profileKind: null };
  }
  const endpoint = { host: cdp.host || DEFAULT_CDP_HOST, port: String(cdp.port) };
  const inspect = inspectBrowserArgv || (target => readBrowserProcessArgv(target));
  let argv = null;
  try { argv = await inspect(endpoint); } catch {}
  let electron = false;
  if (argv) {
    try { electron = isElectronUserAgent(await (readUserAgent || readCdpUserAgent)(endpoint)); } catch {}
  }
  const profile = classifyBrowserProfile(argv, { electron });
  if (profile.kind !== 'daily') {
    return { status: 'OK', label: 'Profile', detail: describeBrowserProfile(profile), profileKind: profile.kind, profileDir: profile.profileDir };
  }
  return {
    status: 'WARN',
    severity: 'advisory',
    label: 'Profile',
    detail: `${describeBrowserProfile(profile)}: automation here acts in the browser you use every day`,
    hint: 'Set CDP_ISOLATED_ONLY=1 to refuse daily profiles, or point CDP_PORT at a browser started with its own --user-data-dir.',
    profileKind: profile.kind,
    profileDir: profile.profileDir,
  };
}
export async function doctorStr(opts = {}) {
  const checks = await runDoctorChecks(opts);
  return formatDoctorOutput(checks, { format: opts.format || 'text' });
}
// ---------------------------------------------------------------------------
// spawn-debug-browser: launch a browser with --remote-debugging-port using the
// persistent chrome-cdp-ex/daily-* user-data-dir (option 2 / #368). Isolated
// /tmp profiles stay available via explicit --user-data-dir. --daily-profile
// still means the browser default dir and cannot enable CDP on Chromium 136+.
// ---------------------------------------------------------------------------

export function defaultBrowserUserDataDir(browser, { platform = process.platform, env = process.env, home } = {}) {
  const p = pathApiForPlatform(platform);
  const resolvedHome = home || env.HOME || env.USERPROFILE || homedir();
  const localAppData = env.LOCALAPPDATA || '';
  const dirs = {
    darwin: {
      chrome: p.resolve(resolvedHome, 'Library', 'Application Support', 'Google', 'Chrome'),
      edge: p.resolve(resolvedHome, 'Library', 'Application Support', 'Microsoft Edge'),
      brave: p.resolve(resolvedHome, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
    },
    linux: {
      chrome: p.resolve(resolvedHome, '.config', 'google-chrome'),
      edge: p.resolve(resolvedHome, '.config', 'microsoft-edge'),
      brave: p.resolve(resolvedHome, '.config', 'BraveSoftware', 'Brave-Browser'),
    },
    win32: {
      chrome: p.resolve(localAppData, 'Google', 'Chrome', 'User Data'),
      edge: p.resolve(localAppData, 'Microsoft', 'Edge', 'User Data'),
      brave: p.resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    },
  };
  const table = dirs[platform] || dirs.linux;
  return table[browser] || table.chrome || null;
}
export function parseChromiumMajor(text) {
  const m = String(text || '').match(/(\d+)\.\d+/);
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  return Number.isFinite(major) ? major : null;
}
// Windows Chromium installs (Chrome, Edge, Brave) keep the version-named
// folder next to the exe: ...\Application\154.0.8037.92\. An update keeps the
// old folder until restart, so the highest one is the installed version.
export function windowsChromiumMajorFromVersionDir(exe, fs) {
  if (typeof fs?.readdirSync !== 'function') return null;
  try {
    const best = fs.readdirSync(win32Path.dirname(String(exe)))
      .map(entry => (typeof entry === 'string' ? entry : entry?.name))
      .filter(name => CHROMIUM_VERSION_DIR_RE.test(String(name || '')))
      .map(name => name.split('.').map(Number))
      .sort((a, b) => {
        for (let i = 0; i < 4; i += 1) if (a[i] !== b[i]) return b[i] - a[i];
        return 0;
      })[0];
    return best ? best[0] : null;
  } catch {
    return null;
  }
}
export function detectChromiumMajorVersion(exe, extras = {}) {
  if (!exe) return null;
  const fs = extras.fs || { existsSync, readFileSync, readdirSync };
  const spawnSyncFn = extras.spawnSyncFn || spawnSync;
  const platform = extras.platform || process.platform;
  // Never execute a Windows browser to learn its version: `chrome.exe --version`
  // is a GUI launch that opens a window (or hands off to the running browser)
  // and blocks until the timeout (#456). That holds for a Windows .exe reached
  // from WSL through interop too.
  if (platform === 'win32' || /\.exe$/i.test(String(exe))) {
    return windowsChromiumMajorFromVersionDir(exe, fs);
  }
  const appMatch = String(exe).match(/^(.*\.app)\/Contents\/MacOS\//);
  if (appMatch) {
    const plist = `${appMatch[1]}/Contents/Info.plist`;
    try {
      if (fs.existsSync?.(plist) && typeof fs.readFileSync === 'function') {
        const text = String(fs.readFileSync(plist, 'utf8'));
        const short = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/i);
        const major = parseChromiumMajor(short?.[1]);
        if (major != null) return major;
      }
    } catch {}
    try {
      const r = spawnSyncFn('defaults', ['read', `${appMatch[1]}/Contents/Info`, 'CFBundleShortVersionString'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const major = parseChromiumMajor(`${r?.stdout || ''}`);
      if (major != null) return major;
    } catch {}
  }
  try {
    const r = spawnSyncFn(exe, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return parseChromiumMajor(`${r?.stdout || ''} ${r?.stderr || ''}`);
  } catch {
    return null;
  }
}
export function defaultProfileIgnoresRemoteDebugging(major) {
  return Number(major) >= DEFAULT_PROFILE_REMOTE_DEBUGGING_BLOCKED_MAJOR;
}
export function defaultIsProfileLocked(profileDir, fs = { existsSync }) {
  if (!profileDir) return false;
  return Boolean(
    fs.existsSync(resolve(profileDir, 'SingletonLock'))
    || fs.existsSync(resolve(profileDir, 'lockfile')),
  );
}
export async function defaultQuitBrowser(plan, { platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  const app = DAILY_BROWSER_APP_NAMES[platform]?.[plan.browser];
  if (platform === 'darwin' && app) {
    spawnSyncFn('osascript', ['-e', `quit app "${app}"`], { timeout: 15000 });
    return;
  }
  throw new Error(`Daily ${plan.browser} is running without debug. Isolated spawn is fallback only and is not the daily profile.`);
}
export function spawnDebugBrowserHelpDetails() {
  const labels = SPAWN_DEBUG_BROWSER_FLAGS.map(({ flags, arg }) => flags.map(flag => (arg ? `${flag} ${arg}` : flag)).join(', '));
  const width = Math.max(...labels.map(label => label.length)) + 2;
  const flagLines = SPAWN_DEBUG_BROWSER_FLAGS.map(({ text }, index) => `  ${labels[index].padEnd(width)}${text}`);
  return ['Flags:', ...flagLines, 'Notes:', ...SPAWN_DEBUG_BROWSER_NOTES.map(note => `  ${note}`)];
}
export function parseSpawnDebugBrowserArgs(args, env = process.env, extras = {}) {
  const fopts = parseFormatArgs(args || [], ['text', 'json']);
  const opts = {
    browser: (env && env.CDP_DEBUG_BROWSER) || 'edge',
    port: 9222,
    host: DEFAULT_CDP_HOST,
    url: null,
    profileDir: null,
    executable: null,
    dailyProfile: false,
    headless: false,
    noSandbox: false,
    disableGpu: false,
    allowOcclusion: false,
    // Only an explicit request (#488): the default background mode must not minimize a window or
    // change how the browser schedules every other tab.
    background: explicitBackgroundChoice(env) === true,
    waitMs: DEFAULT_SPAWN_READY_TIMEOUT_MS,
    format: fopts.format,
  };
  const tokens = (fopts.args || []).filter(a => a !== undefined && a !== null);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--port' || a === '-p') opts.port = parseInt(tokens[++i]) || 9222;
    else if (a === '--host') opts.host = tokens[++i] || opts.host;
    else if (a === '--url' || a === '-u') opts.url = tokens[++i];
    else if (a === '--profile-dir' || a === '--user-data-dir') opts.profileDir = tokens[++i];
    else if (a === '--daily-profile') opts.dailyProfile = true;
    else if (a === '--browser') opts.browser = (tokens[++i] || opts.browser).toLowerCase();
    else if (a === '--exe' || a === '--executable') opts.executable = tokens[++i];
    else if (a === '--headless') opts.headless = 'new';
    else if (String(a).startsWith('--headless=')) opts.headless = String(a).slice('--headless='.length) || 'new';
    else if (a === '--no-sandbox') opts.noSandbox = true;
    else if (a === '--disable-gpu') opts.disableGpu = true;
    else if (a === '--allow-occlusion') opts.allowOcclusion = true;
    else if (a === '--background') opts.background = true;
    else if (a === '--wait-ms') opts.waitMs = parseNonNegativeInteger(tokens[++i], 'spawn-debug-browser: --wait-ms');
    else if (String(a).startsWith('--wait-ms=')) opts.waitMs = parseNonNegativeInteger(String(a).slice('--wait-ms='.length), 'spawn-debug-browser: --wait-ms');
    else if (a === '--help' || a === '-h' || String(a).startsWith('--')) opts.helpRequested = true;
    else if (['edge','chrome','brave','google-chrome','msedge','chromium'].includes(a.toLowerCase())) {
      const norm = a.toLowerCase();
      if (norm === 'msedge') opts.browser = 'edge';
      else if (norm === 'google-chrome' || norm === 'chromium') opts.browser = 'chrome';
      else opts.browser = norm;
    }
  }
  if (opts.dailyProfile && !opts.profileDir) {
    opts.profileDir = defaultBrowserUserDataDir(opts.browser, {
      platform: extras.platform || process.platform,
      env,
    });
  } else if (!opts.profileDir) {
    opts.profileDir = persistentDailyUserDataDir(opts.browser, {
      platform: extras.platform || process.platform,
      env,
    });
  }
  return opts;
}
export async function listSpawnedDebugTargets({ port, host = DEFAULT_CDP_HOST, fetcher = fetch } = {}) {
  try {
    const res = await fetcher(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const raw = await res.json();
      return Array.isArray(raw)
        ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget)
        : [];
    }
  } catch {}
  try {
    const wsUrl = `ws://${host}:${port}/devtools/browser`;
    const ws = new WebSocket(wsUrl);
    const targetsResult = await new Promise((resolveWs, rejectWs) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === 1 && data.result?.targetInfos) {
            resolveWs(data.result.targetInfos);
          }
        } catch {}
      };
      ws.onerror = (err) => rejectWs(err);
      setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 1500);
    });
    ws.close();
    return Array.isArray(targetsResult)
      ? targetsResult.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget)
      : [];
  } catch {
    return [];
  }
}
// Minimize (never focus) each window that holds one of these targets; one call per window.
export async function minimizeWindowsForTargets(cdp, targetIds = []) {
  const windowIds = new Set();
  const errors = [];
  for (const targetId of targetIds) {
    try {
      const { windowId } = await cdpDomains(cdp).Browser.getWindowForTarget( { targetId }, undefined, 2000);
      if (windowId != null) windowIds.add(windowId);
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  let minimized = 0;
  for (const windowId of windowIds) {
    try {
      await cdpDomains(cdp).Browser.setWindowBounds( { windowId, bounds: { windowState: 'minimized' } }, undefined, 2000);
      minimized += 1;
    } catch (e) {
      errors.push(e.message || String(e));
    }
  }
  return { minimized, errors };
}
export async function minimizeBrowserWindows({ host = DEFAULT_CDP_HOST, port, targetIds = [], fetcher = fetch } = {}) {
  const cdp = new CDP();
  try {
    await cdp.connect(await wsUrlFromCdpHttp({ host, port, fetcher, remembered: null, rememberReachable: () => {} }));
    return await minimizeWindowsForTargets(cdp, targetIds);
  } finally {
    try { cdp.close(); } catch {}
  }
}
export function pickSpawnedTarget(pages = [], url = null) {
  if (!pages.length) return null;
  if (url) {
    try {
      return selectPageTarget(pages, { url, exact: false }).page;
    } catch {
      // fall through to ranked pick
    }
  }
  return rankPageTargets(pages)[0] || null;
}
export function buildSpawnDebugBrowserModel(plan, readiness, { child = null, target = null, attached = false } = {}) {
  const targetId = target?.targetId || null;
  const targetPrefix = targetId ? String(targetId).slice(0, getDisplayPrefixLength([targetId])) : null;
  // A background spawn minimizes its first window, whose tabs are hidden: send agents to a fresh `open`
  // tab, which opens in its own unfocused window by default (#488).
  const nextCommand = plan.background && !plan.headless && !attached
    ? `CDP_PORT=${plan.port} cdp open <url>`
    : attached || !targetPrefix
      ? `CDP_PORT=${plan.port} cdp list`
      : `CDP_PORT=${plan.port} cdp perceive ${targetPrefix} -C -d 8`;
  const disposable = isDisposableSpawnProfileDir(plan.profileDir);
  return {
    schema: 'chrome-cdp-ex.spawn-debug-browser.v1',
    ready: readiness?.ok === true,
    attached: Boolean(attached),
    browser: plan.browser,
    pid: child?.pid || null,
    profileDir: plan.profileDir,
    host: plan.host,
    port: plan.port,
    url: plan.url || target?.url || null,
    product: readiness?.product || null,
    targetId,
    targetPrefix,
    title: target?.title || null,
    dailyProfile: Boolean(plan.dailyProfile),
    nextCommand,
    cleanup: {
      stopHint: `CDP_PORT=${plan.port} cdp stop${targetPrefix ? ` ${targetPrefix}` : ''}`,
      deleteProfile: disposable ? `rm -rf ${plan.profileDir}` : null,
    },
  };
}
export function formatSpawnDebugBrowserOutput(model, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(model);
  const heading = model.attached
    ? `Attached to existing ${model.browser} debug session on CDP_PORT=${model.port}`
    : model.dailyProfile
      ? `Enabled daily ${model.browser} debug on CDP_PORT=${model.port} (pid ${model.pid || '?'})`
      : `Spawned ${model.browser} debug profile on CDP_PORT=${model.port} (pid ${model.pid || '?'})`;
  const lines = [
    heading,
    `  CDP ready:  ${model.product || `${model.host}:${model.port}`}`,
    `  Executable: (see profile)`,
    `  Profile:    ${model.profileDir}`,
  ];
  if (model.url) lines.push(`  URL:        ${model.url}`);
  if (model.targetPrefix) {
    lines.push(`  Target:     ${model.targetPrefix}${model.title ? `  ${model.title}` : ''}`);
  }
  lines.push('');
  lines.push(`Next: ${model.nextCommand}`);
  if (model.cleanup?.deleteProfile) {
    lines.push(`Stop/cleanup: ${model.cleanup.stopHint}; then ${model.cleanup.deleteProfile}`);
    lines.push(`(Profile is disposable — delete ${model.profileDir} to reset.)`);
  } else {
    lines.push(`Stop: ${model.cleanup?.stopHint || `CDP_PORT=${model.port} cdp stop`}`);
    lines.push(model.dailyProfile
      ? '(This is the daily profile — logged-in tabs. Isolated spawn is fallback only and is not the daily profile.)'
      : '(Reused existing profile — do not delete this user-data-dir.)');
  }
  return lines.join('\n');
}
export function buildSpawnDebugBrowserPlan(opts, platform = process.platform, fs = { existsSync }, env = process.env) {
  const exe = opts.executable || detectBrowserPath(opts.browser, platform, fs, env);
  if (!exe || !fs.existsSync(exe)) {
    const list = [
      ...defaultBrowserPaths(opts.browser, platform, env),
      ...((BROWSER_COMMANDS[opts.browser] || []).map(c => `$PATH:${c}`)),
    ];
    const tried = list.length ? list.join(', ') : '(no candidates configured for this platform)';
    throw new Error(`spawn-debug-browser: cannot find ${opts.browser} executable. Tried: ${tried}. Use --exe /path/to/browser, set CDP_DEBUG_BROWSER, or install it on PATH.`);
  }
  const args = [
    `--remote-debugging-address=${opts.host || DEFAULT_CDP_HOST}`,
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.headless) args.push(`--headless=${opts.headless === true ? 'new' : opts.headless}`);
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.disableGpu) args.push('--disable-gpu');
  if (!opts.allowOcclusion) args.push('--disable-features=CalculateNativeWinOcclusion');
  // #488: nothing raises the window in background mode, so a covered window keeps rendering (macOS and
  // other occlusion trackers too). Background tabs stay throttled; --background adds the rest.
  if (opts.background) args.push(...BACKGROUND_THROTTLE_FLAGS);
  else if (!opts.allowOcclusion) args.push(OCCLUDED_WINDOWS_FLAG);
  if (opts.url) args.push(opts.url);
  return { exe, args, profileDir: opts.profileDir, port: opts.port, host: opts.host || DEFAULT_CDP_HOST, url: opts.url, browser: opts.browser, waitMs: opts.waitMs, dailyProfile: Boolean(opts.dailyProfile), background: Boolean(opts.background), headless: Boolean(opts.headless) };
}
export function spawnOutputChunk(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
}
export function utf8SequenceLength(buf, index) {
  const lead = buf[index];
  let len = 0;
  if (lead < 0x80) len = 1;
  else if ((lead & 0xe0) === 0xc0 && lead >= 0xc2) len = 2;
  else if ((lead & 0xf0) === 0xe0) len = 3;
  else if ((lead & 0xf8) === 0xf0 && lead <= 0xf4) len = 4;
  if (!len || index + len > buf.length) return 0;
  for (let j = 1; j < len; j++) {
    if ((buf[index + j] & 0xc0) !== 0x80) return 0;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(index, index + len));
    return [...text].length === 1 ? len : 0;
  } catch {
    return 0;
  }
}
// A tail window may start on a continuation byte. Skip that split code point, then keep every
// well-formed sequence. Illegal bytes are dropped and never become U+FFFD. `omitted` is true only
// when an illegal byte was dropped, not when the window merely started mid-character.
export function decodeSpawnBytes(buf) {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  const body = buf.subarray(start);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), omitted: false };
  } catch {
    let text = '';
    let omitted = false;
    for (let i = 0; i < body.length;) {
      const len = utf8SequenceLength(body, i);
      if (!len) {
        omitted = true;
        i += 1;
        continue;
      }
      text += new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(i, i + len));
      i += len;
    }
    return { text, omitted };
  }
}
export function captureSpawnOutput(child, maxBytes = 4096) {
  const output = { stdout: '', stderr: '', stdoutOmitted: false, stderrOmitted: false };
  for (const key of ['stdout', 'stderr']) {
    const stream = child?.[key];
    if (!stream?.on) continue;
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => {
      const buf = spawnOutputChunk(chunk);
      chunks.push(buf);
      size += buf.length;
      while (size > maxBytes && chunks.length) {
        const extra = size - maxBytes;
        if (chunks[0].length <= extra) {
          size -= chunks[0].length;
          chunks.shift();
        } else {
          chunks[0] = chunks[0].subarray(extra);
          size = maxBytes;
          break;
        }
      }
      const joined = Buffer.concat(chunks, size);
      const decoded = decodeSpawnBytes(joined);
      output[key] = decoded.text;
      output[`${key}Omitted`] = decoded.omitted;
    });
  }
  return output;
}
export function isExistingBrowserSessionHandoff(text) {
  const s = String(text || '');
  return /Opening in existing browser session/i.test(s)
    || s.includes('在現有的瀏覽器工作階段中開啟');
}
export function spawnOutputHandoffText(output, readiness) {
  return [output?.stdout, output?.stderr, readiness?.stdout, readiness?.stderr]
    .filter(Boolean)
    .join('\n');
}
export function devToolsActivePortPath(profileDir) {
  return pathApiForRoot(profileDir).resolve(String(profileDir), 'DevToolsActivePort');
}
export function portFromDevToolsActivePortText(text) {
  const line = String(text || '').split(/\r?\n/, 1)[0].trim();
  return /^\d+$/.test(line) ? line : null;
}
export function otherRememberedPorts(record, profileDir, requestedPort) {
  const want = cdpProfileKey(profileDir);
  const requested = String(requestedPort);
  const ports = [];
  const add = (port, dir) => {
    if (!dir || cdpProfileKey(dir) !== want) return;
    const value = port == null || port === '' ? '' : String(port);
    if (!/^\d+$/.test(value) || value === requested || ports.includes(value)) return;
    ports.push(value);
  };
  add(record?.port, record?.profileDir);
  for (const item of record?.history || []) add(item.port, item.profileDir);
  return ports;
}
export async function liveOtherProfilePort(plan, {
  fetcher,
  remembered,
  fs,
  inspectOccupantProfileDir,
  connectWebSocket,
  readProcessArgv = null,
} = {}) {
  const candidates = otherRememberedPorts(remembered, plan.profileDir, plan.port);
  try {
    const read = fs?.readFileSync;
    const text = typeof read === 'function' ? read(devToolsActivePortPath(plan.profileDir), 'utf8') : '';
    const filePort = portFromDevToolsActivePortText(text);
    if (filePort && filePort !== String(plan.port) && !candidates.includes(filePort)) candidates.push(filePort);
  } catch {}
  for (const port of candidates) {
    let answered = false;
    try {
      const res = await fetcher(`http://${plan.host}:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      answered = Boolean(res?.ok);
    } catch {
      answered = false;
    }
    if (!answered) continue;
    // Identify the occupant from the live process only. The remembered record is what is being
    // checked, so it is not evidence of who holds the port now.
    let occupant = null;
    try {
      if (typeof inspectOccupantProfileDir === 'function') {
        occupant = await inspectOccupantProfileDir({ host: plan.host, port, remembered });
      } else if (process.env.NODE_ENV !== 'test' || typeof connectWebSocket === 'function') {
        occupant = await inspectCdpOccupantProfileDirViaCdp({ host: plan.host, port, connectWebSocket });
      }
    } catch {
      occupant = null;
    }
    // Chrome hides its argv from CDP without --enable-automation; the OS command line names the profile.
    if (!occupant && typeof readProcessArgv === 'function') {
      try {
        occupant = profileDirFromCommandLine(await readProcessArgv({ host: plan.host, port }));
      } catch {
        occupant = null;
      }
    }
    // Refuse only an occupant identified as this profile. An unidentified one (a stale port now held
    // by another CDP server) launches; a real duplicate is still caught by the exit-0 hand-off.
    if (!occupant || cdpProfileKey(occupant) !== cdpProfileKey(plan.profileDir)) continue;
    return port;
  }
  return null;
}
export function profileInUseSpawnError(plan, { livePort = null } = {}) {
  const message = livePort
    ? `spawn-debug-browser: profile ${plan.profileDir} is already open on port ${livePort}. Pass --profile-dir <other> for a second browser.`
    : `spawn-debug-browser: profile ${plan.profileDir} was absorbed by an existing browser session. Pass --profile-dir <other> for a second browser.`;
  const err = new Error(message);
  err.code = 'cdp_profile_in_use';
  err.host = plan.host;
  err.port = plan.port;
  err.profileDir = plan.profileDir;
  if (livePort) err.livePort = String(livePort);
  err.cdpRecovery = livePort
    ? {
      kind: 'profile-in-use',
      strategy: 'use-live-port',
      run: `CDP_PORT=${livePort} cdp list`,
      ask: 'Pass --profile-dir <other> for a second browser.',
      reason: `Profile ${plan.profileDir} is already open on port ${livePort}.`,
    }
    : {
      kind: 'profile-in-use',
      strategy: 'use-other-profile',
      run: `cdp spawn-debug-browser ${plan.browser} --port ${plan.port} --profile-dir <other>`,
      reason: 'The browser exited 0 and handed the launch to an existing session. A second browser needs a different profile directory.',
    };
  return err;
}
export function readinessIsProfileHandoff(output, readiness) {
  if (!readiness?.exited || (readiness.exitCode !== 0 && readiness.exitCode !== '0')) return false;
  if (output?.stdoutOmitted) return true;
  return isExistingBrowserSessionHandoff(spawnOutputHandoffText(output, readiness));
}
export function isDefaultBrowserProfileDir(plan, extras = {}) {
  if (!plan?.profileDir || !plan?.browser) return false;
  const expected = defaultBrowserUserDataDir(plan.browser, extras);
  return Boolean(expected && plan.profileDir === expected);
}
export function formatDailyDefaultProfileCdpFailure(plan, text, { refusedMajor = null } = {}) {
  const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const parts = [];
  if (refusedMajor != null) {
    parts.push(`spawn-debug-browser: did not launch daily ${plan.browser} (major ${refusedMajor}) on its default user-data-dir; nothing was quit or started and no CDP connection was attempted.`);
  } else if (isExistingBrowserSessionHandoff(text)) {
    parts.push(`spawn-debug-browser: daily ${plan.browser} was absorbed by an existing session without debug (${snippet || 'Opening in existing browser session'}).`);
  } else {
    parts.push(`spawn-debug-browser: CDP was not reachable on ${plan.host}:${plan.port} for the daily ${plan.browser} default user-data-dir.`);
  }
  parts.push('Chrome 136+ and Microsoft Edge ignore --remote-debugging-port on the default user-data-dir (DevTools remote debugging requires a non-default data directory).');
  parts.push('Quit+relaunch of that same default profile does not enable CDP.');
  parts.push('Isolated spawn is fallback only and is not the daily profile; logged-in cookies will not transfer.');
  return parts.join(' ');
}
export function formatExistingBrowserSessionHandoffError(plan, text) {
  return formatDailyDefaultProfileCdpFailure(plan, text);
}
export async function waitForSpawnedCdp({ port, host = DEFAULT_CDP_HOST, timeoutMs = DEFAULT_SPAWN_READY_TIMEOUT_MS, child = null, fetcher = fetch, output = null } = {}) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_SPAWN_READY_TIMEOUT_MS, 0), 120000);
  const started = Date.now();
  const hardCap = child
    ? Math.min(Math.max(timeout, SPAWN_ALIVE_WAIT_CAP_MS), 120000)
    : timeout;
  const deadline = started + hardCap;
  let exited = false;
  let exitCode = null;
  let signal = null;
  let lastError = null;
  if (child?.once) {
    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig || null;
    });
  }
  while (Date.now() <= deadline) {
    if (exited) {
      return {
        ok: false,
        exited: true,
        exitCode,
        signal,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      };
    }
    try {
      const res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        return {
          ok: true,
          port,
          host,
          product: info.Browser || info.product || null,
          webSocketDebuggerUrl: info.webSocketDebuggerUrl || null,
        };
      }
      lastError = `HTTP ${res.status}`;
      // Fallback check: if HTTP fails, try websocket check
      try {
        const wsUrl = `ws://${host}:${port}/devtools/browser`;
        const ws = new WebSocket(wsUrl);
        const wsOpen = await new Promise((resolveWs, rejectWs) => {
          ws.onopen = () => { resolveWs(true); ws.close(); };
          ws.onerror = (err) => rejectWs(err);
          setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 300);
        });
        if (wsOpen) {
          return {
            ok: true,
            port,
            host,
            product: 'Chrome (WebSocket Fallback)',
            webSocketDebuggerUrl: wsUrl,
          };
        }
      } catch {}
    } catch (e) {
      lastError = e.message || String(e);
      // Fallback check on error
      try {
        const wsUrl = `ws://${host}:${port}/devtools/browser`;
        const ws = new WebSocket(wsUrl);
        const wsOpen = await new Promise((resolveWs, rejectWs) => {
          ws.onopen = () => { resolveWs(true); ws.close(); };
          ws.onerror = (err) => rejectWs(err);
          setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 300);
        });
        if (wsOpen) {
          return {
            ok: true,
            port,
            host,
            product: 'Chrome (WebSocket Fallback)',
            webSocketDebuggerUrl: wsUrl,
          };
        }
      } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return {
    ok: false,
    timeout: true,
    port,
    host,
    timeoutMs: timeout,
    error: lastError,
    stdout: output?.stdout || '',
    stderr: output?.stderr || '',
  };
}
export function formatSpawnDebugBrowserReadinessFailure(plan, readiness) {
  const lines = [];
  if (readiness?.exited) {
    lines.push(`spawn-debug-browser: ${plan.browser} exited early before CDP became reachable (exit ${readiness.exitCode ?? 'unknown'}${readiness.signal ? `, signal ${readiness.signal}` : ''}).`);
  } else {
    lines.push(`spawn-debug-browser: CDP was not reachable on ${plan.host}:${plan.port} within ${formatDuration(readiness?.timeoutMs || plan.waitMs)}.`);
  }
  if (readiness?.stderr) lines.push(`stderr: ${readiness.stderr.trim()}`);
  if (readiness?.stdout) lines.push(`stdout: ${readiness.stdout.trim()}`);
  lines.push(`Try: cdp spawn-debug-browser ${plan.browser} --headless --no-sandbox --port ${plan.port} --exe ${plan.exe}${plan.url ? ` --url ${plan.url}` : ''}`);
  return lines.join('\n');
}
export async function probeTcpPort({ host = DEFAULT_CDP_HOST, port, timeoutMs = 500, connect = options => net.createConnection(options) } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`spawn-debug-browser: invalid port ${port}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port: Number(port) });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners?.();
      socket?.on?.('error', () => {});
      try { socket?.destroy?.(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`spawn-debug-browser: could not determine whether ${host}:${port} is free (probe timed out).`)), timeoutMs);
    socket.once('connect', () => finish(resolve, { occupied: true }));
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED') finish(resolve, { occupied: false });
      else finish(reject, new Error(`spawn-debug-browser: could not probe ${host}:${port} (${error?.message || error}).`));
    });
  });
}
export async function spawnDebugBrowserStr(args, env = process.env, deps = {}) {
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
// #629: an ancestor behind a fixed layer is the layer's own shell only when the layer is the
// sole rendered child on every step from that ancestor down to the layer. Each page script
// inlines this helper (the scripts are strings evaluated in the page). Keep the one copy.
function soleRenderedChainSource() {
  return `function soleRenderedChain(ancestor, el) {
      if (typeof getComputedStyle !== 'function' || !el || !ancestor) return true;
      const skipTag = { script: 1, style: 1, template: 1, head: 1, link: 1, meta: 1, noscript: 1 };
      function renderedSibling(node) {
        if (!node || (node.nodeType && node.nodeType !== 1)) return false;
        const tag = String(node.tagName || '').toLowerCase();
        if (skipTag[tag]) return false;
        let cs = null;
        try { cs = getComputedStyle(node); } catch (err) { return false; }
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (typeof node.getBoundingClientRect !== 'function') return true;
        let box = null;
        try { box = node.getBoundingClientRect(); } catch (err) { return false; }
        if (!box || !(box.width > 0) || !(box.height > 0)) return false;
        return true;
      }
      let node = el;
      for (let guard = 0; node && node !== ancestor && guard < 64; guard++) {
        let parent = null;
        try { parent = node.parentElement; } catch (err) { return true; }
        let next = parent;
        // #709: a shadow child has no parentElement. Siblings live on the shadow root;
        // the walk then continues at the host so a light-DOM sibling of the host still counts.
        if (!parent) {
          let root = null;
          try { root = typeof node.getRootNode === 'function' ? node.getRootNode() : null; } catch (err) { root = null; }
          if (root && root.host && root.host !== node) {
            parent = root;
            next = root.host;
          }
        }
        if (!parent || !next) return true;
        let kids = null;
        try { kids = parent.children; } catch (err) { return true; }
        if (!kids || typeof kids.length !== 'number') return true;
        for (let i = 0; i < kids.length; i++) {
          if (kids[i] !== node && renderedSibling(kids[i])) return false;
        }
        if (next === node) return true;
        node = next;
      }
      return true;
    }`;
}

// #709: querySelectorAll does not enter an open shadow root. The page scripts below inline
// this once. contains() stops at the shadow boundary; document hit-testing retargets to the host.
function shadowTreeSource() {
  return `function querySelectorDeep(selector) {
      const matched = [];
      const seen = new Set();
      function remember(el) {
        if (!el || seen.has(el)) return;
        seen.add(el);
        matched.push(el);
      }
      function matchesSel(el) {
        if (selector === 'body *' || selector === '*') return true;
        try { return typeof el.matches === 'function' && !!el.matches(selector); }
        catch (err) { return false; }
      }
      const walkedRoots = new Set();
      function walkShadow(root) {
        if (!root || walkedRoots.has(root)) return;
        walkedRoots.add(root);
        const listed = [];
        const listedSet = new Set();
        function take(el) {
          if (!el || listedSet.has(el)) return;
          listedSet.add(el);
          listed.push(el);
        }
        if (typeof root.querySelectorAll === 'function') {
          try {
            const list = root.querySelectorAll('*');
            if (list && typeof list.length === 'number') {
              for (let i = 0; i < list.length; i++) take(list[i]);
            }
          } catch (err) {}
        }
        function walkChildren(node) {
          const kids = node && node.children;
          if (!kids || typeof kids.length !== 'number') return;
          for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            const before = listedSet.has(child);
            take(child);
            if (!before) walkChildren(child);
          }
        }
        if (listed.length === 0) walkChildren(root);
        else {
          for (let i = 0; i < listed.length; i++) walkChildren(listed[i]);
        }
        for (let i = 0; i < listed.length; i++) {
          const el = listed[i];
          if (matchesSel(el)) remember(el);
          if (el && el.shadowRoot) walkShadow(el.shadowRoot);
        }
      }
      function fromQuery(sel, trust) {
        let list = null;
        try { list = document.querySelectorAll(sel); } catch (err) { list = null; }
        if (!list || typeof list.length !== 'number') return;
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          if (!el) continue;
          if (trust || matchesSel(el)) remember(el);
          if (el.shadowRoot) walkShadow(el.shadowRoot);
        }
      }
      fromQuery(selector, true);
      if (selector !== 'body *') fromQuery('body *', false);
      return matched;
    }
    function composedContains(ancestor, node) {
      if (!ancestor || !node || ancestor === node) return false;
      try { if (typeof ancestor.contains === 'function' && ancestor.contains(node)) return true; } catch (err) {}
      let current = node;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        let root = null;
        try { root = typeof current.getRootNode === 'function' ? current.getRootNode() : null; } catch (err) { return false; }
        const host = root && root.host;
        if (!host || host === current) return false;
        // contains() is inclusive, so this is also true when the ancestor is the host itself.
        try { if (typeof ancestor.contains === 'function' && ancestor.contains(host)) return true; } catch (err) {}
        current = host;
      }
      return false;
    }
    function sameLayer(el, node) {
      if (!el || !node) return false;
      if (node === el) return true;
      let current = el;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        let root = null;
        try { root = typeof current.getRootNode === 'function' ? current.getRootNode() : null; } catch (err) { return false; }
        const host = root && root.host;
        if (!host || host === current) return false;
        if (host === node) return true;
        current = host;
      }
      return false;
    }
    function pierceStack(stack, x, y) {
      const out = [];
      const seen = new Set();
      function push(node) {
        if (!node || seen.has(node)) return;
        seen.add(node);
        out.push(node);
      }
      for (let i = 0; i < stack.length; i++) {
        const node = stack[i];
        const root = node && node.shadowRoot;
        if (root && typeof root.elementsFromPoint === 'function') {
          let inner = null;
          try { inner = root.elementsFromPoint(x, y); } catch (err) { inner = null; }
          if (inner && typeof inner.length === 'number') {
            for (let j = 0; j < inner.length; j++) push(inner[j]);
          }
        }
        push(node);
      }
      return out;
    }
    function elementFromPointDeep(x, y) {
      if (typeof document.elementFromPoint !== 'function') return null;
      let top = null;
      try { top = document.elementFromPoint(x, y); } catch (err) { return null; }
      let guard = 0;
      while (top && top.shadowRoot && typeof top.shadowRoot.elementFromPoint === 'function' && guard < 8) {
        let inner = null;
        try { inner = top.shadowRoot.elementFromPoint(x, y); } catch (err) { break; }
        if (!inner || inner === top) break;
        top = inner;
        guard += 1;
      }
      return top;
    }`;
}
export function overlayDetectorScript({ targetPoint = null, objectBoundTarget = false } = {}) {
  const targetJson = JSON.stringify(targetPoint && ['input', 'x', 'y', 'descriptor'].reduce((snapshot, key) => { const property = Object.getOwnPropertyDescriptor(targetPoint, key); if (property && Object.hasOwn(property, 'value')) snapshot[key] = property.value; return snapshot; }, Object.create(null))); return `(function() {
    const targetPoint = ${targetJson};
    ${shadowTreeSource()}
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const layoutW = (document.documentElement && document.documentElement.clientWidth) || vw;
    const layoutH = (document.documentElement && document.documentElement.clientHeight) || vh;
    const slackX = Math.max(8, vw - layoutW);
    const slackY = Math.max(8, vh - layoutH);
    function visible(el) {
      if (!el || el.id === '__cdp_annot_overlay__') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }
    function selectorFor(el) {
      if (!el) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).map(CSS.escape).join('.')
        : '';
      return tag + cls;
    }
    function shortText(el) {
      return (el?.getAttribute?.('aria-label') || el?.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
    }
    function pointInRect(point, rect) {
      return !!point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function elementInfo(el, kind, target) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(vw - 1, 0));
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(vh - 1, 0));
      const topAtCenter = elementFromPointDeep(cx, cy);
      const topAtTarget = target ? elementFromPointDeep(target.x, target.y) : null;
      // #629: a fixed shell that contains the target also contains the hit. That is not "on top".
      // #709: composedContains crosses an open shadow root; sameLayer treats the host as the inner element.
      const ancestorOfTarget = !!(targetElement && el !== targetElement && composedContains(el, targetElement));
      const onTarget = !!topAtTarget && !ancestorOfTarget && (sameLayer(el, topAtTarget) || composedContains(el, topAtTarget));
      return {
        kind,
        selector: selectorFor(el),
        role: el.getAttribute('role') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
        text: shortText(el),
        tag: el.tagName,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        coversViewport: (r.left <= slackX && r.top <= slackY && r.right >= vw - slackX && r.bottom >= vh - slackY)
          || (r.left <= 8 && r.top <= 8 && r.right >= layoutW - 8 && r.bottom >= layoutH - 8),
        coversTarget: pointInRect(target, r),
        topAtCenter: sameLayer(el, topAtCenter) || composedContains(el, topAtCenter),
        topAtTarget: onTarget,
      };
    }
    // A viewport-sized fixed element is a cover only when something it does not contain is behind
    // it. An ancestor in that stack (html/body on a short page) is not foreign when el is the
    // sole rendered child from that ancestor down to el; any other rendered sibling makes the
    // ancestor a cover. elementsFromPoint skips pointer-events:none. Without that API, keep the rect check.
    ${soleRenderedChainSource()}
    function coversForeignContent(el) {
      if (typeof document.elementsFromPoint !== 'function') return true;
      const box = el.getBoundingClientRect();
      const fx = Math.min(Math.max(box.left + box.width / 2, 0), Math.max(vw - 1, 0));
      const fy = Math.min(Math.max(box.top + box.height / 2, 0), Math.max(vh - 1, 0));
      let stack = null;
      try { stack = document.elementsFromPoint(fx, fy); } catch (err) { return true; }
      if (!stack || typeof stack.length !== 'number') return true;
      stack = pierceStack(stack, fx, fy);
      let seenEl = false;
      for (let i = 0; i < stack.length; i++) {
        const node = stack[i];
        // A retargeted host stands in for the shadow element that was actually hit.
        if (sameLayer(el, node)) { seenEl = true; continue; }
        if (!seenEl) continue;
        if (composedContains(el, node)) continue;
        if (composedContains(node, el) && soleRenderedChain(node, el)) continue;
        return true;
      }
      return false;
    }
    function isDialog(el) {
      return el.matches('[role="dialog"], dialog, [aria-modal="true"]');
    }
    const targetElement = ${objectBoundTarget ? 'this' : 'null'} || (targetPoint && typeof targetPoint.input === 'string' && !targetPoint.input.startsWith('@') ? document.querySelector(targetPoint.input) : null);
    const seen = new Set(), overlays = [];
    function add(el, kind) {
      const dialog = isDialog(el);
      if (!visible(el) || seen.has(el)) return;
      if (targetElement && !dialog && (el === targetElement || composedContains(targetElement, el))) return;
      const ancestorOfTarget = !!(targetElement && el !== targetElement && composedContains(el, targetElement));
      // #629: the target's own fixed/sticky shell is not a cover.
      if (ancestorOfTarget && !dialog) return;
      seen.add(el);
      const info = elementInfo(el, kind, targetPoint);
      const hasPointer = info.pointerEvents !== 'none';
      const blocksTarget = !!targetPoint && info.coversTarget && hasPointer && !ancestorOfTarget && (info.topAtTarget || dialog);
      const blocksPage = !targetPoint && hasPointer && (dialog || (info.coversViewport && coversForeignContent(el)));
      if (!(dialog || blocksTarget || blocksPage)) return;
      const record = { ...info, blocking: blocksTarget || blocksPage || dialog };
      Object.defineProperty(record, 'targetSelf', { value: !!(dialog && el === targetElement) });
      Object.defineProperty(record, 'ancestorOfTarget', { value: ancestorOfTarget });
      overlays.push(record);
    }
    for (const el of querySelectorDeep('[role="dialog"], dialog, [aria-modal="true"]')) add(el, 'dialog');
    for (const el of querySelectorDeep('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      add(el, el.getAttribute('aria-modal') === 'true' ? 'dialog' : 'overlay');
      if (overlays.length >= 20) break;
    }
    // A layer over the hit point that is not fixed/sticky (an absolute popover) is still the cover
    // when it does not contain the target. Skip it when a real fixed cover is already named.
    if (targetPoint && targetElement && typeof document.elementFromPoint === 'function') {
      const top = elementFromPointDeep(targetPoint.x, targetPoint.y);
      const separate = !!(top && top !== targetElement
        && !composedContains(targetElement, top)
        && !composedContains(top, targetElement));
      if (separate && !overlays.some(entry => entry.topAtTarget && entry.coversTarget && !entry.ancestorOfTarget)) {
        let pointer = 'auto';
        try { pointer = getComputedStyle(top).pointerEvents || 'auto'; } catch (err) { pointer = 'auto'; }
        if (pointer !== 'none') add(top, isDialog(top) ? 'dialog' : 'overlay');
      }
    }
    overlays.sort((a, b) => {
      const za = Number.parseInt(a.zIndex, 10);
      const zb = Number.parseInt(b.zIndex, 10);
      const zcmp = (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
      if (zcmp) return zcmp;
      return (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h);
    });
    const target = targetPoint ? { ...targetPoint, blocked: false, topElement: null } : null;
    if (targetPoint) {
      const top = elementFromPointDeep(targetPoint.x, targetPoint.y);
      if (top) target.topElement = elementInfo(top, isDialog(top) ? 'dialog' : 'top-element', targetPoint);
      const blocker = overlays.find(o => !o.targetSelf && !o.ancestorOfTarget && o.coversTarget && (o.topAtTarget || o.kind === 'dialog' || o.blocking));
      if (blocker) {
        target.blocked = true;
        target.topElement = { kind: blocker.kind, selector: blocker.selector, text: blocker.label || blocker.text || blocker.tag };
      }
    }
    const blocking = overlays.some(o => o.blocking) || !!target?.blocked;
    return JSON.stringify({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: vw, height: vh },
      target,
      overlayCount: overlays.length,
      blocking,
      overlays: overlays.slice(0, 10),
      nextCommand: null,
    });
  }).call(this)`; }
export function formatOverlayRect(rect = {}) {
  return `(${Math.round(rect.x || 0)},${Math.round(rect.y || 0)} ${Math.round(rect.w || 0)}×${Math.round(rect.h || 0)})`;
}
export function overlayElementLabel(element = {}) {
  const selector = element.selector || '<unknown>';
  const label = element.label || element.text || element.tag || '';
  return `[${element.kind || 'overlay'}] ${selector}${label ? ` "${label}"` : ''}`;
}
// #630: nothing to dismiss. Next is still one command: click --js for a named target, perceive otherwise.
function overlayClearNextCommand(model, targetId) {
  const prefix = actionTargetCommandPrefix({ targetId });
  const arg = recoveryCommandArg(model?.target?.input || '');
  return arg ? `cdp click ${prefix} ${arg} --js` : `cdp perceive ${prefix} -C -d 8`;
}
export function formatOverlayReport(model, targetId) {
  const lines = [`Overlay detector: ${model.blocking ? 'blocking' : 'clear'}`];
  if (model.target) {
    const target = model.target;
    const status = target.blocked && target.topElement
      ? `blocked by ${overlayElementLabel(target.topElement)}`
      : 'not blocked';
    lines.push(`Target: ${target.input || '(point)'} at (${Math.round(target.x)},${Math.round(target.y)}) — ${status}`);
  }
  if (!model.overlays || model.overlays.length === 0) {
    lines.push('No visible blocking overlays/dialogs detected.');
  } else {
    lines.push(`Overlays: ${model.overlays.length}`);
    for (const [i, overlay] of model.overlays.entries()) {
      const role = overlay.role ? ` role=${overlay.role}` : '';
      const z = overlay.zIndex != null ? ` z=${overlay.zIndex}` : '';
      const pointer = overlay.pointerEvents ? ` pointer=${overlay.pointerEvents}` : '';
      const target = overlay.coversTarget ? ' covers-target' : '';
      lines.push(`${i + 1}. [${overlay.kind || 'overlay'}] ${overlay.selector || '<unknown>'}${role}${z}${pointer} rect=${formatOverlayRect(overlay.rect)}${target}`);
      const text = overlay.label || overlay.text;
      if (text) lines.push(`   Text: ${text}`);
    }
  }
  const prefix = actionTargetCommandPrefix({ targetId });
  const next = model.blocking
    ? (model.nextCommand || `cdp dismiss-modal ${prefix}`)
    : overlayClearNextCommand(model, targetId);
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}
export async function resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState) {
  if (!targetArg) return { targetPoint: null, objectId: null };
  if (isRef(targetArg)) {
    const { rect, objectId } = await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState);
    return { targetPoint: {
      input: targetArg,
      x: Math.round((Number(rect.x) || 0) + (Number(rect.w) || 0) / 2),
      y: Math.round((Number(rect.y) || 0) + (Number(rect.h) || 0) / 2),
      descriptor: `<${rect.tag || '?'}> "${rect.text || ''}"`,
    }, objectId };
  }
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(targetArg)});
    if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(targetArg)} });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      input: ${JSON.stringify(targetArg)},
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      descriptor: '<' + el.tagName + '> "' + (el.textContent || '').trim().substring(0, 80) + '"'
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  delete parsed.ok;
  return { targetPoint: parsed, objectId: null };
}
export async function overlayStr(cdp, sid, targetId, args = [], refMap = new Map(), refState = null) {
  const fopts = parseFormatArgs(args, ['text', 'json']), targetArg = fopts.args[0] || null;
  const { targetPoint, objectId } = await resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState);
  const raw = objectId && !parseFrameRef(targetArg)
    ? await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState, { objectId, functionDeclaration: `function() { return ${overlayDetectorScript({ targetPoint, objectBoundTarget: true })}; }` })
    : await evalStr(cdp, sid, overlayDetectorScript({ targetPoint }));
  const model = JSON.parse(raw);
  if (model.blocking) {
    if (!model.nextCommand) model.nextCommand = `cdp dismiss-modal ${actionTargetCommandPrefix({ targetId })}`;
  } else {
    model.nextCommand = overlayClearNextCommand(model, targetId);
  }
  if (fopts.format === 'json') return formatJson(model);
  return formatOverlayReport(model, targetId);
}
// ---------------------------------------------------------------------------
// dismiss-modal: close common dialog/modal patterns without firing background
// shortcuts. Reviewer feedback: pressing Space to close a "press any key" MOTD
// also triggered the underlying game's `space` shortcut. dismiss-modal favours
// safer signals (Escape / explicit close button / aria-modal click target)
// over global-key presses.
// ---------------------------------------------------------------------------

// Page-side visibility predicate shared by dismissModalScript and openDialogCountScript.
// Both scripts run in the page, so this returns source text rather than a function the page can call.
export function dialogVisibleFunctionSource() {
  return `function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      return true;
    }`;
}
export function dismissModalScript() {
  return `(function() {
    ${dialogVisibleFunctionSource()}
    ${soleRenderedChainSource()}
    ${shadowTreeSource()}
    // #653: only a control whose job is to close counts. Accept words (OK, 確認, Continue) and labels
    // that merely contain a close word ("Cancel subscription", "Book") are the user's decision.
    // A Chinese close label is the whole string: 關閉 or 取消, optionally followed by 對話框, 視窗,
    // 此視窗 or 彈窗. title "關閉帳號" and aria-label "取消訂閱" are not close controls.
    const CLOSE_TEXT = ['close', 'dismiss', 'cancel', '關閉', '取消', '×', '✕', '✖', 'x'];
    const CLOSE_LABEL_RE = /^(close|dismiss|cancel)(\\s+(this\\s+)?(dialog|modal|popup|window|banner|message|notification|panel))?$|^(關閉|取消)(對話框|視窗|此視窗|彈窗)?$/i;
    function textOf(el) {
      return String(el.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    function labelOf(el) {
      return String(el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    }
    function dismissLabel(el) {
      if (el.hasAttribute && (el.hasAttribute('data-dismiss') || el.hasAttribute('data-bs-dismiss') || el.hasAttribute('data-close'))) return 'data-dismiss';
      if (String(el.getAttribute('value') || '').toLowerCase() === 'cancel' && el.closest && el.closest('form[method="dialog"]')) return 'cancel';
      const text = textOf(el).toLowerCase();
      if (CLOSE_TEXT.includes(text)) return text;
      const label = labelOf(el);
      return label && CLOSE_LABEL_RE.test(label) ? label.toLowerCase() : null;
    }
    function findCloseButton(root) {
      const candidates = root.querySelectorAll('button, [role="button"], a, [aria-label], [data-dismiss], [data-bs-dismiss], [data-close]');
      for (const el of candidates) {
        if (!visible(el)) continue;
        const label = dismissLabel(el);
        if (label) return { el, label };
      }
      return null;
    }
    function dialogName(d) {
      const ids = String(d.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      const labelled = ids.map(id => (document.getElementById ? document.getElementById(id) : null)).filter(Boolean).map(textOf).join(' ');
      const heading = d.querySelector ? d.querySelector('h1, h2, h3, [role="heading"]') : null;
      return String(d.getAttribute('aria-label') || labelled || (heading ? textOf(heading) : '')).slice(0, 80);
    }
    // One Unicode symbol (🗑, with or without a variation selector) is the icon.
    // The button list uses that control's aria-label, such as 取消訂閱, or its title
    // when it has no aria-label (⚙ with title 設定). The title is a list name only:
    // dismissLabel still decides whether the control closes the dialog.
    function singleSymbol(text) {
      if (!text) return false;
      const core = text.replace(/[\\uFE0E\\uFE0F]/g, '');
      const chars = Array.from(core);
      return chars.length === 1 && /^\\p{S}$/u.test(chars[0]);
    }
    function buttonListName(el) {
      const text = textOf(el);
      const named = labelOf(el);
      if (named && singleSymbol(text)) return named;
      return text || named || String(el.value || '');
    }
    function dialogButtons(d) {
      return Array.from(d.querySelectorAll('button, [role="button"], a[href], input[type="button"], input[type="submit"]'))
        .filter(visible)
        .map(buttonListName)
        .filter(Boolean)
        .slice(0, 6)
        .map(name => name.slice(0, 40));
    }
    const dialogs = querySelectorDeep('[role="dialog"], dialog, [aria-modal="true"]').filter(visible);
    if (dialogs.length === 0) {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const layoutW = (document.documentElement && document.documentElement.clientWidth) || vw;
      const layoutH = (document.documentElement && document.documentElement.clientHeight) || vh;
      const slackX = Math.max(8, vw - layoutW);
      const slackY = Math.max(8, vh - layoutH);
      const overlays = [];
      for (const el of querySelectorDeep('body *')) {
        if (!el || el.id === '__cdp_annot_overlay__') continue;
        const cs = getComputedStyle(el);
        if ((cs.position !== 'fixed' && cs.position !== 'sticky') || !visible(el) || cs.pointerEvents === 'none') continue;
        const r = el.getBoundingClientRect();
        const coversViewport = (r.left <= slackX && r.top <= slackY && r.right >= vw - slackX && r.bottom >= vh - slackY)
          || (r.left <= 8 && r.top <= 8 && r.right >= layoutW - 8 && r.bottom >= layoutH - 8);
        if (!coversViewport) continue;
        // #629: a fixed app shell contains the page. It is not a cover unless a non-descendant
        // sits behind it. An ancestor behind the centre counts only when el is not the sole
        // rendered child from that ancestor down to el (a sibling panel is a backdrop).
        // elementFromPoint / elementsFromPoint skip pointer-events:none.
        if (typeof document.elementsFromPoint === 'function') {
          const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(vw - 1, 0));
          const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(vh - 1, 0));
          let stack = null;
          try { stack = document.elementsFromPoint(cx, cy); } catch (err) { stack = null; }
          if (stack && typeof stack.length === 'number') {
            stack = pierceStack(stack, cx, cy);
            let seenEl = false;
            let foreign = false;
            for (let i = 0; i < stack.length; i++) {
              const node = stack[i];
              if (sameLayer(el, node)) { seenEl = true; continue; }
              if (!seenEl) continue;
              if (composedContains(el, node)) continue;
              if (composedContains(node, el) && soleRenderedChain(node, el)) continue;
              foreign = true;
              break;
            }
            if (!foreign) continue;
          }
        }
        overlays.push(el.id ? ('#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id)) : (el.tagName || 'overlay'));
        if (overlays.length >= 5) break;
      }
      if (overlays.length) return JSON.stringify({ ok: false, reason: 'overlay-not-dialog', overlays });
      return JSON.stringify({ ok: false, reason: 'no-dialog' });
    }
    // Prefer an explicit close button inside a visible dialog, topmost (last) dialog first.
    for (const d of [...dialogs].reverse()) {
      const hit = findCloseButton(d);
      if (hit) {
        hit.el.click();
        return JSON.stringify({ ok: true, action: 'click', label: hit.label, sel: d.tagName.toLowerCase() });
      }
    }
    // Fall through: the caller sends Escape next. Name the topmost dialog and its buttons for the case
    // where Escape does not close it either.
    const top = dialogs[dialogs.length - 1];
    return JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: dialogs.length, name: dialogName(top), buttons: dialogButtons(top) });
  })()`;
}
export function openDialogCountScript() {
  return `(function() {
    ${dialogVisibleFunctionSource()}
    ${shadowTreeSource()}
    return querySelectorDeep('[role="dialog"], dialog, [aria-modal="true"]').filter(visible).length;
  })()`;
}
export async function dismissModalStr(cdp, sid, { checkDelayMs = DISMISS_MODAL_ESCAPE_CHECK_MS } = {}) {
  const raw = await evalStr(cdp, sid, dismissModalScript());
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { ok: false, reason: 'parse-error' }; }
  if (parsed.ok) {
    return `Dismissed modal via close button "${parsed.label}" (${parsed.sel})`;
  }
  if (parsed.reason === 'no-dialog') {
    return 'No visible modal/dialog detected.';
  }
  if (parsed.reason === 'overlay-not-dialog') {
    const names = (parsed.overlays || []).filter(Boolean).join(', ') || 'overlay';
    return `dismiss-modal only handles dialog/modal patterns; blocking overlay still visible (${names}).`;
  }
  // Fallback: send Escape (does not fire window-level shortcuts the way Space does).
  await pressStr(cdp, sid, 'escape');
  const before = Number(parsed.dialogs) || 0;
  // #653: Escape closes many dialogs but not all; exit 0 only when one is gone.
  for (let check = 0; check < DISMISS_MODAL_ESCAPE_CHECKS; check++) {
    if (check > 0) await sleep(checkDelayMs);
    const open = Number(await evalStr(cdp, sid, openDialogCountScript()));
    if (!Number.isFinite(open)) return `No close button found in ${before} dialog(s); sent Escape as fallback.`;
    if (open < before) return `No close button found in ${before} dialog(s); sent Escape as fallback, and the dialog closed.`;
  }
  const name = parsed.name ? ` "${parsed.name}"` : '';
  const buttons = Array.isArray(parsed.buttons) && parsed.buttons.length
    ? ` Its buttons: ${parsed.buttons.map(button => `"${button}"`).join(', ')}.`
    : '';
  throw new Error(`dismiss-modal: the dialog${name} has no close or cancel control, and Escape did not close it.${buttons} Choosing one is the user's decision: click the button that matches what they asked for.`);
}
