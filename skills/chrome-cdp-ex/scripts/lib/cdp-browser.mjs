// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { uniqueNextStepCommands } from './action-recovery.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { resolveGitHead } from './git-head.mjs';
import { goldenPathReadPageRecommendation } from './perception-model.mjs';
import { distinctTargets, resolveLiveTargetBinding } from './target-binding.mjs';
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir, hostname as osHostname } from 'os';
import { dirname, resolve } from 'path';
import { ALLOW_IN_CHROME_DAEMON_START, ALLOW_STALE_DAEMON_FLAG, BROWSER_WS_PATH, CDP_NOT_FOUND_HINT, CDP_PROFILE_UNKNOWN_HINT, DAEMON_METADATA_SCHEMA, DEFAULT_CDP_HOST, DEFAULT_CDP_PROBE_PORT, DEFAULT_DEBUG_PORT, FOLLOW_URL_FLAG, IS_WINDOWS, LAST_CDP_ENDPOINT_HISTORY_PER_PORT_MAX, MIN_TARGET_PREFIX_LEN, PAGES_CACHE, RUNTIME_DIR, TAB_GROUPS_CACHE, TIMEOUT, USAGE_LOG_MAX_BYTES, WAIT_DURATION_MAX_MS, argvDebugPort, cdpProfileKey, defaultFindListeningBrowser, findListeningBrowserProcess, profileDirFromCommandLine, readProcessArgv, sleep } from './cdp-base.mjs';
import { parseNonNegativeInteger, targetPrefixForDisplay } from './cdp-cli.mjs';
import { cdpDisplayContext, emptyAliasStore, formatCdpCandidateList, inferBrowserFromExe, isIsolatedChromeCdpExProfileDir, isolatedOccupantAttachError, normalizeAliasName, normalizeAliasStore, rankCdpRelaunchCandidates, readLastCdpEndpoint, readTargetAliases, rememberLastCdpEndpoint, replayableLaunchFlags, resolveOccupantProfileDir, sockPath, writeTargetAliases } from './cdp-core.mjs';
import { cdpEndpointFromWsUrl, discoverLivePagesForTargetResolution, isProcessAlive, readDaemonBinding } from './cdp-daemon.mjs';
import { checkRuntimeEnvironment, defaultSpawnProbePorts, doctorRecommendationModel, reconcileRuntimeEnvironmentCheck } from './cdp-doctor.mjs';
import { cdpDomains, getPages } from './cdp-page.mjs';
import { formatCommandLine } from './cdp-session-report.mjs';

// A browser's own default user-data-dir. Chrome 136+ and Edge ignore --remote-debugging-port there,
// so relaunching it with the flag cannot bring CDP back (5c41ea5).
export function isBrowserDefaultUserDataDir(profileDir) {
  const dir = String(profileDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir) return false;
  return /\/Library\/Application Support\/(?:Google\/Chrome(?: Beta| Canary| Dev)?|Chromium|Microsoft Edge(?: Beta| Dev| Canary)?|BraveSoftware\/Brave-Browser)$/i.test(dir)
    || /\/(?:\.config|config)\/(?:google-chrome(?:-beta|-unstable)?|chromium|microsoft-edge(?:-beta|-dev)?|BraveSoftware\/Brave-Browser|vivaldi)$/.test(dir)
    || /\/AppData\/Local\/(?:Google\/Chrome(?: Beta| SxS| Dev)?|Chromium|Microsoft\/Edge(?: Beta| Dev| SxS)?|BraveSoftware\/Brave-Browser)\/User Data$/i.test(dir);
}
// The persistent chrome-cdp-ex/daily-<browser> dir spawn-debug-browser keeps the user's logins in (#368).
export function isPersistentDailyProfileDir(profileDir) {
  return /(?:^|\/)chrome-cdp-ex\/daily-[a-z0-9_-]+$/i.test(String(profileDir || '').replace(/\\/g, '/').replace(/\/+$/, ''));
}
// The browser an executable path runs, from its file name only: a folder or app named "hedge" or
// "Ledger Live" is not Edge, and an Electron app under a "chrome-tools" folder is not Chrome. Every
// release channel counts (Canary, Beta, Dev, Nightly, SxS, -stable), and so does Vivaldi.
export function browserFromExecutable(exe) {
  const name = String(exe || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  const channel = '(?:[ -](?:stable|beta|dev|canary|nightly|unstable))?';
  if (new RegExp(`^(?:msedge|microsoft edge${channel}|microsoft-edge${channel})$`).test(name)) return 'edge';
  if (new RegExp(`^(?:brave|brave browser${channel}|brave-browser${channel})$`).test(name)) return 'brave';
  if (/^vivaldi(?:-bin|-stable|-snapshot)?$/.test(name)) return 'vivaldi';
  if (new RegExp(`^(?:chrome|google chrome${channel}|google-chrome${channel}|chromium|chromium-browser)$`).test(name)) return 'chrome';
  return null;
}
// #534: what kind of profile the attached endpoint runs, from its command line.
// daily: the browser default (no --user-data-dir, or the platform default dir) or the persistent
// chrome-cdp-ex daily dir. isolated: any other explicit dir. other: an Electron app (its /json/version
// User-Agent says Electron/). unknown: no command line to read. Any other Chromium-family executable
// (Opera, Yandex, Arc, ...) is a browser: an unrecognised name must not let a daily profile through.
export function classifyBrowserProfile(argv, { electron = false } = {}) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  if (!list.length) return { kind: 'unknown', profileDir: null, browser: null };
  // Chromium uses the last --user-data-dir= and reads a bare `--user-data-dir DIR` as an empty
  // switch (default profile) plus a start URL.
  const lastDir = list.filter(arg => arg.startsWith('--user-data-dir=')).at(-1);
  const profileDir = lastDir ? (lastDir.slice('--user-data-dir='.length) || null) : null;
  if (electron && !browserFromExecutable(list[0])) return { kind: 'other', profileDir, browser: null };
  const browser = browserFromExecutable(list[0]);
  const daily = !profileDir || isBrowserDefaultUserDataDir(profileDir) || isPersistentDailyProfileDir(profileDir);
  return { kind: daily ? 'daily' : 'isolated', profileDir, browser };
}
// The /json/version User-Agent of a CDP endpoint ('' when unreadable); Electron apps carry Electron/.
export async function readCdpUserAgent({ host, port, fetcher = fetch } = {}) {
  try {
    const res = await fetcher(`http://${host || DEFAULT_CDP_HOST}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res?.ok) return '';
    const info = await res.json();
    return String(info?.['User-Agent'] || '');
  } catch {
    return '';
  }
}
export function isElectronUserAgent(userAgent) {
  return /\bElectron\//.test(String(userAgent || ''));
}
export function describeBrowserProfile(profile = {}) {
  if (profile.kind === 'daily') {
    return profile.profileDir
      ? `a daily profile (${profile.profileDir})`
      : `a daily profile (the ${profile.browser || 'browser'} default user-data-dir)`;
  }
  if (profile.kind === 'isolated') return `an isolated profile (${profile.profileDir})`;
  if (profile.kind === 'other') return 'an Electron app, not a browser profile';
  return 'an unidentified profile (Browser.getBrowserCommandLine gave no command line)';
}
export function isolatedOnlyEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env?.CDP_ISOLATED_ONLY || '').trim());
}
// Browser.getBrowserCommandLine over the browser endpoint; null when it cannot be read.
// Chrome 136+ rejects the bare /devtools/browser path; pass the GUID wsUrl from /json/version when known.
export async function readBrowserArgvViaCdp({ host, port, wsUrl: knownWsUrl, connectWebSocket } = {}) {
  try {
    const wsUrl = knownWsUrl || `ws://${host || DEFAULT_CDP_HOST}:${port}/devtools/browser`;
    const ws = typeof connectWebSocket === 'function' ? await connectWebSocket(wsUrl) : new WebSocket(wsUrl);
    const argv = await new Promise((resolveWs, rejectWs) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        rejectWs(new Error('timeout'));
      }, 1000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine' }));
      if (ws.readyState === 1) ws.onopen();
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === 1) {
            clearTimeout(timer);
            resolveWs(data.result?.arguments || data.result?.Arguments || null);
          }
        } catch {}
      };
      ws.onerror = (err) => { clearTimeout(timer); rejectWs(err); };
    });
    try { ws.close(); } catch {}
    return argv;
  } catch {
    return null;
  }
}
// Split a process command line into arguments: spaces separate, double quotes group and are dropped.
export function splitCommandLine(text) {
  const args = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of String(text || '')) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}
// #534: the argv of the local process listening on the CDP port, from the OS (Chrome hides its own
// command line from CDP without --enable-automation). null for a remote host or when it cannot be read.
export function readBrowserProcessArgv({
  host,
  port,
  platform = process.platform,
  spawnSyncFn = spawnSync,
  findLinuxProcess = wanted => findListeningBrowserProcess(wanted, { requireProfileDir: false }),
} = {}) {
  const numericPort = Number(port);
  if (!isLocalCdpHost(host) || !Number.isInteger(numericPort) || numericPort <= 0) return null;
  const run = (command, args) => {
    const res = spawnSyncFn(command, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return res?.status === 0 ? String(res.stdout || '').trim() : '';
  };
  try {
    if (platform === 'win32') {
      const line = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$c = Get-NetTCPConnection -LocalPort ${numericPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine }`]);
      return line ? splitCommandLine(line) : null;
    }
    if (platform === 'darwin') {
      const pid = (run('lsof', ['-nP', `-iTCP:${numericPort}`, '-sTCP:LISTEN', '-Fp']).match(/^p(\d+)$/m) || [])[1];
      if (!pid) return null;
      const line = run('ps', ['-ww', '-o', 'command=', '-p', pid]);
      return line ? macCommandLineArgv(line) : null;
    }
    if (platform !== 'linux') return null;
    return findLinuxProcess(numericPort)?.argv || null;
  } catch {
    return null;
  }
}
// ps prints an unquoted command line, so spaces inside paths are lost: the executable
// (/Applications/Google Chrome.app/…) is everything before the first --flag, and a flag value such as
// --user-data-dir=~/Library/Application Support/… runs on to the next --flag. When a value carries
// trailing positional words (a start URL), keep its longest leading part that exists on disk, else drop
// trailing URL-like words.
export function macCommandLineArgv(line, { exists = existsSync } = {}) {
  const words = String(line).split(/\s+/).filter(Boolean);
  const firstFlag = words.findIndex(word => word.startsWith('--'));
  if (firstFlag <= 0) return words.length ? [words.join(' ')] : null;
  const argv = [words.slice(0, firstFlag).join(' ')];
  for (const word of words.slice(firstFlag)) {
    if (word.startsWith('--') || !argv.at(-1).startsWith('--') || !argv.at(-1).includes('=')) argv.push(word);
    else argv[argv.length - 1] += ` ${word}`;
  }
  const trailing = [];
  const fixed = argv.map((arg, index) => {
    if (index === 0 || !arg.startsWith('--') || !arg.includes('=') || !arg.includes(' ')) return arg;
    const [key, ...rest] = arg.split('=');
    const parts = rest.join('=').split(' ');
    for (let n = parts.length; n > 1; n--) {
      if (exists(parts.slice(0, n).join(' '))) {
        trailing.push(...parts.slice(n));
        return `${key}=${parts.slice(0, n).join(' ')}`;
      }
    }
    // Not on disk (or not checkable): a leading part shaped like a daily or default dir still wins, so a
    // stray trailing word (-psn_…) cannot turn a daily profile into an "isolated" one.
    for (let n = parts.length; n >= 1; n--) {
      const candidate = parts.slice(0, n).join(' ');
      if (isBrowserDefaultUserDataDir(candidate) || isPersistentDailyProfileDir(candidate)) {
        trailing.push(...parts.slice(n));
        return `${key}=${candidate}`;
      }
    }
    while (parts.length > 1 && /^[a-z][a-z0-9+.-]*:/i.test(parts.at(-1))) trailing.unshift(parts.pop());
    return `${key}=${parts.join(' ')}`;
  });
  return [...fixed, ...trailing];
}
// #534: broadcast's per-member gate. For each endpoint (the alias's port, else the environment), the
// browser passes getWsUrl's CDP_ISOLATED_ONLY check once; a member must then be one of its tabs, so a
// daemon left attached to another (daily) browser is never reused.
export function createIsolatedMemberGate({
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
export function dailyProfileRefusedError({ host, port, profile }) {
  const endpoint = `${host || DEFAULT_CDP_HOST}:${port}`;
  const err = new Error(
    `CDP_ISOLATED_ONLY=1: refusing to attach to ${endpoint}: it runs ${describeBrowserProfile(profile)}. `
    + 'Point CDP_PORT at a browser started with its own --user-data-dir, or unset CDP_ISOLATED_ONLY.',
  );
  err.code = 'daily_profile_refused';
  err.host = host || DEFAULT_CDP_HOST;
  err.port = String(port);
  err.profile = profile;
  return err;
}
// Whether a command line runs this profile. A word of a title-joined command line can carry a trailing
// positional argument (`--user-data-dir=/p http://x`), so a value followed by a space also matches.
export function commandLineUsesProfile(argv, profileDir) {
  const want = cdpProfileKey(profileDir);
  const list = Array.isArray(argv) ? argv.map(String) : [];
  return list.some((arg, i) => {
    const value = arg.startsWith('--user-data-dir=')
      ? arg.slice('--user-data-dir='.length)
      : (arg === '--user-data-dir' ? String(list[i + 1] || '') : null);
    if (value == null) return false;
    const key = cdpProfileKey(value);
    return key === want || key.startsWith(`${want} `);
  });
}
// Is a browser still running on this profile (#425/#426)? Chromium keeps `SingletonLock` -> "<host>-<pid>"
// in the user-data-dir while it runs (Linux, macOS). alive: true (running), false (not running) or null
// (cannot tell: another host's lock, or Windows). Only `true` may suppress a relaunch.
export function inspectCdpProfileProcess(profileDir, {
  platform = process.platform,
  readLink = readlinkSync,
  exists = existsSync,
  host = osHostname(),
  isAlive = pid => isProcessAlive(pid),
  readArgv = pid => readProcessArgv(pid, { platform }),
} = {}) {
  const none = { alive: false, pid: null, argv: null, port: null };
  if (!profileDir) return none;
  let lock;
  try {
    lock = String(readLink(resolve(String(profileDir), 'SingletonLock')));
  } catch {
    if (platform !== 'win32') return none;
    try {
      return exists(resolve(String(profileDir), 'lockfile')) ? { ...none, alive: null } : none;
    } catch {
      return { ...none, alive: null };
    }
  }
  const m = lock.match(/^(.*)-(\d+)$/);
  if (!m) return { ...none, alive: null };
  const pid = Number(m[2]);
  if (m[1] !== host) return { ...none, alive: null, pid };
  if (!isAlive(pid)) return { ...none, pid };
  const argv = readArgv(pid);
  // The pid now belongs to an unrelated process.
  if (argv && !commandLineUsesProfile(argv, profileDir)) return { ...none, pid };
  return { alive: true, pid, argv: argv || null, port: argvDebugPort(argv) };
}
export function safeInspectCdpProfileProcess(inspect, profileDir) {
  try {
    return (typeof inspect === 'function' ? inspect : inspectCdpProfileProcess)(profileDir) || null;
  } catch {
    return null;
  }
}
export function withLiveLaunchFlags(record, { remembered, inspectProfileProcess, findListeningBrowser = defaultFindListeningBrowser } = {}) {
  try {
    if (!record?.port || record.launchFlags) return record;
    const port = String(record.port);
    const dirs = record.profileDir
      ? [record.profileDir]
      : rankCdpRelaunchCandidates(remembered, port).map(candidate => candidate.profileDir);
    const recorded = (profileDir, argv) => ({
      ...record,
      port,
      profileDir,
      exe: record.exe || String(argv[0] || '') || null,
      ...(record.browser || inferBrowserFromExe(argv[0]) ? { browser: record.browser || inferBrowserFromExe(argv[0]) } : {}),
      launchFlags: replayableLaunchFlags(argv.slice(1)),
    });
    for (const profileDir of dirs.slice(0, LAST_CDP_ENDPOINT_HISTORY_PER_PORT_MAX)) {
      const live = safeInspectCdpProfileProcess(inspectProfileProcess, profileDir);
      if (live?.alive !== true || !live.argv || String(live.port) !== port) continue;
      return recorded(profileDir, live.argv);
    }
    // #478: no remembered profile is behind this port (a browser chrome-cdp-ex did not spawn, or a
    // deleted record). Find the local process that listens on it, so a relaunch can replay it.
    if (!record.profileDir && isLocalCdpHost(record.host)) {
      const found = findListeningBrowser(port);
      if (found?.profileDir && Array.isArray(found.argv)) return recorded(found.profileDir, found.argv);
    }
  } catch {}
  return record;
}
export function isLocalCdpHost(host) {
  const text = String(host || DEFAULT_CDP_HOST).replace(/^\[|\]$/g, '').toLowerCase();
  return text === '127.0.0.1' || text === 'localhost' || text === '::1';
}
export function profileDirFromDevToolsActivePort(portFile) {
  if (!portFile) return null;
  const dir = dirname(String(portFile));
  return /(^|[\\/])Default$/.test(dir) ? dirname(dir) : dir;
}
// One diagnosis of a CDP port that does not answer, with what to do next. `doctor` turns it into its
// CDP check and every attach (`list`, ...) into its error, so both say the same thing (#425).
export function cdpUnreachableDiagnosis({
  host,
  port,
  cause,
  lastEndpoint,
  display = cdpDisplayContext(),
  inspectProfileProcess,
} = {}) {
  const resolvedHost = host || lastEndpoint?.host || DEFAULT_CDP_HOST;
  const resolvedPort = port != null && port !== '' ? String(port) : (lastEndpoint?.port || null);
  const candidates = rankCdpRelaunchCandidates(lastEndpoint, resolvedPort, { display });
  const top = candidates[0] || null;
  const where = resolvedPort ? `${resolvedHost}:${resolvedPort}` : resolvedHost;
  const causeText = String(cause || 'unreachable').replace(/^Error:\s*/i, '');
  const base = {
    host: resolvedHost,
    port: resolvedPort,
    profileDir: top?.profileDir || null,
    candidates,
    exe: top?.exe || null,
    browser: top?.browser || null,
  };
  // Never suggest relaunching a profile whose browser still runs: a second launch only hands the
  // command line to the running browser, and the CDP port does not come back (#425/#426).
  const live = top ? safeInspectCdpProfileProcess(inspectProfileProcess, top.profileDir) : null;
  if (live?.alive === true) {
    const livePort = live.port ? String(live.port) : null;
    const otherPort = livePort && livePort !== resolvedPort ? livePort : null;
    const run = otherPort ? `CDP_PORT=${otherPort} cdp list` : null;
    const state = !live.argv
      ? '(its command line could not be read)'
      : livePort ? `with --remote-debugging-port=${livePort}` : 'without a CDP port';
    const open = `Profile ${top.profileDir} is still open in pid ${live.pid} ${state}`;
    const dont = 'do not relaunch it (a second launch hands off to the running browser)';
    const ask = otherPort
      ? `${open}; do not relaunch it. Use its port: ${run}`
      : livePort
        ? `${open}, but that port does not answer; ${dont}. Wait for it to finish starting, or ask the user to quit it, then rerun: cdp doctor`
        : `${open}; ${dont}. ${live.argv ? '' : 'If it has a debugging port, set CDP_PORT to it. '}Otherwise enable remote debugging in that browser via chrome://inspect/#remote-debugging, or ask the user to quit it, then rerun: cdp doctor`;
    return {
      ...base,
      code: 'cdp_profile_in_use',
      relaunch: null,
      profileInUse: true,
      pid: live.pid,
      livePort,
      run,
      ask,
      detail: `cannot reach ${where} (${causeText}); profile ${top.profileDir} is still open in pid ${live.pid} ${state}`,
      hint: ask,
      message: `Cannot reach CDP on ${where} (${causeText}). ${ask}`,
    };
  }
  const relaunch = top?.relaunch || null;
  const others = formatCdpCandidateList(candidates);
  return {
    ...base,
    code: 'cdp_unreachable',
    relaunch,
    detail: `cannot reach ${where} (${causeText})`,
    hint: relaunch || CDP_PROFILE_UNKNOWN_HINT,
    message: top
      ? `Cannot reach CDP on ${where} (${causeText}). Relaunch the same profile: ${relaunch}${others ? `\n${others}` : ''}`
      : `Cannot reach CDP on ${where} (${causeText}). ${CDP_PROFILE_UNKNOWN_HINT}`,
  };
}
export function cdpCheckFromDiagnosis(diagnosis) {
  const check = { status: 'FAIL', label: 'CDP', detail: diagnosis.detail, hint: diagnosis.hint };
  if (diagnosis.code === 'cdp_not_found') return check;
  Object.assign(check, {
    error: diagnosis.code,
    host: diagnosis.host,
    port: diagnosis.port == null ? null : String(diagnosis.port),
    profileDir: diagnosis.profileDir,
    relaunch: diagnosis.relaunch,
    candidates: diagnosis.candidates,
    exe: diagnosis.exe,
    browser: diagnosis.browser,
  });
  if (diagnosis.profileInUse) {
    Object.assign(check, { profileInUse: true, pid: diagnosis.pid, livePort: diagnosis.livePort, run: diagnosis.run });
  }
  return check;
}
export function cdpErrorFromDiagnosis(diagnosis, { recovery } = {}) {
  const err = new Error(diagnosis.message);
  err.code = diagnosis.code;
  for (const key of ['host', 'port', 'profileDir', 'relaunch', 'candidates', 'pid', 'livePort']) {
    if (diagnosis[key] !== undefined) err[key] = diagnosis[key];
  }
  if (recovery) err.cdpRecovery = recovery;
  return err;
}
// doctor's recommendation for a CDP check, in the CLI error recovery shape: list and doctor share it.
export function cdpRecoveryFromDoctor(checks) {
  const rec = doctorRecommendationModel(checks);
  return {
    kind: 'browser-cdp',
    strategy: rec.strategy || 'enable-persistent-daily-dir',
    run: rec.run || null,
    ask: rec.ask || null,
    // No launch command: Next is the follow-up (`cdp doctor` / `cdp list`), not the ask prose.
    then: rec.run ? null : (rec.after || null),
    consentRequired: Boolean(rec.consentRequired && rec.run),
    reason: rec.reason || null,
  };
}
export function cdpUnreachableError(options = {}) {
  const diagnosis = cdpUnreachableDiagnosis(options);
  const check = cdpCheckFromDiagnosis(diagnosis);
  return cdpErrorFromDiagnosis(diagnosis, {
    recovery: diagnosis.profileInUse ? cdpRecoveryFromDoctor([check]) : null,
  });
}
// The port the remembered endpoint stands for on this host: its port, or the old default 9222 for a
// record that has a profile but no port. null when the record is for another host.
export function rememberedCdpPort(remembered, host) {
  if (!remembered) return null;
  if (remembered.host && host && remembered.host !== host) return null;
  if (remembered.port) return String(remembered.port);
  return remembered.profileDir ? String(DEFAULT_DEBUG_PORT) : null;
}
// What unprefixed discovery reports when nothing answered (no CDP_PORT, no DevToolsActivePort, nothing
// on 9222/9224 or the remembered port). `doctor` returns it as its check and every attach throws it (#425).
// `probed` maps each probed port to why it failed.
export function cdpDiscoveryMiss({ host = DEFAULT_CDP_HOST, remembered, probed = {}, display, inspectProfileProcess, deadFilePort = null } = {}) {
  // A present DevToolsActivePort that did not answer is not "no port file" (#558).
  if (deadFilePort) {
    const ports = Object.keys(probed);
    const listed = ports.length ? ` on ${host}:${ports.join(', ')}` : '';
    const detail = `DevToolsActivePort points to ${deadFilePort} but nothing answered${listed}`;
    return {
      code: 'cdp_not_found',
      host,
      port: null,
      profileDir: null,
      relaunch: null,
      detail,
      hint: CDP_NOT_FOUND_HINT,
      message: `${detail}.\n  Chrome: enable at chrome://inspect/#remote-debugging\n  Electron: set CDP_PORT=<port> (app must use --remote-debugging-port)`,
    };
  }
  const port = rememberedCdpPort(remembered, host);
  const top = port ? rankCdpRelaunchCandidates(remembered, port)[0] : null;
  // A browser's default user-data-dir cannot be relaunched with CDP (Chrome 136+, Edge), so a stale record
  // of it must not beat the daily-dir recommendation (5c41ea5).
  if (top && !isBrowserDefaultUserDataDir(top.profileDir)) {
    const why = probed[port] ? String(probed[port]).replace(/^Error:\s*/i, '') : 'not probed';
    return cdpUnreachableDiagnosis({
      host,
      port,
      cause: `remembered last endpoint: ${why}; no DevToolsActivePort and no CDP_PORT set`,
      lastEndpoint: remembered,
      display,
      inspectProfileProcess,
    });
  }
  const ports = Object.keys(probed);
  const detail = `no DevToolsActivePort and no CDP_PORT set${ports.length ? `; nothing answered on ${host}:${ports.join(', ')}` : ''}`;
  return {
    code: 'cdp_not_found',
    host,
    port: null,
    profileDir: null,
    relaunch: null,
    detail,
    hint: CDP_NOT_FOUND_HINT,
    message: `${detail[0].toUpperCase()}${detail.slice(1)}.\n  Chrome: enable at chrome://inspect/#remote-debugging\n  Electron: set CDP_PORT=<port> (app must use --remote-debugging-port)`,
  };
}
export function isCdpHttp404(error) {
  return Number(error?.status) === 404 || /^HTTP 404\b/i.test(String(error?.message || ''));
}
export async function openCdpWebSocket(url, { timeoutMs = 2000, connectWebSocket } = {}) {
  if (typeof connectWebSocket === 'function') return connectWebSocket(url);
  const ws = new WebSocket(url);
  return new Promise((resolveWs, rejectWs) => {
    ws.onopen = () => { resolveWs(true); ws.close(); };
    ws.onerror = (err) => rejectWs(err);
    setTimeout(() => { ws.close(); rejectWs(new Error('WebSocket timeout')); }, timeoutMs);
  });
}
export async function browserWebSocketOpens(error, { host, port, wsPath, connectWebSocket } = {}) {
  if (!isCdpHttp404(error)) return false;
  const path = BROWSER_WS_PATH.test(wsPath || '') ? wsPath : '/devtools/browser';
  try {
    return Boolean(await openCdpWebSocket(`ws://${host}:${port}${path}`, { connectWebSocket }));
  } catch {
    return false;
  }
}
export async function rememberLiveCdpEndpointFromSession(cdp, { host, port, env = process.env } = {}) {
  const resolvedHost = host || env.CDP_HOST || DEFAULT_CDP_HOST;
  const resolvedPort = port || env.CDP_PORT || null;
  let profileDir = null;
  let exe = null;
  try {
    const result = await cdpDomains(cdp).Browser.getBrowserCommandLine({}, undefined, 1000);
    const argv = result?.arguments || result?.Arguments || [];
    profileDir = profileDirFromCommandLine(argv);
    exe = argv[0] ? String(argv[0]) : null;
  } catch {}
  if (!resolvedPort && !profileDir) return null;
  try {
    return rememberLastCdpEndpoint({
      host: resolvedHost,
      port: resolvedPort,
      profileDir,
      exe,
      browser: inferBrowserFromExe(exe),
    });
  } catch {
    return null;
  }
}
export function upsertTargetAlias(store = emptyAliasStore(), record = {}) {
  const normalized = normalizeAliasStore(store);
  const name = normalizeAliasName(record.name);
  if (!record.targetId) throw new Error('alias targetId is required');
  const now = new Date(record.now || Date.now()).toISOString();
  const previous = normalized.aliases[name] || {};
  normalized.aliases[name] = {
    name,
    targetId: String(record.targetId),
    targetPrefix: String(record.targetId).slice(0, 8),
    port: record.port == null || record.port === '' ? null : Number(record.port),
    host: record.host || null,
    url: record.url || previous.url || '',
    title: record.title || previous.title || '',
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  normalized.current = name;
  return normalized;
}
export function removeTargetAlias(store = emptyAliasStore(), name) {
  const normalized = normalizeAliasStore(store);
  const aliasName = normalizeAliasName(name);
  delete normalized.aliases[aliasName];
  if (normalized.current === aliasName) normalized.current = Object.keys(normalized.aliases)[0] || null;
  return normalized;
}
export function aliasLookupKey(name) {
  return String(name || '').trim().replace(/^@+/, '');
}
export function looksLikeHexTargetPrefix(token) {
  const key = aliasLookupKey(token);
  return key.length > 0 && /^[0-9A-Fa-f]+$/.test(key);
}
export function looksLikeAliasToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  if (raw.startsWith('@')) return true;
  const key = aliasLookupKey(raw);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return false;
  // Unique live target prefixes are hex of any length, including A–F starters
  // (F874, C48C). Named aliases still win when they actually exist.
  if (looksLikeHexTargetPrefix(key)) return false;
  return true;
}
export function resolveTargetAlias(name, store = readTargetAliases()) {
  const key = aliasLookupKey(name);
  if (!key) return null;
  const normalized = normalizeAliasStore(store);
  if (key.toLowerCase() === 'current' && normalized.current) {
    return normalized.aliases[normalized.current] || null;
  }
  if (normalized.aliases[key]) return normalized.aliases[key];
  const found = Object.entries(normalized.aliases).find(([stored]) => stored.toLowerCase() === key.toLowerCase());
  return found ? found[1] : null;
}
export function unknownAliasError(name) {
  const display = aliasLookupKey(name);
  const err = new Error(`unknown alias "@${display}". Run: cdp list / cdp current`);
  err.code = 'unknown_alias';
  err.aliasName = display;
  return err;
}
export function forgetTargetAlias(store = emptyAliasStore(), name) {
  const existing = resolveTargetAlias(name, store);
  if (!existing) throw unknownAliasError(name);
  return {
    next: removeTargetAlias(store, existing.name),
    removed: existing,
  };
}
export function aliasesForTarget(targetId, aliases = {}) {
  const id = String(targetId || '').toUpperCase();
  return Object.values(aliases || {})
    .filter(alias => {
      const aid = String(alias?.targetId || '').toUpperCase();
      return aid && (id === aid || id.startsWith(aid));
    })
    .map(alias => alias.name)
    .sort();
}
export function aliasEnv(alias, baseEnv = process.env) {
  if (!alias?.port) return baseEnv;
  return {
    ...baseEnv,
    CDP_PORT: String(alias.port),
    ...(alias.host ? { CDP_HOST: alias.host } : {}),
  };
}
export function discoverOptionsForTargetAlias(alias, baseEnv = process.env) {
  if (!alias?.port) return { env: baseEnv, pinCdpPort: false };
  return { env: aliasEnv(alias, baseEnv), pinCdpPort: true };
}
export function selectLivePagesForAliasResolution({
  alias = null,
  discoveredPages = null,
} = {}) {
  if (!Array.isArray(discoveredPages)) {
    const hint = alias?.port
      ? ` on CDP port ${alias.port}`
      : '';
    throw new Error(`live target discovery is required before resolving an alias${hint}. Run: cdp list`);
  }
  return discoveredPages;
}
// #540: --follow-url re-binds a vanished prefix only for a catalog read command that takes a target.
export function commandAcceptsFollowUrl(cmd) {
  const command = COMMAND_SURFACE.resolve(cmd);
  return Boolean(command && command.kind === 'read' && command.needsTarget === true);
}
export function takeFollowUrlFlag(cmd, args = []) {
  const rest = [];
  let followUrl = false;
  for (const arg of args) {
    if (arg === FOLLOW_URL_FLAG) followUrl = true;
    else rest.push(arg);
  }
  if (!followUrl) return { followUrl: false, args: rest };
  if (!commandAcceptsFollowUrl(cmd)) {
    const command = COMMAND_SURFACE.resolve(cmd);
    const name = command?.name || cmd;
    const kind = command?.kind || 'unknown';
    const error = new Error(`${name}: --follow-url re-binds only a read command (kind "read" with a target). ${name} is ${kind}.`);
    error.code = 'follow_url_not_read';
    throw error;
  }
  return { followUrl: true, args: rest };
}
// #546: a page list taken right after location.reload() can hold two matches for one tab for a
// moment. Discover again (up to 3 more times, 250 ms apart) before an ambiguous prefix fails.
export async function resolvePageCommandTarget({
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
export async function livePagesForTargetCommand(targetAlias, {
  discoverPages = discoverLivePagesForTargetResolution,
  env = process.env,
} = {}) {
  const discoveredPages = await discoverPages(discoverOptionsForTargetAlias(targetAlias, env));
  return selectLivePagesForAliasResolution({ alias: targetAlias, discoveredPages });
}
export function bindAliasTargetFromPages(parsed = {}, livePages = []) {
  const requested = String(parsed?.targetId || '').trim();
  if (!requested) throw new Error(`${parsed?.mode || 'use'}: --target or target id is required`);
  const upper = requested.toUpperCase();
  const matches = (livePages || []).filter(page => String(page?.targetId || '').toUpperCase().startsWith(upper));
  if (matches.length === 1) {
    return {
      targetId: matches[0].targetId,
      url: matches[0].url || '',
      title: matches[0].title || '',
    };
  }
  if (parsed.port) {
    if (matches.length === 0) {
      throw new Error(`No live target matching prefix "${requested}" on CDP port ${parsed.port}. Run: cdp list`);
    }
    throw new Error(`Live target prefix "${requested}" is ambiguous (${matches.length} matches).`);
  }
  return { targetId: requested, url: '', title: '' };
}
export async function bindAndSaveTargetAlias(parsed, {
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
export function formatDaemonStartFailure({
  lastError = null,
  liveTargetPresent = false,
  targetId = null,
} = {}) {
  if (!liveTargetPresent) return ALLOW_IN_CHROME_DAEMON_START;
  const prefix = targetId ? String(targetId).slice(0, 8) : 'target';
  const cause = String(lastError?.message || lastError || 'socket never became ready').replace(/^Error:\s*/i, '');
  return `Daemon failed to start for ${prefix} (${cause}). The tab is already debuggable — this is not an Allow-in-Chrome prompt. Run: cdp list`;
}
export function parseAliasCommandArgs(args = [], mode = 'use') {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    mode,
    format: fopts.format,
    name: null,
    targetId: null,
    port: null,
    host: null,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--name' || token === '-n') parsed.name = fopts.args[++i] || null;
    else if (token === '--target' || token === '-t') parsed.targetId = fopts.args[++i] || null;
    else if (token === '--port' || token === '-p') parsed.port = Number(fopts.args[++i]);
    else if (token === '--host') parsed.host = fopts.args[++i] || null;
    else if (String(token).startsWith('--')) throw new Error(`${mode}: unknown argument ${token}`);
    else positional.push(token);
  }
  if (!parsed.targetId && positional[0]) {
    const slash = String(positional[0]).match(/^(\d+)\/(.+)$/);
    if (slash) {
      parsed.port = Number(slash[1]);
      parsed.targetId = slash[2];
    } else {
      parsed.targetId = positional[0];
    }
  }
  if (!parsed.name && mode === 'use') parsed.name = positional[1] || 'current';
  if (!parsed.name) throw new Error(`${mode}: --name is required`);
  if (!parsed.targetId) throw new Error(`${mode}: --target or target id is required`);
  if (parsed.port != null && (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535)) {
    throw new Error(`${mode}: --port must be a TCP port`);
  }
  return parsed;
}
export function formatAliasRecord(alias, { format = 'text' } = {}) {
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.alias.v1', alias });
  const parts = [`Alias @${alias.name}: ${alias.targetPrefix}`];
  if (alias.port) parts.push(`CDP_PORT=${alias.port}`);
  if (alias.url) parts.push(alias.url);
  return parts.join('  ');
}
export function formatCurrentAlias(store, { format = 'text' } = {}) {
  const normalized = normalizeAliasStore(store);
  const current = normalized.current ? normalized.aliases[normalized.current] : null;
  const aliases = Object.values(normalized.aliases).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.alias-current.v1',
      current: current || null,
      aliases,
    });
  }
  if (!aliases.length) return 'No current alias. Run: cdp use <target> --name app';
  const lines = [];
  if (current) lines.push(`Current ${formatAliasRecord(current)}`);
  else lines.push('No current alias. Run: cdp use <target> --name app');
  for (const alias of aliases) {
    if (current && alias.name === current.name) continue;
    lines.push(formatAliasRecord(alias));
  }
  return lines.join('\n');
}
export function emptyTabGroupStore() {
  return { schema: 'chrome-cdp-ex.tab-groups.v1', groups: {} };
}
export function normalizeTabGroupName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('tab-group name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}
export function normalizeTabGroupStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const groups = {};
  for (const [name, group] of Object.entries(store.groups || {})) {
    if (!group) continue;
    const members = Array.isArray(group.members)
      ? [...new Set(group.members.map(m => String(m || '').trim()).filter(Boolean))]
      : [];
    groups[name] = {
      name,
      members,
      createdAt: group.createdAt || null,
      updatedAt: group.updatedAt || null,
    };
  }
  return { ...emptyTabGroupStore(), groups };
}
export function readTabGroups({ path = TAB_GROUPS_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeTabGroupStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyTabGroupStore();
  }
}
export function writeTabGroups(store, { path = TAB_GROUPS_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeTabGroupStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}
export function upsertTabGroup(store = emptyTabGroupStore(), { name, members = [], now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const previous = normalized.groups[groupName] || {};
  const ts = new Date(now).toISOString();
  const nextMembers = [...new Set([...(previous.members || []), ...members.map(String)])].filter(Boolean);
  normalized.groups[groupName] = {
    name: groupName,
    members: nextMembers,
    createdAt: previous.createdAt || ts,
    updatedAt: ts,
  };
  return normalized;
}
export function removeTabGroupMember(store = emptyTabGroupStore(), name, member, { now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const group = normalized.groups[groupName];
  if (!group) throw new Error(`tab-group: unknown group "${groupName}"`);
  group.members = group.members.filter(m => m !== String(member));
  group.updatedAt = new Date(now).toISOString();
  return normalized;
}
export function deleteTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  if (!normalized.groups[groupName]) throw new Error(`tab-group: unknown group "${groupName}"`);
  delete normalized.groups[groupName];
  return normalized;
}
export function getTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  return normalized.groups[groupName] || null;
}
export function parseTabGroupArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const [action, ...rest] = fopts.args;
  if (!action) throw new Error('tab-group: action required (list|create|add|remove|delete|show)');
  const actionName = String(action).toLowerCase();
  if (!['list', 'create', 'add', 'remove', 'delete', 'show'].includes(actionName)) {
    throw new Error(`tab-group: unknown action ${action}`);
  }
  return { format: fopts.format, action: actionName, args: rest };
}
export function formatTabGroupStore(store, { format = 'text' } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groups = Object.values(normalized.groups).sort((a, b) => a.name.localeCompare(b.name));
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.tab-groups.v1',
      groupCount: groups.length,
      groups,
    });
  }
  if (!groups.length) return 'No tab groups. Create one: cdp tab-group create app <target> [<target>...]';
  return groups.map(g => `${g.name}  (${g.members.length})  ${g.members.join(', ') || '(empty)'}`).join('\n');
}
export function formatTabGroup(group, { format = 'text' } = {}) {
  if (!group) throw new Error('tab-group: group required');
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.tab-group.v1', group });
  return [
    `Tab group: ${group.name}`,
    `Members (${group.members.length}): ${group.members.join(', ') || '(empty)'}`,
    group.updatedAt ? `Updated: ${group.updatedAt}` : null,
  ].filter(Boolean).join('\n');
}
export function recordCommandUsage(spelling, {
  env = process.env,
  via = 'cli',
  file = resolve(RUNTIME_DIR, 'usage.jsonl'),
  now = Date.now,
} = {}) {
  if (!/^(1|true|yes|on)$/i.test(String(env?.CDP_USAGE_LOG || '').trim())) return;
  const command = COMMAND_SURFACE.resolve(String(spelling || ''));
  if (!command || command.name.startsWith('_')) return;
  try {
    if (existsSync(file) && statSync(file).size > USAGE_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, `${JSON.stringify({ ts: new Date(now()).toISOString(), command: command.name, via: via === 'mcp' ? 'mcp' : 'cli' })}\n`, { mode: 0o600 });
  } catch {}
}
// The page list the last target command or `list` wrote to pages.json; empty when missing or unreadable.
export function readCachedPages() {
  if (!existsSync(PAGES_CACHE)) return [];
  try {
    const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    return Array.isArray(cached) ? cached : cached.pages || [];
  } catch {
    return [];
  }
}
export function listKnownLiveTargetIds({
  listDaemons = listDaemonSockets,
  readPages = readCachedPages,
} = {}) {
  const ids = new Set();
  for (const daemon of listDaemons() || []) {
    if (daemon?.targetId) ids.add(String(daemon.targetId));
  }
  for (const page of readPages() || []) {
    if (page?.targetId) ids.add(String(page.targetId));
  }
  return [...ids];
}
export function resolveTabGroupMember(member, {
  targetIds = [],
  resolveAlias = resolveTargetAlias,
} = {}) {
  const raw = String(member || '').trim();
  if (!raw) throw new Error('tab-group: target required');
  const alias = resolveAlias(raw);
  const wanted = alias?.targetId || raw;
  const candidates = (targetIds || []).map(id => String(id));
  if (!candidates.length) {
    throw new Error(`No live target matching prefix "${raw}".`);
  }
  try {
    resolvePrefix(wanted, candidates, 'live target');
  } catch (error) {
    if (/ambiguous/i.test(error.message || '')) throw error;
    throw new Error(`No live target matching prefix "${raw}".`);
  }
  return raw;
}
export function resolveTabGroupMembers(members = [], options = {}) {
  return members.map(member => resolveTabGroupMember(member, options));
}
export function parseBroadcastArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const fullResults = fopts.args.includes('--full-results');
  const filtered = fopts.args.filter(arg => arg !== '--full-results');
  const [groupName, ...cmdParts] = filtered;
  if (!groupName) throw new Error('broadcast: group name required');
  if (!cmdParts.length) throw new Error('broadcast: command required (e.g. broadcast app perceive -C -d 4)');
  return {
    format: fopts.format,
    groupName: normalizeTabGroupName(groupName),
    command: cmdParts[0],
    commandArgs: cmdParts.slice(1),
    fullResults,
  };
}
export function buildBroadcastModel({ groupName, command, commandArgs = [], results = [], fullResults = false } = {}) {
  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  const boundedResults = results.map((entry) => {
    if (fullResults) return { ...entry };
    const { result, error, ...rest } = entry;
    const bounded = { ...rest };
    if (result != null) {
      const text = String(result);
      bounded.resultPreview = text.slice(0, 240);
      bounded.resultChars = text.length;
      bounded.resultTruncated = text.length > 240;
    }
    if (error != null) {
      const text = String(error);
      bounded.errorPreview = text.slice(0, 240);
      bounded.errorChars = text.length;
      bounded.errorTruncated = text.length > 240;
    }
    if (entry.completion === 'unknown') {
      bounded.completion = 'unknown';
      bounded.sideEffectMayHaveOccurred = entry.sideEffectMayHaveOccurred === true;
      bounded.retrySafe = false;
      if (entry.transportCause) bounded.transportCause = { ...entry.transportCause };
    }
    return bounded;
  });
  const failedResults = results.filter(result => !result.ok);
  return {
    schema: 'chrome-cdp-ex.broadcast.v1',
    group: groupName,
    command,
    commandArgs,
    fullResults,
    count: results.length,
    ok,
    failed,
    results: boundedResults,
    nextSteps: failed
      ? failedResults.slice(0, 3).map(result => result.completion === 'unknown'
          ? `cdp perceive ${result.targetPrefix} -C -d 8`
          : formatCommandLine(['cdp', command, result.targetPrefix, ...commandArgs]))
      : [`cdp tab-group show ${groupName}`],
  };
}
export function formatBroadcastResult(model) {
  const lines = [
    `Broadcast ${model.group}: ${model.command} → ${model.ok}/${model.count} ok` +
      (model.failed ? `, ${model.failed} failed` : ''),
  ];
  for (const entry of model.results || []) {
    const head = entry.ok ? 'OK' : 'ERR';
    const preview = String(entry.result || entry.resultPreview || entry.error || entry.errorPreview || '').split('\n')[0].slice(0, 160);
    lines.push(`  [${head}] ${entry.targetPrefix}: ${preview}`);
  }
  return lines.join('\n');
}
export function isBlankPageUrl(url = '') {
  const value = String(url || '').trim();
  return !value || value === 'about:blank' || value === 'about:srcdoc';
}
export function isLicenseBlobUrl(url = '') {
  const path = String(url || '').split(/[?#]/)[0];
  return /\/blob\/[^/]+\/LICENSE(?:\.[A-Za-z0-9]+)?$/i.test(path)
    || /\/LICENSE(?:\.[A-Za-z0-9]+)?$/i.test(path);
}
export function pageTargetScore(page = {}) {
  let score = 0;
  const url = page.url || '';
  const title = page.title || '';
  if (!isBlankPageUrl(url)) score += 100;
  if (title && title !== '(blank tab)') score += 20;
  if (/^https?:\/\//i.test(url)) score += 10;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)) score += 5;
  if (page.attached === true || page.attached === 1) score += 3;
  if (typeof page.lastAccessTime === 'number') score += Math.min(10, Math.floor(page.lastAccessTime / 1e12));
  if (isLicenseBlobUrl(url)) score -= 80;
  return score;
}
export function rankPageTargets(pages = []) {
  return [...pages].sort((a, b) => {
    const scoreDiff = pageTargetScore(b) - pageTargetScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.targetId || '').localeCompare(String(b.targetId || ''));
  });
}
export function pageMatchesUrl(page = {}, needle = '', { exact = false } = {}) {
  const url = String(page.url || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return url === want || url === want.replace(/\/$/, '') || url.replace(/\/$/, '') === want;
  return url.toLowerCase().includes(want.toLowerCase());
}
export function pageMatchesTitle(page = {}, needle = '', { exact = false } = {}) {
  const title = String(page.title || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return title === want;
  return title.toLowerCase().includes(want.toLowerCase());
}
export function matchPageTargets(pages = [], { url = null, title = null, exact = false } = {}) {
  return (pages || []).filter(page => {
    if (url && !pageMatchesUrl(page, url, { exact })) return false;
    if (title && !pageMatchesTitle(page, title, { exact })) return false;
    return true;
  });
}
export function formatTargetCandidateLine(page, prefixLength = 8) {
  const prefix = String(page.targetId || '').slice(0, prefixLength);
  const title = isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || '(untitled)');
  return `${prefix}  ${title}  ${page.url || ''}`;
}
export function selectPageTarget(pages = [], opts = {}) {
  const { url = null, title = null, exact = false } = opts;
  if (!url && !title) {
    throw new Error('target: provide --url and/or --title to select a page');
  }
  const matches = matchPageTargets(pages, { url, title, exact });
  const ranked = rankPageTargets(matches);
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  if (ranked.length === 0) {
    const filters = [
      url ? `--url ${url}` : null,
      title ? `--title ${JSON.stringify(title)}` : null,
      exact ? '--exact' : null,
    ].filter(Boolean).join(' ');
    throw new Error(`target: no page matched ${filters}. Run: cdp list`);
  }
  if (ranked.length > 1) {
    const lines = ranked.slice(0, 8).map(page => `  ${formatTargetCandidateLine(page, prefixLength)}`);
    const more = ranked.length > lines.length ? `\n  … +${ranked.length - lines.length} more` : '';
    throw new Error([
      `target: ${ranked.length} pages matched; narrow with a more specific --url/--title or --exact`,
      'Candidates:',
      ...lines,
      more,
      `Follow-up: cdp list --format json`,
      `Or: cdp target --url <more-specific-url> --format json`,
    ].filter(Boolean).join('\n'));
  }
  const chosen = ranked[0];
  return {
    page: chosen,
    targetId: chosen.targetId,
    targetPrefix: String(chosen.targetId || '').slice(0, prefixLength),
    matchCount: 1,
    filters: { url, title, exact },
  };
}
export function parseTargetSelectArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    format: fopts.format,
    url: null,
    title: null,
    exact: false,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--url' || token === '-u') parsed.url = fopts.args[++i] || null;
    else if (token === '--title' || token === '-t') parsed.title = fopts.args[++i] || null;
    else if (token === '--exact') parsed.exact = true;
    else throw new Error(`target: unknown argument ${token}`);
  }
  if (!parsed.url && !parsed.title) throw new Error('target: provide --url and/or --title');
  return parsed;
}
export function buildTargetSelectModel(selection, pages = []) {
  const page = selection.page || {};
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  const targetPrefix = selection.targetPrefix || String(selection.targetId || '').slice(0, prefixLength);
  const recommendation = goldenPathReadPageRecommendation(targetPrefix);
  return {
    schema: 'chrome-cdp-ex.target-select.v1',
    targetId: selection.targetId,
    targetPrefix,
    title: isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || ''),
    url: page.url || '',
    isBlank: isBlankPageUrl(page.url),
    matchCount: selection.matchCount || 1,
    filters: selection.filters || {},
    recommendation,
    nextSteps: uniqueNextStepCommands([
      ...(recommendation.commands || []),
      `cdp use ${targetPrefix} --name app`,
    ]),
  };
}
export function formatTargetSelect(selection, pages = [], { format = 'text' } = {}) {
  const model = buildTargetSelectModel(selection, pages);
  if (format === 'json') return formatJson(model);
  return [
    `Selected target: ${model.targetPrefix}`,
    `URL: ${model.url || '(unknown)'}`,
    `Title: ${model.title || '(untitled)'}`,
    `Next: ${model.nextSteps[0]}`,
  ].join('\n');
}
export function parseQaModeArgs(args = [], allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let qa = false;
  let summary = false;
  let compact = false;
  let maxDiffLines = null;
  let maxControls = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--qa') qa = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--compact') compact = true;
    else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else if (arg === '--max-controls') {
      maxControls = parseNonNegativeInteger(fopts.args[++i], '--max-controls');
    } else if (String(arg).startsWith('--max-controls=')) {
      maxControls = parseNonNegativeInteger(String(arg).slice('--max-controls='.length), '--max-controls');
    } else next.push(arg);
  }
  return {
    format: fopts.format,
    qa: qa || summary,
    summary: summary || qa,
    compact: compact || qa || summary,
    maxDiffLines,
    maxControls,
    args: next,
  };
}
export function livePageIdentity({ page = {}, pageHealth = null, navigation = null } = {}) {
  const health = pageHealth?.evidence || {};
  let navTo = '';
  if (navigation && typeof navigation === 'object') {
    navTo = navigation.to || navigation.url || navigation.href || '';
  } else if (typeof navigation === 'string') {
    navTo = navigation;
  }
  return {
    url: String(health.url || navTo || page.url || ''),
    title: String(health.title || page.title || ''),
  };
}
export function buildQaSummaryModel({
  page = {},
  console: consoleHealth = {},
  network = {},
  action = null,
  blank = null,
  pageHealth = null,
  navigation = null,
  nextCommand = null,
  targetPrefix = null,
  source = 'qa-summary',
} = {}) {
  const { url, title } = livePageIdentity({ page, pageHealth, navigation });
  const isBlank = pageHealth?.isBlank ?? (blank == null ? isBlankPageUrl(url) : Boolean(blank));
  const healthStatus = pageHealth?.status || (isBlank ? 'blank' : 'populated');
  const consoleErrors = Number(consoleHealth.errors || 0) + Number(consoleHealth.exceptions || 0);
  const networkFailures = Number(network.failures || 0);
  const changed = action?.outcome
    ? !['no-change', 'failed', 'timeout'].includes(action.outcome)
    : action?.changed;
  const changedStatus = changed == null ? 'unknown' : (changed ? 'changed' : 'no-change');
  const ok = healthStatus === 'populated' && consoleErrors === 0 && networkFailures === 0 && action?.dispatch?.ok !== false;
  return {
    schema: 'chrome-cdp-ex.qa-summary.v1',
    source,
    targetPrefix: targetPrefix || null,
    page: { url, title, isBlank, healthStatus },
    pageHealth: pageHealth || {
      status: healthStatus,
      isBlank,
      confidence: blank == null ? 'low' : 'medium',
      evidence: { url, title },
    },
    consoleErrors,
    networkFailures,
    changed: changedStatus,
    ok,
    nextCommand: nextCommand || (targetPrefix ? `cdp report ${targetPrefix}` : null),
  };
}
export function formatQaSummaryText(model) {
  return [
    `QA summary: ${model.ok ? 'pass' : 'review'}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}${model.page?.isBlank ? ' (blank)' : ''}`,
    `Page health: ${model.page?.healthStatus || model.pageHealth?.status || 'indeterminate'}`,
    `Console errors: ${model.consoleErrors}`,
    `Network failures: ${model.networkFailures}`,
    `Changed: ${model.changed}`,
    model.nextCommand ? `Next: ${model.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}
export function truncateTextLines(text = '', maxLines = null) {
  if (maxLines == null || maxLines < 0) return String(text || '');
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), `… truncated ${lines.length - maxLines} lines`].join('\n');
}
// Browser metadata from /json/version — set when connecting via CDP_PORT
export let _browserInfo = null;
// Node's fetch says only "fetch failed"; the reason (ECONNREFUSED, ...) is on `cause`.
export function fetchFailureText(error) {
  const message = String(error?.message || error || 'unreachable');
  const code = error?.cause?.code;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}
export async function wsUrlFromCdpHttp({
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
// Where Chromium-family browsers write DevToolsActivePort. `doctor` and every attach search the same
// list, so they cannot disagree about whether the file exists (#425).
export function devToolsActivePortCandidates({ home = homedir(), localAppData = '', portFile } = {}) {
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Windows: %LOCALAPPDATA%\<name>\User Data\DevToolsActivePort
  const winBrowsers = [
    'Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome for Testing',
    'Chromium', 'BraveSoftware\\Brave-Browser', 'Microsoft\\Edge',
  ];
  return [
    portFile,
    ...winBrowsers.flatMap(b => [
      resolve(localAppData, b, 'User Data', 'DevToolsActivePort'),
      resolve(localAppData, b, 'User Data', 'Default', 'DevToolsActivePort'),
    ]),
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
    ...([
      ['org.chromium.Chromium', 'chromium'],
      ['com.google.Chrome', 'google-chrome'],
      ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
      ['com.microsoft.Edge', 'microsoft-edge'],
      ['com.vivaldi.Vivaldi', 'vivaldi'],
    ]).flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
  ].filter(Boolean);
}
// Live when /json/version answers, or when HTTP 404 still opens the file's browser
// websocket (#395). Any other result is a miss and must not be remembered (#558).
export async function answeredDevToolsActivePort({
  host, port, wsPath, profileDir, fetcher, rememberReachable, connectWebSocket,
}) {
  const openedFileSocket = async (error) => {
    if (!await browserWebSocketOpens(error, { host, port, wsPath, connectWebSocket })) return null;
    rememberReachable({ host, port, profileDir });
    const path = BROWSER_WS_PATH.test(wsPath || '') ? wsPath : '/devtools/browser';
    return `ws://${host}:${port}${path}`;
  };
  try {
    const res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const info = await res.json();
      if (!info.webSocketDebuggerUrl) return { url: null, miss: 'no webSocketDebuggerUrl' };
      rememberReachable({ host, port, profileDir });
      return { url: `ws://${host}:${port}${new URL(info.webSocketDebuggerUrl).pathname}`, miss: null };
    }
    const httpError = new Error(`HTTP ${res.status}`);
    httpError.status = res.status;
    const opened = await openedFileSocket(httpError);
    if (opened) return { url: opened, miss: null };
    return { url: null, miss: `HTTP ${res.status}` };
  } catch (error) {
    const opened = await openedFileSocket(error);
    if (opened) return { url: opened, miss: null };
    return { url: null, miss: error?.probeCause || fetchFailureText(error) };
  }
}
// The remembered endpoint's port, when unprefixed discovery has not probed it yet.
export function rememberedCdpProbePort(remembered, host, probed = {}) {
  const port = remembered?.port ? rememberedCdpPort(remembered, host) : null;
  return port && !Object.hasOwn(probed, port) ? port : null;
}
export function defaultCdpEnvironmentCheck(env, cdpCheck) {
  try {
    return reconcileRuntimeEnvironmentCheck(checkRuntimeEnvironment({ env }), cdpCheck);
  } catch {
    return null;
  }
}
// #534: with CDP_ISOLATED_ONLY=1, read the attached browser's command line and refuse a daily or
// unidentified profile. Every fresh attach (daemon start, list, open, target discovery) comes here.
export async function getWsUrl(options = {}) {
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
export async function discoverWsUrl({
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
export function parseDelayMs(value, { name = 'ms', min = 1, max = 24 * 60 * 60 * 1000 } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer in milliseconds`);
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < min) throw new Error(`${name} must be at least ${min}ms`);
  if (ms > max) throw new Error(`${name} exceeds max ${max}ms`);
  return ms;
}
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}
export function parseFormatArgs(args, allowed = ['text', 'json']) {
  const next = [];
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      const value = args[++i];
      if (!allowed.includes(value)) {
        throw new Error(`format must be ${allowed.join(' or ')}`);
      }
      format = value;
    } else {
      next.push(args[i]);
    }
  }
  return { format, args: next };
}
export function takeUnsafeFullArg(args = []) {
  let unsafeFull = false;
  const rest = [];
  for (const arg of args) {
    if (arg === '--unsafe-full') unsafeFull = true;
    else rest.push(arg);
  }
  return { unsafeFull, args: rest };
}
export function parseListArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const lifted = takeUnsafeFullArg(fopts.args);
  return { format: fopts.format, unsafeFull: lifted.unsafeFull, unknown: lifted.args[0] || null };
}
export function parseCompactFormatArgs(args, allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let compact = false;
  let qa = false;
  let full = false;
  let maxDiffLines = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--compact') compact = true;
    else if (arg === '--full' || arg === '--unsafe-full') full = true;
    else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else next.push(arg);
  }
  return { format: fopts.format, compact, qa, full, maxDiffLines, args: next };
}
export function formatJson(model) {
  return JSON.stringify(model, null, 2);
}
export function safeLstat(path) {
  try { return lstatSync(path); } catch { return null; }
}
export function findNearestPackageJson(startDir = process.cwd()) {
  let dir = resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}
export function readPackageVersion(packageJsonPath) {
  if (!packageJsonPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}
// Read from .git directly: a `git` spawn cost ~25 ms on every target command (#461). Not memoised:
// the in-process MCP server outlives a checkout, and a frozen commit would mismatch every new daemon.
// Keeps the 12-char shape `git rev-parse --short=12 HEAD` produced, so freshness compares like with like.
export function currentGitCommit(cwd) {
  const head = resolveGitHead(cwd || process.cwd());
  return head ? head.slice(0, 12) : null;
}
export function resolveScriptIdentityPath(scriptPath) {
  if (!scriptPath) return null;
  try {
    return realpathSync(scriptPath);
  } catch {
    return resolve(scriptPath);
  }
}
export function collectDaemonMetadata({ scriptPath = process.argv[1], now = Date.now(), pid = process.pid } = {}) {
  // Identity must follow the installed/invoked script, never the agent's cwd checkout.
  const resolvedScriptPath = resolveScriptIdentityPath(scriptPath);
  const scriptStats = resolvedScriptPath ? safeLstat(resolvedScriptPath) : null;
  const packageJsonPath = resolvedScriptPath
    ? findNearestPackageJson(dirname(resolvedScriptPath))
    : null;
  const gitCwd = packageJsonPath ? dirname(packageJsonPath) : null;
  return {
    schema: DAEMON_METADATA_SCHEMA,
    scriptPath: resolvedScriptPath,
    scriptMtimeMs: scriptStats ? scriptStats.mtimeMs : null,
    packageVersion: readPackageVersion(packageJsonPath),
    gitCommit: gitCwd ? currentGitCommit(gitCwd) : null,
    pid,
    startedAt: new Date(now).toISOString(),
  };
}
export function comparableMetadataValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'unknown';
}
export function assessDaemonFreshness({ targetPrefix = '', expectedTargetId = null, current = null, daemon = null } = {}) {
  const displayTarget = targetPrefixForDisplay(targetPrefix);
  if (!daemon || daemon.schema !== DAEMON_METADATA_SCHEMA) {
    return {
      stale: true,
      status: 'missing-metadata',
      targetPrefix: displayTarget,
      current,
      daemon,
      mismatches: [{ field: 'metadata', daemon: null, current: 'available' }],
    };
  }

  const fields = ['gitCommit', 'packageVersion', 'scriptPath', 'scriptMtimeMs'];
  const mismatches = [];
  for (const field of fields) {
    const daemonValue = daemon[field];
    const currentValue = current?.[field];
    if (!comparableMetadataValue(daemonValue) || !comparableMetadataValue(currentValue)) continue;
    if (daemonValue !== currentValue) {
      mismatches.push({ field, daemon: daemonValue, current: currentValue });
    }
  }
  const versionSame = comparableMetadataValue(daemon.packageVersion)
    && comparableMetadataValue(current?.packageVersion)
    && daemon.packageVersion === current.packageVersion;
  if (versionSame) {
    const remaining = mismatches.filter(mismatch => mismatch.field !== 'scriptPath');
    if (remaining.length !== mismatches.length) mismatches.splice(0, mismatches.length, ...remaining);
  }

  if (expectedTargetId && daemon.boundTargetId && daemon.boundTargetId !== expectedTargetId) {
    mismatches.push({ field: 'boundTargetId', daemon: daemon.boundTargetId, current: expectedTargetId });
  }

  const targetMismatch = mismatches.some(mismatch => mismatch.field === 'boundTargetId');

  return {
    stale: mismatches.length > 0,
    status: targetMismatch ? 'target-mismatch' : mismatches.length > 0 ? 'stale' : 'current',
    targetPrefix: displayTarget,
    current,
    daemon,
    mismatches,
  };
}
export function metadataCommit(metadata) {
  return metadata?.gitCommit || 'unknown';
}
export function formatStaleDaemonMessage(assessment = {}) {
  const target = assessment.targetPrefix || '<target>';
  const currentCommit = metadataCommit(assessment.current);
  const stopCommand = `cdp stop ${target}`;
  if (assessment.status === 'target-mismatch') {
    const bound = assessment.daemon?.boundTargetId || 'unknown';
    const expected = assessment.mismatches?.find(mismatch => mismatch.field === 'boundTargetId')?.current || target;
    return `Target binding mismatch for ${target}: daemon is bound to ${bound}, resolved live target is ${expected}. Run "${stopCommand}" then retry so the daemon can rebind.`;
  }
  if (assessment.status === 'missing-metadata') {
    return `Stale daemon for ${target}: daemon metadata missing, current commit ${currentCommit}. Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
  }

  const daemonCommit = metadataCommit(assessment.daemon);
  const pid = assessment.daemon?.pid ? `, pid ${assessment.daemon.pid}` : '';
  const mismatchText = Array.isArray(assessment.mismatches) && assessment.mismatches.length
    ? ` Mismatched metadata: ${assessment.mismatches.map(m => `${m.field} daemon=${m.daemon} current=${m.current}`).join(', ')}.`
    : '';
  return `Stale daemon for ${target}: daemon commit ${daemonCommit}, current commit ${currentCommit}${pid}.${mismatchText} Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
}
export function parseDaemonMetadataResult(result) {
  if (!result) return null;
  if (typeof result === 'object') return result;
  try {
    return JSON.parse(String(result));
  } catch {
    return null;
  }
}
export async function waitStr(msArg) {
  const ms = parseDelayMs(msArg, { name: 'wait duration', max: WAIT_DURATION_MAX_MS });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return `Waited ${formatDuration(ms)}`;
}
export function listDaemonSockets() {
  if (IS_WINDOWS) {
    // Named pipes aren't in filesystem; probe pipes for known targets from pages cache
    try {
      const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      return (Array.isArray(cached) ? cached : cached.pages || []).map(p => ({
        targetId: p.targetId,
        socketPath: sockPath(p.targetId),
      }));
    } catch { return []; }
  }
  try {
    return readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith('cdp-') && f.endsWith('.sock'))
      .map(f => ({
        targetId: f.slice(4, -5),
        socketPath: resolve(RUNTIME_DIR, f),
      }));
  } catch { return []; }
}
export function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}
export function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}
// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

export class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = []; #opened = false; #endpoint = '';

  // #533: name the browser endpoint that went away, so a lost connection is not a bare "error".
  #endpointSuffix() {
    return this.#endpoint ? ` [endpoint ${this.#endpoint}]` : '';
  }

  #failPending(select, createError) {
    for (const [id, entry] of [...this.#pending]) {
      if (select && !select(entry)) continue;
      this.#pending.delete(id);
      entry.reject(createError(entry));
    }
  }

  #failPendingOnClose(event) {
    const code = event?.code;
    const reason = event?.reason;
    const detail = [
      code != null && code !== '' ? `code=${code}` : null,
      reason ? `reason=${reason}` : null,
    ].filter(Boolean).join(', ');
    const suffix = detail ? ` (${detail})` : '';
    this.#failPending(null, entry =>
      new Error(`CDP websocket closed while waiting for ${entry.method}${suffix}${this.#endpointSuffix()}`)
    );
    for (const handler of this.#closeHandlers) handler();
  }

  #failPendingOnDetach(msg) {
    const reason = msg?.params?.reason || 'unknown';
    const sessionId = msg?.sessionId;
    this.#failPending(
      sessionId ? entry => entry.sessionId === sessionId : null,
      entry => new Error(`CDP Inspector.detached while waiting for ${entry.method} (reason=${reason})`)
    );
  }

  async connect(wsUrl) {
    this.#endpoint = cdpEndpointFromWsUrl(wsUrl) || '';
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => {
        this.#opened = true;
        res();
      };
      this.#ws.onerror = (e) => {
        if (!this.#opened) {
          // Node's error Event has no message (only type 'error'); the cause, when present, is on e.error.
          const cause = e?.message || e?.error?.cause?.code || e?.error?.message || '';
          rej(new Error(
            `WebSocket error: CDP connection to ${this.#endpoint || wsUrl} was refused or closed`
            + `${cause && cause !== 'error' ? ` (${cause})` : ''}; the browser may have exited or stopped remote debugging.`,
          ));
          return;
        }
        this.#failPending(null, entry =>
          new Error(`CDP websocket closed while waiting for ${entry.method}${this.#endpointSuffix()}`)
        );
      };
      this.#ws.onclose = (event) => this.#failPendingOnClose(event);
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Inspector.detached') this.#failPendingOnDetach(msg);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      let timer;
      this.#pending.set(id, {
        method,
        sessionId,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      // #533: Node's WebSocket drops a send on a closed socket without throwing, so the command would
      // wait out its timeout and report `Timeout:`. Say the connection closed, and where, at once.
      if (this.#opened && this.#ws?.readyState !== 1) {
        this.#pending.delete(id);
        reject(new Error(`CDP websocket closed while waiting for ${method}${this.#endpointSuffix()}`));
        return;
      }
      try {
        this.#ws.send(JSON.stringify(msg));
      } catch {
        this.#pending.delete(id);
        reject(new Error(`CDP websocket closed while waiting for ${method}${this.#endpointSuffix()}`));
        return;
      }
      timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let offClose;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        offClose?.();
        resolve(params);
      });
      offClose = this.onClose(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        reject(new Error(`CDP websocket closed while waiting for event: ${method}`));
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        offClose?.();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
        offClose?.();
      },
    };
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
    return () => {
      const index = this.#closeHandlers.indexOf(handler);
      if (index >= 0) this.#closeHandlers.splice(index, 1);
    };
  }
  close() { this.#ws.close(); }
}
