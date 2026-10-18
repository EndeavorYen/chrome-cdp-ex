// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { COMMAND_SURFACE, SURVIVOR_COMMANDS, isCommandSurface, projectCliCommands } from './command-surface.mjs';
import { DAEMON_ENDPOINT_ABSENT_CODES } from './daemon-transport.mjs';
import { resolveRuntimeDir } from './runtime-dir.mjs';
import { MIN_SCRUB_SECRET_CHARS } from './secrets.mjs';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'os';
import { posix as posixPath, resolve, win32 as win32Path } from 'path';
import { fileURLToPath } from 'url';

// The CLI entry point (scripts/cdp.mjs). This line lives in lib/cdp-base.mjs, one level down.
export const CDP_SCRIPT_PATH = fileURLToPath(new URL('../cdp.mjs', import.meta.url));
export const TIMEOUT = 15000;
export const SCREENSHOT_TIMEOUT = 30000;
export const QA_SCREENSHOT_TIMEOUT_MS = 2000;
export const FULLSHOT_TIMEOUT_MS = 3000;
// Shared height ceiling for a document fullshot and an inner-container fullshot.
// The receipt names the original content height when this applies.
export const FULLSHOT_MAX_CAPTURE_HEIGHT = 16384;
export const VERIFY_CLICK_SETTLE_MS = 800;
export const VERIFY_CLICK_REQUEST_WAIT_MS = 1000;
export const NAVIGATION_TIMEOUT = 30000;
export const RELOAD_EVENT_TIMEOUT = 1000;
export const RELOAD_DISPATCH_TIMEOUT = 1000;
export const RELOAD_READY_TIMEOUT = 1000;
export const RELOAD_READY_PROBE_TIMEOUT = 500;
export const RELOAD_OBSERVE_TIMEOUT = 2000;
export const STATUS_PAGE_INFO_TIMEOUT = 500;
// status --vitals waits ~120 ms in the page; a hidden tab can clamp that timer to 1 s.
export const STATUS_VITALS_TIMEOUT = 3000;
export const REF_RESOLVE_TIMEOUT = 2000;
// Page-side scroll settle budget inside REF_RESOLVE_TIMEOUT, leaving room for the round trip.
export const REF_SETTLE_BUDGET_MS = 1400;
export const HOVER_MOUSE_ACK_TIMEOUT_MS = 250;
// Background-tab mouseMoved is applied with Chrome's ~5s compositor ack.
// Poll page evidence after the short ack swallow; do not lengthen that swallow.
export const HOVER_DELIVERY_WAIT_MS = 6500;
export const HOVER_DELIVERY_POLL_MS = 100;
// A visible tab applies mouseMoved quickly. When the point is on the target and
// :hover still does not match, stop after about 1s. A point another element
// covers fails after a few polls (#621). A hidden tab keeps HOVER_DELIVERY_WAIT_MS.
export const HOVER_VISIBLE_DELIVERY_WAIT_MS = 1000;
export const HOVER_VISIBLE_COVER_POLLS = 3;
export const HOVER_MUTATION_TIMEOUT_MS = 3000;
export const HOVER_MUTATION_MARKER = 'chrome-cdp-ex.hover-mutation.v1';
export const HOVER_REVEAL_MARKER = 'chrome-cdp-ex.hover-reveal.v1';
export const CLICK_MOUSE_ACK_TIMEOUT_MS = 6000;
export const CLICK_EVENT_PROBE_KEY = '__chromeCdpExClickProbe';
export const DRAG_EVENT_PROBE_KEY = '__chromeCdpExDragProbe';
export const DRAG_DEFAULT_STEPS = 10;
export const DRAG_MAX_STEPS = 100;
export const DRAG_PRESS_HOLD_MS = 50;
export const DRAG_STEP_DELAY_MS = 16;
export const DRAG_INTERCEPT_WAIT_MS = 250;
// After the release: how long to wait for a page whose dragstart handler is still running.
export const DRAG_LATE_START_SYNC_MS = 3000;
export const DRAG_LATE_START_GRACE_MS = 100;
export const LOADALL_DEFAULT_INTERVAL_MS = 1500;
export const LOADALL_DEFAULT_TIMEOUT_MS = 30_000;
export const LOADALL_MAX_TIMEOUT_MS = 5 * 60 * 1000;
export const CLICK_NAVIGATION_WAIT_MS = 500;
export const SEARCH_SUBMIT_PROBE_WAIT_MS = 1500;
export const CLICK_HREF_PROBE_TIMEOUT_MS = 120;
// A popup that keeps the opener's main thread busy never lets the click probe
// return. Wait this long after the new target appears before treating the
// opener as blocked, so a healthy click that acks in well under this does not
// skip the probe.
export const CLICK_OPENER_BLOCK_GRACE_MS = 400;
export const CLICK_OPENER_RESPOND_TIMEOUT_MS = 400;
// window.open(url) publishes the new target before its first commit, with an
// empty URL. That is not about:blank. Wait for a real URL before calling the
// open a success. A committed about:blank (window.open('about:blank')) is not
// this wait.
export const CLICK_POPUP_COMMIT_WAIT_MS = 3000;
// Page.frameStartedNavigating names the destination while TargetInfo.url is
// still empty. A slow document is still in flight. Keep waiting for that
// commit when the opener still answers.
export const CLICK_POPUP_NAVIGATION_CAP_MS = 12000;
export const CLICK_OPENER_TERMINATE_TIMEOUT_MS = 1000;
// A mouse ack that already timed out means the renderer may be stuck. The probe
// read must not then spend the default 15s CDP timeout.
export const CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS = 1500;
// Worst case when the opener stays stuck, including terminate and the recheck.
// The mouse-ack wait overlaps the empty-popup commit wait. One bounded probe
// read applies only when the popup was not observed before that ack gave up:
// max(CLICK_MOUSE_ACK_TIMEOUT_MS, CLICK_POPUP_COMMIT_WAIT_MS)
//   + CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS
//   + CLICK_OPENER_RESPOND_TIMEOUT_MS
//   + CLICK_OPENER_TERMINATE_TIMEOUT_MS
//   + CLICK_OPENER_RESPOND_TIMEOUT_MS
// = max(6000, 3000) + 1500 + 400 + 1000 + 400
// = 9300
// The live opener test allows 20000 for the whole click process.
export const CLICK_STUCK_OPENER_BUDGET_MS =
  Math.max(CLICK_MOUSE_ACK_TIMEOUT_MS, CLICK_POPUP_COMMIT_WAIT_MS)
  + CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS
  + CLICK_OPENER_RESPOND_TIMEOUT_MS
  + CLICK_OPENER_TERMINATE_TIMEOUT_MS
  + CLICK_OPENER_RESPOND_TIMEOUT_MS;
export const IDLE_TIMEOUT = 20 * 60 * 1000;
// `wait <ms>` is the longest single command a daemon serves.
export const WAIT_DURATION_MAX_MS = 60 * 60 * 1000;
// A request pauses the idle countdown for at most this, so a handler that never settles
// cannot keep its daemon alive forever (#462).
export const DAEMON_REQUEST_IDLE_PAUSE_MAX_MS = WAIT_DURATION_MAX_MS + 5 * 60 * 1000;
export const daemonRequestStorage = new AsyncLocalStorage();
// #466: the session policy of the daemon request being served (null without one), shared by its
// batch/flow/repeat/replay steps.
export const daemonPolicyStorage = new AsyncLocalStorage();
// The --secret values a daemon request carries (#469), visible to that request's nested steps.
export const daemonSecretStorage = new AsyncLocalStorage();
export const FIRE_AND_FORGET_KEEPALIVE = 60 * 60 * 1000;
export const DAEMON_CONNECT_RETRIES = 20;
export const DAEMON_CONNECT_DELAY = 300;
export const DAEMON_ALLOW_DELAY = 300;
export const DEFAULT_OPEN_ATTACH_TIMEOUT_MS = 5000;
export const DEFAULT_OPEN_READY_TIMEOUT_MS = 5000;
export const MIN_TARGET_PREFIX_LEN = 8;
export const MAX_ACTION_LOG_ENTRIES = 100;
export const MAX_ENVIRONMENT_LOG_ENTRIES = 100;
export const MAX_SCREENSHOT_ENTRIES = 100;
export const MAX_NETWORK_MOCK_HITS = 50;
export const IS_WINDOWS = process.platform === 'win32';
// #587: file: stays refused. Serve the file's folder, then open the page over http.
export const FILE_URL_HTTP_SERVER = 'python -m http.server --protocol HTTP/1.1 --bind 127.0.0.1 8000';

function fileUrlServedHttpUrl(url) {
  const fallback = 'http://127.0.0.1:8000/<filename>';
  let parsed;
  try { parsed = new URL(String(url)); } catch { return fallback; }
  if (parsed.protocol !== 'file:') return fallback;
  let pathname = parsed.pathname || '';
  try { pathname = decodeURIComponent(pathname); } catch { /* keep the raw path */ }
  // A trailing slash names a directory, so the file name is not known.
  if (pathname.endsWith('/')) return fallback;
  const base = pathname.split('/').pop() || '';
  if (!base || base === '.' || base === '..' || /^[A-Za-z]:$/.test(base)) return fallback;
  return `http://127.0.0.1:8000/${encodeURIComponent(base)}`;
}

export function fileUrlRefusedMessage(url) {
  return `file: URLs are refused on purpose. Only http/https URLs allowed, got: file:. Run \`${FILE_URL_HTTP_SERVER}\` in the file's folder, then open ${fileUrlServedHttpUrl(url)}`;
}

export function isFileUrlRefusalMessage(message) {
  const text = String(message || '');
  return /file: URLs are refused on purpose/i.test(text)
    || /only http\/https urls allowed, got: file:/i.test(text);
}
export function pathApiForPlatform(platform = process.platform) {
  return platform === 'win32' ? win32Path : posixPath;
}
export function pathApiForRoot(root, platform = process.platform) {
  const text = String(root ?? '');
  if (text.startsWith('/')) return posixPath;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')) return win32Path;
  return pathApiForPlatform(platform);
}
export const RUNTIME_DIR = resolveRuntimeDir();
export const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
export const ALIASES_CACHE = resolve(RUNTIME_DIR, 'aliases.json');
export const LAST_CDP_ENDPOINT_FILE = 'cdp-last-endpoint.json';
export const LAST_CDP_ENDPOINT_SCHEMA = 'chrome-cdp-ex.cdp-last-endpoint.v1';
export const DAEMON_METADATA_SCHEMA = 'chrome-cdp-ex.daemon-metadata.v1';
export const ALLOW_STALE_DAEMON_FLAG = '--allow-stale-daemon';
export const FOLLOW_URL_FLAG = '--follow-url';
export const DEFAULT_CDP_HOST = '127.0.0.1';
export const DEFAULT_CDP_PROBE_PORT = '9224';
export const DEFAULT_DEBUG_PORT = 9222;
export const DEFAULT_SPAWN_READY_TIMEOUT_MS = 20000;
// #415 background mode, the default since #488: no command sends Target.activateTarget or
// Page.bringToFront, and new tabs open in their own unfocused window. CDP_BACKGROUND=0 (also false/no/off),
// CDP_FOREGROUND=1 or `open --foreground` restore the old focusing behaviour.
export const BACKGROUND_THROTTLE_FLAGS = Object.freeze([
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
]);
// Keeps a window that other windows cover rendering. spawn-debug-browser passes it by default (#488).
export const OCCLUDED_WINDOWS_FLAG = BACKGROUND_THROTTLE_FLAGS[0];
export const TRUTHY_ENV_WORD = /^(1|true|yes|on)$/i;
export const FALSY_ENV_WORD = /^(0|false|no|off)$/i;
export const SPAWN_ALIVE_WAIT_CAP_MS = 60000;
export const TABLE_COLLECTION_DEADLINES = Object.freeze({
  pageMs: 295000,
  serverMs: 300000,
  maxCdpOperationMs: 5000,
});
export const TRUSTED_DAEMON_REQUEST_CONTEXTS = new WeakSet();
export const TABLE_COLLECTION_RUNTIME_STATES = new WeakMap();
export function abortReason(signal, fallback = 'table: collection request aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(signal?.reason == null ? fallback : String(signal.reason));
}
export function daemonRequestAbortSignal() {
  return daemonRequestStorage.getStore()?.signal || null;
}
// One NDJSON request line may hold at most this many bytes (newline excluded).
// CLI argv limits keep real requests far below it; the cap only stops a runaway
// or foreign client from growing the daemon's buffer without bound. An over-cap
// line gets `{ ok: false, error, id: null }` and the connection is closed.
export const MAX_DAEMON_REQUEST_LINE_BYTES = 16 * 1024 * 1024;
export const DAEMON_REQUEST_DECODER = new TextDecoder('utf-8', { fatal: true });
// Network.responseReceivedExtraInfo can arrive before Network.requestWillBeSent for the same
// request; its status is held here until the request is announced. Only those early statuses
// are held: the ExtraInfo of a request already announced (an untracked image, script or font,
// or a tracked request that already settled) is dropped. The announced ids and the early
// statuses are each capped, and an early status older than the age limit is dropped (#462).
export const EARLY_RESPONSE_STATUS_MAX = 500;
export const EARLY_RESPONSE_STATUS_MAX_AGE_MS = 30_000;
// Console and exception text is capped when it is captured (#459): a page that
// logs a canvas toDataURL() would otherwise keep megabytes per entry in the
// ring buffers. A cut entry carries `truncated: true` and `originalLength`.
export const MAX_CAPTURED_CONSOLE_CHARS = 8192;
// A console location is `file:line`, `file:line:col`, or
// `source:line:col (generated:line:col)`. Those coordinates are not part of a
// URL token. Split them off before redaction so `?token=…:7:9` stays `:7:9`
// and `secrets.html:15:24` is not read as a secret assignment (#634).
export const LOCATION_COORD_SOURCE = String.raw`(:\d+){1,2}(?=\s+\(|\)|$)`;
// Per-daemon registry record. `stop` needs the daemon pid even when the pipe or
// socket is unreachable, and the pid otherwise only exists behind the `meta` IPC.
export const DAEMON_RECORD_SCHEMA = 'chrome-cdp-ex.daemon-record.v1';
export const DAEMON_RECORD_SUFFIX = '.daemon.json';
// A tab daemon that dies on an uncaught error leaves one bounded record behind, so the
// client's "Connection closed before response" can say why (#464). The session log keeps a
// session-end line for that exit too; the next daemon appends session-start instead of
// truncating the file (#549).
export const DAEMON_CRASH_SCHEMA = 'chrome-cdp-ex.daemon-crash.v1';
// Per-tab mode record (#441). An explicit choice on `open` (--background / --foreground, or the
// environment) is kept for the tab it creates. The daemon record goes away when its daemon exits, so the
// mode lives in its own small file: a daemon restarted later for that tab (idle exit, crash) reads it and
// keeps that tab's mode when the restarting call does not choose one (#488). `closetab` removes it; only
// the newest TAB_MODE_RECORDS_MAX are kept, so records of tabs closed another way do not pile up.
export const TAB_MODE_SCHEMA = 'chrome-cdp-ex.tab-mode.v1';
export const TAB_MODE_SUFFIX = '.mode.json';
export const TAB_MODE_RECORDS_MAX = 64;
// Dialog mode, throttle, and mock rules (#575). They used to live only in the daemon process, so a
// crash, idle exit, or kill -9 brought the next daemon back to auto-accept. The file is written when
// the setting changes, not at exit, because kill -9 never runs the exit hook. The netlog buffer and
// the action log are stored the same way, in cdp-<targetId>.observe.json (#606, #618).
export const TAB_ENV_SCHEMA = 'chrome-cdp-ex.tab-env.v1';
export const TAB_ENV_SUFFIX = '.env.json';
// Only files that match the defaults (dismiss, throttle off, no mocks) are removed past this.
// An accept record must not be deleted to make room: the next daemon would drop an explicit
// accept, and a missing file is dismiss (#658). A dismiss record matches that default.
export const TAB_ENV_RECORDS_MAX = 64;
export const TAB_ENV_THROTTLE_PROFILES = new Set(['offline', 'slow-3g', 'fast-3g', 'lte', 'custom']);
export const RESTART_NOTICE_PROBE_COMMANDS = new Set(['meta', 'list_raw', '_activate']);
export const LAST_CDP_ENDPOINT_HISTORY_MAX = 24;
export const LAST_CDP_ENDPOINT_HISTORY_PER_PORT_MAX = 4;
export const SPAWN_DEBUG_BROWSER_VIA = 'spawn-debug-browser';
// One key per profile folder (#438): the resolved path (`.`, `..`, doubled and trailing separators
// folded), one slash style, and lower case for Windows paths (drive letter or UNC, or any path on
// win32), which are case-insensitive. `C:\x\y`, `c:/x/./y/` and `C:/x/y` are one profile.
export function cdpProfileKey(profileDir, platform = process.platform) {
  const text = String(profileDir || '');
  if (!text) return '';
  const api = pathApiForRoot(text, platform);
  let resolved = text;
  try { resolved = api.resolve(text); } catch {}
  const key = resolved.replace(/\\/g, '/');
  return api === win32Path || platform === 'win32' ? key.toLowerCase() : key;
}
// The system temp folder as a lower-case profile key, read once per process (#438): ranking calls the
// temp check inside sort comparators.
export function createSystemTempRootReader(read = tmpdir) {
  let key;
  return () => {
    if (key === undefined) {
      try { key = cdpProfileKey(read() || '').toLowerCase(); } catch { key = ''; }
    }
    return key;
  };
}
export const systemTempRootKey = createSystemTempRootReader();
// Browser flags worth replaying when a profile is relaunched (#426): the ones a launch can depend on
// (headless, sandbox, GPU, shared memory), the bind address, and the background-mode anti-throttling
// flags (#438). The URL, port, profile and the flags Chromium adds on its own in headless mode
// (--ozone-*, --use-angle, ...) are left out.
export const CDP_REPLAY_FLAG = /^--(?:headless(?:=[a-z]+)?|no-sandbox|disable-gpu|disable-dev-shm-usage|remote-debugging-address=[\w.:[\]-]+|disable-backgrounding-occluded-windows|disable-renderer-backgrounding|disable-background-timer-throttling)$/i;
export const CDP_REPLAY_FLAGS_MAX = 10;
// Chromium rewrites its process title, so /proc/<pid>/cmdline of a running browser is usually one
// space-joined string, not NUL-separated words. Split that string before each `--flag`.
export function readProcessArgv(pid, { platform = process.platform, readFile = readFileSync } = {}) {
  if (platform !== 'linux') return null;
  try {
    let argv = String(readFile(`/proc/${Number(pid)}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    if (argv.length === 1 && /\s--/.test(argv[0])) argv = argv[0].split(/\s+(?=--)/);
    return argv.length ? argv : null;
  } catch {
    return null;
  }
}
export function argvDebugPort(argv) {
  for (const arg of Array.isArray(argv) ? argv : []) {
    const m = String(arg).match(/^--remote-debugging-port=(\d+)(?:\s|$)/);
    if (m) return m[1];
  }
  return null;
}
// #426: when the browser answering on `record.port` runs a profile remembered for that port, add the
// flags from its live command line, so a later relaunch replays them. Never throws.
// Unit tests must not read the host's real /proc (a developer's own browser on a test port would leak
// into their records), so the default scan is off under NODE_ENV=test; #478 tests inject a fake one.
export const defaultFindListeningBrowser = port => (process.env.NODE_ENV === 'test' ? null : findListeningBrowserProcess(port));
// Inodes of LISTEN sockets on `port` from /proc/net/tcp and tcp6 (columns: local_address
// "HEXADDR:HEXPORT", st "0A" = LISTEN, inode at index 9). null when neither table can be read.
export function listeningSocketInodes(port, readFile = readFileSync) {
  const hexPort = Number(port).toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  let readAny = false;
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = String(readFile(table, 'utf8')); } catch { continue; }
    if (!text.trim()) continue;
    readAny = true;
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== '0A') continue;
      if (String(cols[1]).split(':').pop().toUpperCase() !== hexPort) continue;
      if (cols[9] && cols[9] !== '0') inodes.add(cols[9]);
    }
  }
  return readAny ? inodes : null;
}
export function listProcPids() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name));
}
export function listProcFdTargets(pid) {
  const dir = `/proc/${Number(pid)}/fd`;
  return readdirSync(dir).map(fd => {
    try { return readlinkSync(`${dir}/${fd}`); } catch { return ''; }
  });
}
// A title-joined command line can leave the start URL on the --user-data-dir word
// (`--user-data-dir=/p http://x`); keep the full value when it is a folder, else its first word.
export function profileDirFromLiveArgv(argv, exists = existsSync) {
  const raw = profileDirFromCommandLine(argv);
  if (!raw) return null;
  if (!/\s/.test(raw) || exists(raw)) return raw;
  const first = raw.split(/\s/)[0];
  return first && exists(first) ? first : raw;
}
// #478: the main browser process (no --type=) whose command line asks for `port` and that owns the
// LISTEN socket on it. Linux only, best effort: null when unsure (two candidates and no socket
// table, or a candidate that does not hold the socket). Bounded to PROC_SCAN_MAX processes.
export const PROC_SCAN_MAX = 4096;
export function findListeningBrowserProcess(port, {
  platform = process.platform,
  listPids = listProcPids,
  readArgv = pid => readProcessArgv(pid, { platform }),
  readFile = readFileSync,
  listFdTargets = listProcFdTargets,
  exists = existsSync,
  requireProfileDir = true,
} = {}) {
  if (platform !== 'linux') return null;
  try {
    const wanted = String(port);
    const candidates = [];
    for (const pid of listPids().slice(0, PROC_SCAN_MAX)) {
      const argv = readArgv(pid);
      if (!Array.isArray(argv) || argvDebugPort(argv) !== wanted) continue;
      if (argv.some(arg => String(arg).startsWith('--type='))) continue;
      candidates.push({ pid: Number(pid), argv });
    }
    if (!candidates.length) return null;
    const inodes = listeningSocketInodes(wanted, readFile);
    let owner = null;
    if (inodes && inodes.size) {
      owner = candidates.find(candidate => {
        try {
          return listFdTargets(candidate.pid).some(target => {
            const m = String(target).match(/^socket:\[(\d+)\]$/);
            return Boolean(m) && inodes.has(m[1]);
          });
        } catch {
          return false;
        }
      }) || null;
    } else if (candidates.length === 1) {
      owner = candidates[0];
    }
    if (!owner) return null;
    const profileDir = profileDirFromLiveArgv(owner.argv, exists);
    // #534 wants the argv even for the default profile, which has no --user-data-dir.
    if (!requireProfileDir) return { pid: owner.pid, argv: owner.argv, profileDir: profileDir || null };
    return profileDir ? { pid: owner.pid, argv: owner.argv, profileDir } : null;
  } catch {
    return null;
  }
}
export function profileDirFromCommandLine(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i] ?? '');
    if (arg.startsWith('--user-data-dir=')) return arg.slice('--user-data-dir='.length) || null;
    if (arg === '--user-data-dir') return list[i + 1] ? String(list[i + 1]) : null;
  }
  return null;
}
export const CDP_PROFILE_UNKNOWN_HINT = 'Profile is unknown — do not invent a new --user-data-dir. Enable remote debugging on the existing Chrome via chrome://inspect/#remote-debugging.';
export const CDP_NOT_FOUND_HINT = 'Daily Chrome attach failed on 9222. Isolated spawn is fallback only and is not the daily profile. Or set CDP_PORT=<port> for an Electron app';
// Chrome 136+ toggle mode has no /json/*; only the guid path from DevToolsActivePort accepts the socket.
export const BROWSER_WS_PATH = /^\/devtools\/browser\/[\w-]+$/;
export const ALLOW_IN_CHROME_DAEMON_START = 'Daemon failed to start — did you click Allow in Chrome?';
// ---------------------------------------------------------------------------
// tab-group / broadcast — multi-tab coordination
// ---------------------------------------------------------------------------

export const TAB_GROUPS_CACHE = resolve(RUNTIME_DIR, 'tab-groups.json');
// #532: opt-in local usage counter. With CDP_USAGE_LOG set, each CLI or MCP run appends
// {ts, command, via} to <runtime dir>/usage.jsonl — the canonical command name only, never arguments,
// URLs or selectors. Internal and unknown names are skipped; the file rotates to usage.jsonl.1 above
// USAGE_LOG_MAX_BYTES. Nothing leaves the machine; `npm run usage:report` reads it.
export const USAGE_LOG_MAX_BYTES = 1024 * 1024;
export const sleep = (ms, signal = daemonRequestAbortSignal()) => {
  const wait = Math.max(0, Number(ms) || 0);
  if (signal?.aborted) throw abortReason(signal, 'request aborted');
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, wait);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, 'request aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, wait);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};
export const CDP_DOMAIN_CLIENTS = new WeakMap();
export const PERCEIVE_PRIORITY_TEXT_RE = /\b(error|failed?|failure|invalid|required|warning|blocked|denied|unauthori[sz]ed|forbidden|saved|success|submitted|complete)\b/i;
export const SCREENSHOT_TIER_LABELS = Object.freeze({
  1: 'Page.captureScreenshot',
  2: 'Page.captureScreenshot fromSurface:false',
  3: 'Page.startScreencast frame',
});
// #488: in background mode nothing brings a tab forward, so a capture can meet a hidden document (a
// background tab, or any tab of a minimized window). Chrome sometimes renders a frame for it (live
// checks: 0.2-2.8 s) and sometimes never does, so tier 1 would wait out SCREENSHOT_TIMEOUT. The other
// tiers are wrong there: fromSurface:false copies whatever the window shows, which is another tab. A
// hidden document therefore gets one bounded plain capture and then a hidden-tab error. The daemon turns
// this on when it runs in background mode; in foreground mode it attached with Target.activateTarget.
export const HIDDEN_TAB_CAPTURE_TIMEOUT_MS = 3000;
export const HIDDEN_TAB_ERROR_CODE = 'hidden_tab';
// Commands whose hidden-tab failure can be rerun whole: they only capture.
export const HIDDEN_TAB_RERUN_COMMANDS = new Set(['shot', 'elshot', 'scanshot', 'fullshot', 'diff-shot']);
export const DIFF_SHOT_REGION_CELL_PX = 16;
export const DIFF_SHOT_REGION_LIMIT = 5;
// A cell needs this many changed pixels to join a region, so a stray pixel is never named.
export const DIFF_SHOT_REGION_MIN_PIXELS = 2;
// A region no element holds is "around" one it spills this far past: an outline, a focus ring, a shadow.
export const DIFF_SHOT_SPILL_PX = 8;
// Changed pixels this close outside one child, on a cell that hit-tests to its parent, are that child's.
export const DIFF_SHOT_STRIP_PX = 4;
// A region's label is page text: the page sends up to 200 chars, and the receipt shows 40 after redaction.
export const DIFF_SHOT_LABEL_SOURCE_CHARS = 200;
export const DIFF_SHOT_LABEL_CHARS = 40;
export const NAV_DOCUMENT_PROBE_INTERVAL_MS = 25;
export const NAV_DOCUMENT_PROBE_EXPR = 'JSON.stringify({url: location.href || "", readyState: document.readyState || ""})';
// #470: console and exception entries keep up to three 0-based stack frames so output can map
// them through source maps lazily. `loc` stays the generated top frame, 1-based like Error.stack.
export const SOURCE_MAPPED_CONSOLE_LEVELS = new Set(['error', 'assert', 'warning', 'warn']);
export const MAX_ACTION_DELTA_ENTRIES = 5;
export const MAX_ACTION_DIALOG_ENTRIES = 5;
export const MAX_ACTION_DIALOG_TEXT_LINES = 3;
export const MAX_ACTION_DIALOG_MESSAGE_CHARS = 200;
export const MAX_ACTION_JSON_DOM_DIFF_CHARS = 800;
export const FILL_TYPEAHEAD_LIMIT = 10;
export const FILL_TYPEAHEAD_MAX_CHARS = 80;
export const DEFAULT_REPORT_ACTION_LIMIT = 20;
export const DEFAULT_REPORT_JSON_BYTES_MAX = 64 * 1024;
export const DEFAULT_STALE_ARTIFACT_HOURS = 24;
export const SENSITIVE_METADATA_KEY_ALLOWLIST = new Set([
  'schema',
  'source',
  'targetId',
  'targetPrefix',
  'sessionId',
  'sessionStorage',
  'localStorage',
  'storage',
  'cookies',
  'cookieCount',
  'createdAt',
  'now',
  'ts',
  'index',
  'action',
  'kind',
  'status',
  'method',
  'path',
  'paths',
  'url',
  'origin',
  'title',
  'domain',
  'sameSite',
  'secure',
  'httpOnly',
  'expires',
  'redaction',
  'redacted',
]);
export const NOISY_ACTION_NETWORK_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'WebSocket']);
// Cut, then redact, then compact (#459): redaction only ever sees a bounded
// prefix, so a megabyte entry costs the same as a short one. The key always
// comes before its value, and a value cut off at the window edge is redacted
// to the end of the window, so the cut never exposes part of a secret.
export const ACTION_TEXT_REDACT_WINDOW = 4096;
export const MAX_FAILED_REQUEST_DETAILS = 2;
export const FAILED_REQUEST_BODY_CHARS = 200;
export const FAILED_REQUEST_BODY_TIMEOUT_MS = 1000;
// #589: the previous document's AX snapshot cannot be compared, and a snapshot
// of the loaded document could not be taken. This is not a no-change.
export const STALE_NAVIGATION_BASELINE_REASON = 'The comparison baseline is stale: the page navigated, and a baseline for the loaded document could not be captured.';
export const DOCUMENT_SCROLL_EDGE_OUTCOME = 'document-scroll-edge';
export const GENERIC_SINCE_ACTION_HINT = 'Use perceive --since-action if more evidence is needed';
export const LEFTOVER_AX_SCROLL_CENSUS_RE = /^(Interactive: |Console: |Coords: )/;
export const GENERIC_CHANGED_REASON = 'Observed page change after action.';
export const LEFTOVER_AX_SCROLL_NO_CHANGE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
export const LEFTOVER_AX_SCROLL_IDENTITY_HEADER_RE = /^(Page: |Viewport: )/;
export const LEFTOVER_AX_SCROLL_NO_CHANGE_BODY_RE = /^\(no changes detected in AX tree\)$/i;
export const NAVIGATION_OBSERVATION_HEADING_RE = /^Navigation observation:/m;
export const DOCUMENT_NAV_PLACEHOLDER_RE = /^\((untitled|unknown)\)$/i;
export const DOCUMENT_SCROLL_EDGE_DISPATCH_RE = /^Scrolled to (top|bottom)\.\s+(.+)$/;
export const DEFAULT_SKINNY_MUTATING_ACTIONS = new Set([
  'click', 'jsclick', 'fill', 'press', 'select', 'scroll', 'nav', 'navigate',
]);
// Code-generated identifiers a sensitive fill's value must never rewrite in a JSON model (#485).
export const ACTION_JSON_IDENTIFIER_KEYS = new Set(['schema', 'action', 'actionName', 'method', 'kind']);
export const REACTIVE_CLICK_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);
export const REACTIVE_CLICK_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'combobox', 'slider', 'spinbutton', 'textbox', 'searchbox',
]);
export const CLICKED_CONTROL_TAG_RE = /^(?:Clicked|JS-clicked|Pointer-clicked)\s+<([A-Za-z0-9]+)>/;
export const HIGH_SIGNAL_ACTION_TEXT_RE = /\b(saved|success|succeeded|complete|completed|done|created|updated|deleted|failed|failure|error|warning|invalid|required)\b|成功|勝利|完成|已儲存|儲存|失敗|錯誤|警告|無效|必填/i;
// Raw values of a sensitive fill (the typed text, the value it replaced, the live value) keyed by
// its fill value state and action target. A WeakMap keeps them out of every serialized object;
// receipts and logs read them only to scrub them (#485).
export const SENSITIVE_FILL_RAW_VALUES = new WeakMap();
// The per-target JSONL log is rotated once it passes this: the log is renamed to `<log>.1`
// (replacing an older one) and a new log is started, so a tab keeps about twice this on disk
// (#462). A rename that fails (a file locked on Windows) is retried after another full period,
// and the log keeps being written meanwhile.
export const SESSION_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
// Per-tab runtime artifacts: `cdp-<target>.log` (and its rotated `.1`), `cdp-<target>-screenshots/`,
// `cdp-<target>-downloads/` (#472), `cdp-<target>.observe.json` (#606, #618) and `cdp-<target>.crash.json`.
// closetab removes the observation file immediately. stop and daemon exit do not, so each
// daemon prunes them when it starts (#462). A tab's set goes once its newest file is older than
// RUNTIME_ARTIFACT_MAX_AGE_MS and it is not one of the RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS newest
// sets. The set of a live daemon or of the current target is never touched.
export const RUNTIME_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS = 20;
export const RUNTIME_ARTIFACT_PATTERN = /^cdp-(.+?)(\.log|\.log\.1|\.crash\.json|\.observe\.json|-screenshots|-downloads)$/;
// The prune runs once, after the daemon's first request has been answered, so it never sits
// between a new daemon and the command that started it. A daemon that gets no request still
// prunes after fallbackMs. `arm` is called once the daemon owns its endpoint.
export const RUNTIME_PRUNE_FALLBACK_MS = 30_000;
// session.secretValues maps value -> <secret:NAME>, the shape lib/redaction.mjs scrubs with.
export const SESSION_SECRET_SCRUB = Object.freeze({ keepKeys: null, minLength: MIN_SCRUB_SECRET_CHARS });
// Daemon protocol replies the CLI parses itself; they carry no page content.
export const UNSCRUBBED_DAEMON_COMMANDS = new Set(['meta', 'list_raw', 'stop']);
export const PLAYWRIGHT_ASSERTION_TEXT_ROLES = new Set(['alert', 'status', 'statustext', 'statictext', 'heading']);
// Roles that get visual layout annotations in perceive output
// Bound on the diff-only page text a `perceive -i` keeps (#487). It lives only
// in daemon memory, but `-d` does not bound it, so a long page would otherwise
// keep every text node. Text past the cap is not compared.
export const HIDDEN_TEXT_MAX_LINES = 2000;
export const HIDDEN_TEXT_MAX_CHARS = 64 * 1024;
export const HIDDEN_TEXT_CAP_NOTE = `  [note] diff-only -i text capped at ${HIDDEN_TEXT_MAX_LINES} lines / 64K chars; later page text is not compared`;
export const ENRICHED_ROLES = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'heading', 'img', 'image', 'video', 'form', 'table', 'dialog',
  'region', 'article', 'alert',
]);
// Roles that get @ref indices in perceive output (interactive elements)
export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'menuitem', 'tab', 'checkbox', 'radio', 'switch',
  'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
]);
// Content landmarks that should take early @refs (tweets, feed cards, etc.)
export const CONTENT_REF_ROLES = new Set(['article', 'feed', 'listitem', 'status']);
export const SKIP_LINK_NAME_RE = /skip\s+to\b|\bskip\b|keyboard|鍵盤|快速鍵|跳至/i;
export const DOCTOR_LIST_TARGET_PLACEHOLDER = '<target-from-list>';
export const STALE_REF_ERROR_CODE = 'CDP_STALE_REF';
// Perceive: enriched accessibility tree with inline visual layout annotations
// Options parsed from args: --diff, --selector <sel>, --interactive/-i, --depth <N>, --cursor-interactive/-C
export const TYPEAHEAD_OMITTED_NOTICE = 'Focused search/typeahead — suggestions omitted. Next: press Escape or perceive -s main';
export const TYPEAHEAD_FOCUS_ROLES = new Set(['searchbox', 'combobox']);
export const TYPEAHEAD_POPUP_ROLES = new Set(['listbox', 'option']);
export const PERCEIVE_COMPACT_FLAGS =
  '--last N | --adaptive | --qa | --summary | -i | -C | -d N | -x sel | -s sel | --keep-typeahead | --cards | --role feed | --unsafe-full | --verbose';
export const PERCEIVE_SNAPSHOT_FLAGS = new Set([
  '-i', '--interactive', '-C', '--cursor-interactive', '-d', '--depth',
  '-s', '--selector', '-x', '--exclude', '--keep-typeahead', '--last',
  '--adaptive', '--cards', '--role', '-F', '--frame',
]);
export const PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP = 8;
export const PERCEIVE_CHROME_MAX_RELATIVE_DEPTH = 2;
export const PERCEIVE_CHROME_LINE_CAP = 12;
export const PERCEIVE_CONTENT_LANDMARK_ROLES = new Set(['main', 'article']);
export const PERCEIVE_CHROME_LANDMARK_ROLES = new Set(['navigation', 'banner', 'complementary']);
export const PERCEIVE_COORDS_LINE = 'Coords: viewport CSS px (clickxy-ready; fixed/sticky tagged)';
export const PERCEIVE_COORDS_LINE_VERBOSE = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
export const VISIBLE_CONTROL_CAP_SWAP_SAMPLE = 4;
// Pure tree-building logic extracted from perceiveStr for testability.
// Takes raw AX nodes + page metadata, returns enriched tree lines and ref node IDs.
// Highest numeric ref a ref map has handed out; it survives refMap.clear() (#548).
export const REF_HIGH_WATER = Symbol('refHighWater');
// #437: the daemon's tab target id per CDP session, so a followed-href check can tell a
// popup this tab opened (TargetInfo.openerId) from any other new tab.
export const SESSION_TARGET_IDS = new Map();
// Anchored to the end of a line, with a URL that cannot hold `"`: the suffix always follows the
// receipt's closing quote, so link text that merely contains "→ opened new tab …" cannot match.
export const CLICK_OPENED_TAB_RE = / → opened (new tab|in tab) ([0-9A-Fa-f]{8,32}) ([^\s"]+)$/m;
export const CHILD_FRAME_CLICK_RE = / → child-frame (delivered|unobserved)(?: (\S+))?$/m;
export const CLICK_DOWNLOAD_STARTED_RE = / → download started "([^"]+)"/;
export const CLICK_DOWNLOAD_UNOBSERVED_RE = /no download event was observed/;
export const NAMED_IN_VIEWPORT_CLICK_OUTCOME = 'named-in-viewport-click';
// #747: named click also matches tabs, radios, and a label. A label with role=button,
// role=link, role=tab, or role=radio is that control. A label with no role is used only
// when its control is a radio or checkbox (an antd Segmented item) and no button, link,
// tab, or radio has the name, so a field label does not take a same-name button.
export const NAMED_IN_VIEWPORT_CLICK_SELECTOR = 'a, button, [role="link"], [role="button"], [role="radio"], [role="tab"], label';
// #745: how a receipt names its target element: aria-label, then its visible text, then title,
// whitespace collapsed, at most 80 characters. antd writes title="[object Object]" on an option
// whose label is a React node. The text skips aria-hidden subtrees (icon ligatures such as
// more_vert), script, style and template, and a form field's own options or value.
export function targetLabelExpression(name) {
  return `(function(el) {
      if (!el || typeof el.getAttribute !== 'function') return '';
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const textOf = () => {
        const tag = String(el.tagName || '').toUpperCase();
        if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'INPUT') return '';
        if (!('firstChild' in el)) return el.textContent;
        let out = '';
        const walk = (node) => {
          if (!node || out.length > 160) return;
          if (node.nodeType === 3) { out += node.nodeValue || ''; return; }
          if (node.nodeType !== 1 && node.nodeType !== 11) return;
          const nodeTag = String(node.tagName || '').toUpperCase();
          if (nodeTag === 'SCRIPT' || nodeTag === 'STYLE' || nodeTag === 'TEMPLATE') return;
          if (node !== el && typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return;
          for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
        };
        walk(el);
        return out;
      };
      return (clean(el.getAttribute('aria-label')) || clean(textOf()) || clean(el.getAttribute('title'))).substring(0, 80);
    })(${name})`;
}
// #427: Playwright-style `text=Save`, `text="Save"`, and `text='Save'` are aliases for the
// named form (a button, link, tab, radio, including a label with that role, or a
// role-less label for a radio or checkbox). That role-less label is used only when no
// button, link, tab, or radio matches. The match prefers the exact visible
// text or aria-label, then a whitespace-normalised fallback. Unquoted `text=` is not
// Playwright's case-insensitive substring match. `text=` also forces a name when the word
// is an HTML tag (`text=button` vs `button`). A word that is not a tag, such as Logout, is
// already that name.
export const TEXT_SELECTOR_PREFIX_RE = /^text=/i;
// Pointer-sequence click (#412): menus built on Radix / Headless UI open on pointerdown, so neither the mouse path
// (dropped on a hidden tab, "no-input-events") nor HTMLElement.click() opens them. This dispatches
// pointerdown, mousedown, pointerup, mouseup, click in the page at the element centre. It does not use Input.*
// events, so it also works while the window is covered. After a settle wait it reports the trigger's
// aria-expanded / data-state so the agent can tell whether a menu actually opened.
export const POINTER_CLICK_SETTLE_MS = 1500;
// #468: bounded actionability wait for click, fill and select on a CSS selector. It runs inside the
// page evaluation that already resolves the selector, so an element that is actionable at once costs
// no extra round trip. Otherwise it re-checks on every DOM mutation and every 50 ms until the element
// is attached, visible (non-zero box, not visibility:hidden / display:none; click and fill only) and
// enabled, or until the wait runs out. One deadline timer bounds it even where a hidden tab throttles
// the 50 ms poll. A target still disabled after the wait fails before any input is dispatched.
export const ACTIONABILITY_WAIT_DEFAULT_MS = 2000;
export const ACTIONABILITY_WAIT_MAX_MS = 30000;
export const ACTIONABILITY_POLL_MS = 50;
export const ACTION_DISABLED_NOT_SENT = {
  click: 'the click was not sent',
  fill: 'nothing was typed',
  select: 'no option was selected',
};
export const KEY_MAP = {
  enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
  tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  space:      { key: ' ',          code: 'Space',      keyCode: 32 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};
// Punctuation → CDP code/keyCode map for unshifted US keys
export const PUNCT_KEY_MAP = {
  '`': { code: 'Backquote',    keyCode: 192 },
  '-': { code: 'Minus',        keyCode: 189 },
  '=': { code: 'Equal',        keyCode: 187 },
  '[': { code: 'BracketLeft',  keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\':{ code: 'Backslash',    keyCode: 220 },
  ';': { code: 'Semicolon',    keyCode: 186 },
  "'": { code: 'Quote',        keyCode: 222 },
  ',': { code: 'Comma',        keyCode: 188 },
  '.': { code: 'Period',       keyCode: 190 },
  '/': { code: 'Slash',        keyCode: 191 },
};
// Shifted printable punctuation on a US keyboard. `key` stays the visible
// character, while code/keyCode identify the physical base key.
export const SHIFTED_PUNCT_KEY_MAP = {
  '~': { code: 'Backquote',    keyCode: 192 },
  '_': { code: 'Minus',        keyCode: 189 },
  '+': { code: 'Equal',        keyCode: 187 },
  '{': { code: 'BracketLeft',  keyCode: 219 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '|': { code: 'Backslash',    keyCode: 220 },
  ':': { code: 'Semicolon',    keyCode: 186 },
  '"': { code: 'Quote',        keyCode: 222 },
  '<': { code: 'Comma',        keyCode: 188 },
  '>': { code: 'Period',       keyCode: 190 },
  '?': { code: 'Slash',        keyCode: 191 },
  '!': { code: 'Digit1',       keyCode: 49 },
  '@': { code: 'Digit2',       keyCode: 50 },
  '#': { code: 'Digit3',       keyCode: 51 },
  '$': { code: 'Digit4',       keyCode: 52 },
  '%': { code: 'Digit5',       keyCode: 53 },
  '^': { code: 'Digit6',       keyCode: 54 },
  '&': { code: 'Digit7',       keyCode: 55 },
  '*': { code: 'Digit8',       keyCode: 56 },
  '(': { code: 'Digit9',       keyCode: 57 },
  ')': { code: 'Digit0',       keyCode: 48 },
};
export const PRESS_SEARCH_SUBMIT_FLAG = '--search-submit';
export const PRESS_PROBE_MARKER = 'chrome-cdp-ex.press-probe.v1';
export const PRESS_PROBE_KEY = '__chromeCdpExPressProbe';
export const PRESS_DELIVERY_WAIT_MS = 6500;
export const PRESS_DELIVERY_POLL_MS = 100;
export const DOCUMENT_SCROLL_EDGE_TOLERANCE_PX = 2;
// Automation scrolls (#486) call Element.prototype.scrollTo/scrollBy on the document's scrolling
// element instead of window.scrollTo/scrollBy: pages wrap the window methods with a positional
// (x, y) signature, which turns an options object into (0, 0). Scrolling the scrolling element
// scrolls the viewport. behavior 'instant' overrides CSS `scroll-behavior: smooth`, so a position
// read right after the call is final.
export const DOCUMENT_SCROLLER_JS = '(document.scrollingElement || document.documentElement)';
// ---------------------------------------------------------------------------
// drag (#471): a real mouse drag from one element to another element or point.
// ---------------------------------------------------------------------------
// The default mode intercepts drags (Input.setInterceptDrags) for the whole gesture.
// Whether Chrome starts an HTML5 drag is then decided by the page itself (draggable,
// a dragstart handler that does not cancel), not guessed from attributes: a started
// drag arrives as Input.dragIntercepted and is finished with Input.dispatchDragEvent
// at the destination; otherwise the gesture stays a plain pointer drag. --pointer
// skips interception, --html5 fails when no HTML5 drag starts.

export const DRAG_POINT_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
export const DRAG_PROBE_EVENT_ORDER = Object.freeze([
  'pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup',
  'dragstart', 'dragenter', 'dragover', 'drop', 'dragend',
]);
export const NON_FILLABLE_INPUT_TYPES = [
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'range', 'color',
];
export const ARIA_CONTROL_STATE_ATTRS = ['aria-pressed', 'aria-expanded', 'aria-checked', 'aria-selected'];
export const FILL_VALUE_PREVIEW_MAX = 120;
export const ACCEPT_DIALOG_FLAG = '--accept-dialog';
export const DECISION_DIALOG_TYPES = new Set(['confirm', 'prompt', 'beforeunload']);
// A click, fill, or press that opened one of these dialogs reached the page.
// Reporting it as not delivered would hide the --accept-dialog Next (#658, #607, #614).
export const INPUT_NOT_DELIVERED_KINDS = new Set([
  'no-click-box',
  'no-input-events',
  'press-not-delivered',
  'click-no-change',
  'fill-no-change',
  'fill-value-mismatch',
]);
// Chrome MatchPattern (base::MatchPattern): * is any length, ? is zero or one character,
// and \ escapes the next character. Case-sensitive, matched against the whole candidate.
export const MOCK_PATTERN_END = -1;
export const THROTTLE_PRESETS = Object.freeze({
  off: { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null },
  offline: { profile: 'offline', offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  'slow-3g': { profile: 'slow-3g', offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { profile: 'fast-3g', offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  lte: { profile: 'lte', offline: false, latencyMs: 40, downloadKbps: 12000, uploadKbps: 12000 },
});
export const TABLE_COLLECTOR_WORLD = 'chrome-cdp-ex-table-collector-v1';
export const TABLE_COLLECTOR_OBJECT_GROUP = 'chrome-cdp-ex-table-collector';
// #490: a beforeunload prompt that the daemon dismissed cancels the reload / nav. Chrome reports
// that only as `Page.reload` → {} with no main-frame commit, or `Page.navigate` → net::ERR_ABORTED,
// and the old document still reads `complete`. The evidence is a dismissed beforeunload dialog
// answered during this dispatch plus no main-frame Page.frameNavigated (pageGeneration unchanged).
// A slow handler opens the dialog long after Page.reload returned (#500 review), so in dismiss mode
// `awaitMs` keeps looking until the document commits or the dialog shows up. Accept mode never
// waits: an accepted prompt cannot cancel anything.
export const NAVIGATION_CANCEL_EVIDENCE_WAIT_MS = 3000;
export const NAVIGATION_CANCEL_POLL_MS = 50;
// --- Cascade: CSS origin tracing via CSS.getMatchedStylesForNode ---
export const INHERITABLE_PROPS = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'white-space', 'word-spacing', 'visibility',
  'cursor', 'direction', 'list-style',
]);
export const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS = new Set(['eval', 'eval64', 'call']);
// Same three script commands: their flow step is one body, not a word list.
export const FLOW_SCRIPT_COMMANDS = BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS;
// --- Repeat: bounded loop primitive ---
// `repeat <count> <cmd> [args...]` runs the inner command up to count times.
// Defaults to fail-fast (halt on first error) so a stale @ref or missing
// element does not waste 50 round-trips silently. `--continue` (or `-c`) keeps
// going through errors and reports the tally at the end. The cap is
// intentionally low — repeat is for "press c 5 times to advance through MUD
// dialogue", not for unbounded loops; agents that need more should drive their
// own loop with state checks between iterations.
export const REPEAT_CAP = 50;
// `flow` is intentionally allowed: `repeat N flow "step1; step2; ..."` is the
// documented pattern for bounded multi-step loops (combat turns, multi-phase
// dialogues). Nesting is a single level — the inner flow runs through the
// same daemon dispatcher and cannot recurse back into repeat. `batch` stays
// blocked because its parallel/JSON modes are awkward to compose linearly,
// and `repeat`/`stop` are blocked to avoid recursion and IPC corruption.
// `_activate` is the daemon's internal foreground request (#488): only the CLI sends it, never a
// composite step, because it switches the user's active tab.
export const REPEAT_BLOCKED = new Set(['repeat', 'batch', 'stop', '_activate']);
export const BATCH_BLOCKED = new Set(['batch', 'stop', 'repeat', 'flow', '_activate']);
// --- Replay: execute record-actions artifacts ---
export const REPLAY_BLOCKED = new Set(['replay', 'record-actions', 'recordactions', 'batch', 'flow', 'repeat', 'stop', '_activate']);
export const DEFAULT_PROFILE_REMOTE_DEBUGGING_BLOCKED_MAJOR = 136;
export const CHROMIUM_VERSION_DIR_RE = /^\d+\.\d+\.\d+\.\d+$/;
export const DAILY_BROWSER_APP_NAMES = {
  darwin: {
    chrome: 'Google Chrome',
    edge: 'Microsoft Edge',
    brave: 'Brave Browser',
  },
};
// Documentation for `help spawn-debug-browser` (#398). tests/cli-commands.test.mjs keeps this table and the
// parser below in step: every parser flag must be listed and every listed flag must parse.
export const SPAWN_DEBUG_BROWSER_FLAGS = Object.freeze([
  { flags: ['--port', '-p'], arg: 'N', text: 'CDP port (default 9222).' },
  { flags: ['--host'], arg: 'HOST', text: 'CDP host (default 127.0.0.1).' },
  { flags: ['--url', '-u'], arg: 'URL', text: 'Open this URL in the launched browser.' },
  { flags: ['--profile-dir', '--user-data-dir'], arg: 'DIR', text: 'Profile directory (default: a persistent non-default dir per browser, so logins survive).' },
  { flags: ['--daily-profile'], arg: null, text: "Use the browser's default user-data-dir instead; Chrome/Edge 136+ ignore remote debugging there." },
  { flags: ['--browser'], arg: 'edge|chrome|brave', text: 'Browser to launch (a bare word such as `chrome` works too).' },
  { flags: ['--exe', '--executable'], arg: 'PATH', text: 'Browser executable.' },
  { flags: ['--headless'], arg: null, text: 'Run headless; `--headless=MODE` passes MODE (default new).' },
  { flags: ['--no-sandbox'], arg: null, text: 'Pass --no-sandbox to the browser (containers, CI).' },
  { flags: ['--disable-gpu'], arg: null, text: 'Pass --disable-gpu to the browser.' },
  { flags: ['--allow-occlusion'], arg: null, text: 'Do not pass --disable-features=CalculateNativeWinOcclusion or --disable-backgrounding-occluded-windows (see Notes).' },
  { flags: ['--background'], arg: null, text: 'Also CDP_BACKGROUND=1: add anti-throttling flags and minimize the new window once CDP answers (see Notes).' },
  { flags: ['--wait-ms'], arg: 'N', text: `Wait up to N ms for CDP to answer (default ${DEFAULT_SPAWN_READY_TIMEOUT_MS}).` },
  { flags: ['--format'], arg: 'text|json', text: 'Output format.' },
  { flags: ['--help', '-h'], arg: null, text: 'Print this help without launching anything.' },
]);
export const SPAWN_DEBUG_BROWSER_NOTES = Object.freeze([
  'Default browser is edge, or $CDP_DEBUG_BROWSER when set.',
  'Port already in use: if the occupant does not answer /json/version (for example Chrome\'s chrome://inspect toggle on 9222), the command fails. Pick another port with --port N, then set CDP_PORT=N for list/perceive/stop.',
  'By default the launched browser gets --disable-features=CalculateNativeWinOcclusion and --disable-backgrounding-occluded-windows. Without them, a debug window that another window fully covers can turn hidden (document.visibilityState=hidden): Chrome then drops Input.* events, so click/press fail with no-input-events, and captures may get no frame. Covered windows keep rendering instead. Use --allow-occlusion to keep the browser default.',
  'Later commands run in background mode by default: they do not activate tabs. --background (or CDP_BACKGROUND=1) also adds --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling and, unless headless, minimizes the launched window through Browser.setWindowBounds. The window can still appear briefly at launch. Without it the launched window is left as it is.',
  'Unknown flags print this help and launch nothing.',
]);
export const DISMISS_MODAL_ESCAPE_CHECKS = 4;
export const DISMISS_MODAL_ESCAPE_CHECK_MS = 150;
// How long a map request may still answer after loadSourceMapText gave up on it (see below).
export const SOURCE_MAP_LATE_REPLY_TIMEOUT_MS = 60_000;
// A call that opts out of background mode (CDP_BACKGROUND=0 / CDP_FOREGROUND=1) may reach a daemon that
// is already running in background mode, which never sees that call's environment. The CLI then sends
// this request first: a hidden tab is activated and given up to REVEAL_POLL_TIMEOUT_MS to report visible;
// a visible tab is left alone, so the window is not raised again on every command (#488).
export const FOREGROUND_ACTIVATE_COMMAND = '_activate';
export const REVEAL_POLL_TIMEOUT_MS = 300;
export const DAEMON_SIDE_EFFECT_AUTHORIZATIONS = new Set([
  'mutation',
  'conditional',
  'composite',
  'raw-script',
  'raw-cdp',
]);
// Each probe step (one connect, one request) gets at most this, so a wedged daemon costs
// little before the fallback.
export const DAEMON_PAGE_LIST_PROBE_TIMEOUT_MS = 1500;
// A daemon whose idle timer fires within this is not used: `meta` and `list_raw` do not
// reset the timer (#419), so it could exit before the next request reaches it (#440).
// It must exceed one probe step, since an idle exit would also abort an in-flight list_raw.
export const DAEMON_IDLE_EXIT_MARGIN_MS = 5000;
// After a daemon's idle deadline its shutdown runs at once; this covers timer lateness.
export const DAEMON_IDLE_EXIT_GRACE_MS = 250;
export const STOP_REQUEST_TIMEOUT_MS = 10_000;
export const STOP_KILL_POLLS = 20;
export const STOP_KILL_POLL_MS = 100;
// A liveness probe only has to tell "nothing listens" (an immediate error) from "something
// may": a timeout is never proof of absence, so a short one costs nothing in correctness.
export const STOP_PROBE_TIMEOUT_MS = 1000;
export const ENDPOINT_ABSENT_CODES = DAEMON_ENDPOINT_ABSENT_CODES;
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const CLI_HELP_LAYOUT = Object.freeze([
  {
    "name": "help",
    "headGap": 1,
    "summaryGap": 20,
    "summaryIndent": null
  },
  {
    "name": "list",
    "headGap": 1,
    "summaryGap": 6,
    "summaryIndent": null
  },
  {
    "name": "target",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "tab-group",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "broadcast",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "use",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "attach",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "current",
    "headGap": 1,
    "summaryGap": 12,
    "summaryIndent": null
  },
  {
    "name": "forget",
    "headGap": 1,
    "summaryGap": 21,
    "summaryIndent": null
  },
  {
    "name": "perceive",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "snap",
    "headGap": 2,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "controls",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "eval",
    "headGap": 2,
    "summaryGap": 13,
    "summaryIndent": null
  },
  {
    "name": "eval64",
    "headGap": 1,
    "summaryGap": 10,
    "summaryIndent": null
  },
  {
    "name": "call",
    "headGap": 2,
    "summaryGap": 10,
    "summaryIndent": null
  },
  {
    "name": "elshot",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "shot",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "diff-shot",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "html",
    "headGap": 2,
    "summaryGap": 9,
    "summaryIndent": null
  },
  {
    "name": "nav",
    "headGap": 3,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "mock",
    "headGap": 2,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "clock",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "throttle",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "status",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "console",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "summary",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "report",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "checkpoint",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "restore",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "record-actions",
    "headGap": 1,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "export-playwright",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "replay",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "frame",
    "headGap": 1,
    "summaryGap": 5,
    "summaryIndent": null
  },
  {
    "name": "overlay",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "qa",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "responsive-audit",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "verify-click",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "net",
    "headGap": 3,
    "summaryGap": 20,
    "summaryIndent": null
  },
  {
    "name": "click",
    "headGap": 3,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "jsclick",
    "headGap": 1,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "clickxy",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "type",
    "headGap": 4,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "press",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "scroll",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "hover",
    "headGap": 3,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "drag",
    "headGap": 4,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "waitfor",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "loadall",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "wait",
    "headGap": 4,
    "summaryGap": 13,
    "summaryIndent": null
  },
  {
    "name": "fill",
    "headGap": 4,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "select",
    "headGap": 2,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "fullshot",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "scanshot",
    "headGap": 1,
    "summaryGap": 17,
    "summaryIndent": null
  },
  {
    "name": "styles",
    "headGap": 2,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "components",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "cookies",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "cookieset",
    "headGap": 1,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "cookiedel",
    "headGap": 1,
    "summaryGap": 9,
    "summaryIndent": null
  },
  {
    "name": "dialog",
    "headGap": 2,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "viewport",
    "headGap": 1,
    "summaryGap": 4,
    "summaryIndent": null
  },
  {
    "name": "emulate",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "upload",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "text",
    "headGap": 4,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "table",
    "headGap": 3,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "back",
    "headGap": 4,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "forward",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "reload",
    "headGap": 2,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "closetab",
    "headGap": 1,
    "summaryGap": 17,
    "summaryIndent": null
  },
  {
    "name": "netlog",
    "headGap": 2,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "inject",
    "headGap": 1,
    "summaryGap": 3,
    "summaryIndent": null
  },
  {
    "name": "cascade",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "record",
    "headGap": 1,
    "summaryGap": 14,
    "summaryIndent": null
  },
  {
    "name": "evalraw",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "batch",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "flow",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "repeat",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "doctor",
    "headGap": 1,
    "summaryGap": 4,
    "summaryIndent": null
  },
  {
    "name": "keepalive",
    "headGap": 1,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "open",
    "headGap": 2,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "spawn-debug-browser",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "dismiss-modal",
    "headGap": 1,
    "summaryGap": 12,
    "summaryIndent": null
  },
  {
    "name": "stop",
    "headGap": 2,
    "summaryGap": 4,
    "summaryIndent": null
  }
].map(record => Object.freeze(record)));
export const CLI_HELP_TEMPLATE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

{{command:help}}
{{command:list}}
                                    JSON includes schema/pages/recommendation/nextSteps for agents.
                                    Prefers non-blank pages when recommending the next target (* marker).
{{command:target}}
                                    Ambiguous matches return candidate URLs/titles and follow-up commands.
{{command:tab-group}}
                                    create <name> [targets...] | add/remove <name> <target> | show/delete <name>
{{command:broadcast}}
                                    JSON bounds per-target previews; --full-results opts into complete payloads.
{{command:use}}
                                    Accepts 9222/<target> to bind a CDP port to the alias.
{{command:attach}}
{{command:current}}
{{command:forget}}
{{command:perceive}}
                                    --diff: show only changes since last perceive
                                    --since-action: show changes caused by the last mutating command
                                    --since-action and --diff keep each surviving element's @ref
                                    --qa / --summary: compact QA summary (url/title/blank/console/next)
                                    --max-diff-lines N: truncate long text output
                                    --adaptive / --last auto: density+error aware text-row budget
                                    --last N: keep last N text rows (explicit wins over adaptive)
                                    JSON includes structured refs plus recommendation/nextSteps.
                                    JSON with --diff/--since-action returns chrome-cdp-ex.perceive-diff.v1
                                    --frame @fN / -F @fN: perceive inside an iframe; refs become @fN:M
                                    -s <sel> / --selector: scope to CSS selector subtree
                                    -x <sel> / --exclude: drop matching chrome (must not empty main; prefer text --auto or -s main)
                                    -i / --interactive: only show interactive elements
                                    -d N / --depth N: limit tree depth
                                    -C / --cursor-interactive: include non-ARIA clickable elements (@c refs)
                                    --verbose / -v: print repeated visible-control lines and the long Coords note
                                    --keep-typeahead: keep focused search suggestion listbox in the tree
                                    --cards / --role feed: compact article/listitem cards (chrome-cdp-ex.cards.v1)
{{command:snap}}
{{command:controls}}
{{command:eval}}
                                    --b64 / -b <base64>: decode UTF-8 base64 first
                                    (safe transport for CJK / shell-hostile expressions)
                                    --raw: compact JSON for objects (skip pretty multi-line stringify)
                                    --fire-and-forget: dispatch without awaiting returned promise
                                    let/const/class exist only for that call; the result is still the last expression
                                    var and globalThis or window assignments stay on the tab; a sloppy function stays too
{{command:eval64}}
{{command:call}}
{{command:elshot}}
{{command:shot}}
{{command:diff-shot}}
{{command:html}}
{{command:nav}}
                                    Successful document nav is URL+title (+ readyState). --compact is one line.
                                    --accept-dialog: accept this navigation's beforeunload (default dismisses it; Kind: navigation-cancelled)
{{command:mock}}
                                    add <urlPattern> --status code --body text [--content-type type]
                                    * = any length (including / and ?), ? = zero or one character, \\ escapes * ? and \\. Case-sensitive.
                                    A pattern with ://, a leading *, or a scheme matches that whole URL.
                                    No scheme and a leading / matches the path and query only.
                                    No scheme otherwise matches the path and query. With a dot it also matches the host after :// and one subdomain label.
                                    A pattern that cannot match warns when it is added. Hit counts persist with the rule.
                                    The HTTP cache is disabled while a mock is active.
{{command:clock}}
                                    freeze --at date-or-epoch-ms | offset --ms delta
{{command:throttle}}
                                    custom --latency ms --download kbps --upload kbps
{{command:status}}
                                    --runtime: include Performance.getMetrics counters
                                    --vitals: LCP, CLS, INP, long tasks, nav timing (buffered)
{{command:console}}
{{command:summary}}
{{command:report}}
                                    --qa/--summary returns a compact chrome-cdp-ex.qa-summary.v1 handoff
{{command:checkpoint}}
{{command:restore}}
  restore <target> --json <json> [--format json]  Restore an inline checkpoint JSON artifact
{{command:record-actions}}
{{command:export-playwright}}
{{command:replay}}
  replay <target> --json <json> [--format json]  Replay an inline record-actions JSON artifact
{{command:frame}}
{{command:overlay}}
{{command:qa}}
                                    Optional: --click <sel|@ref> --expect-text text --expect-request pattern
{{command:responsive-audit}}
                                    Defaults to desktop 1440x900 + mobile 390x844.
                                    Collects screenshot, overflow-x, scroll metrics, controls, blank/console signals.
{{command:verify-click}}
                                    --expect-text text --expect-request pattern --expect-status code --no-console-errors
{{command:net}}
{{command:click}}
                                    --js / -j: use HTMLElement.click() (JS fallback)
                                    --accept-dialog: accept a native confirm, prompt, or beforeunload this click opens (default is dismiss; Kind: native-dialog)
                                    --qa/--summary: compact pass/fail QA receipt without full DOM dump
                                    name: button, link, tab, radio (a label with that role counts), or a role-less radio/checkbox label (only when none of those match) by exact visible text or aria-label; pointer click that moves focus, skinny URL receipt. jsclick keeps the in-page click
                                    text=Name / text="Name": same match. A single word that parses as CSS (button, label) is a CSS selector, so use text=button. Logout is not a tag, so click Logout is already that name
{{command:jsclick}}
                                    Use when overlays or hit-testing block the realistic mouse path.
                                    name: button, link, tab, radio (a label with that role counts), or a role-less radio/checkbox label (only when none of those match); scrollIntoView if off-screen, no perceive dump
{{command:clickxy}}
{{command:type}}
                                    Works in cross-origin iframes unlike eval-based approaches
{{command:press}}
                                    Enter dispatches keyDown with a carriage return to the focused element, including inside batch.
                                    --search-submit: opt in to a results-link submit; the receipt names the link and does not claim a key press.
{{command:scroll}}
                                    Successful document-scroll-edge is scrollY/scrollMax/at-bottom. --compact is metrics only.
{{command:hover}}
{{command:drag}}
                                    <to> is a selector, @ref, or x,y CSS pixels; the source is scrolled into view first.
                                    Default: one gesture with Input.setInterceptDrags; if the page starts an HTML5 drag,
                                    dragEnter/dragOver/drop go to the destination with the intercepted data.
                                    --html5 fails when no HTML5 drag starts; --pointer sends mouse events only.
                                    --steps N: mouseMoved steps between press and release (default 10, max 100).
                                    A covered start or drop point fails with Kind: covered and sends nothing.
{{command:waitfor}}
  waitfor <target> --gone <sel|@ref> [ms]  Wait for element to DISAPPEAR (streaming end)
  waitfor <target> --text "str" [--scope sel] [ms]  Wait for text to appear on page
{{command:loadall}}
                                    [interval-ms] is the click interval (default 1500), not a timeout.
                                    --timeout-ms N: fail if the control is still present (default 30000, max 5 min).
{{command:wait}}
{{command:fill}}
                                    --react: native value setter + input/change events
                                    "" clears the field (native setter + input/change events)
                                    --secret NAME: type $CDP_SECRET_NAME or NAME from CDP_SECRETS_FILE;
                                      receipts, logs and records show <secret:NAME>, never the value
                                    Receipt shows the previous value; a rejected value is fill-value-mismatch
                                    JSON defaults to chrome-cdp-ex.fill.v1; --full restores action.v1
{{command:select}}
{{command:fullshot}}
{{command:scanshot}}
{{command:styles}}
                                    On no-match, error includes root/scope and an eval fallback
{{command:components}}
                                    Props/state are bounded and redacted unless --unsafe-full is explicit.
{{command:cookies}}
{{command:cookieset}}
{{command:cookiedel}}
{{command:dialog}}
                                    Default dismisses confirm, prompt, and beforeunload. accept is explicit and also accepts later confirms.
{{command:viewport}}
{{command:emulate}}
                                    color-scheme dark|light|no-preference
                                    reduced-motion reduce|no-preference
                                    off/reset clears overrides; JSON returns chrome-cdp-ex.emulate.v1
{{command:upload}}
{{command:text}}
                                    --auto: extract main content (strips nav/aside/script/style); PDF plugin tabs return page-1 text
                                    -x / --exclude: extra CSS selectors to strip
                                    --root auto|body|document|default|<sel>: search root for selector resolution
                                    On no-match, error includes root/scope and an eval fallback
{{command:table}}
{{command:back}}
{{command:forward}}
{{command:reload}}
                                    --accept-dialog: accept this reload's beforeunload (default dismisses it; Kind: navigation-cancelled)
{{command:closetab}}
{{command:netlog}}
{{command:inject}}
                                    --css "<text>"   Inject inline <style>
                                    --css-file <url> Inject <link rel="stylesheet">
                                    --js-file <url>  Inject <script src> and wait for load
                                    --remove [id]    Remove injected element(s) (all, or by id)
{{command:cascade}}
                                    Optional: filter to one property (e.g. "background-color"); JSON returns chrome-cdp-ex.cascade.v1
{{command:record}}
  record <target> --action click @5 Record events around an action (click/press/fill/select/type/scroll/nav)
  record <target> --until "dom stable"|"network idle"  Record until page quiets (max 30s)
{{command:evalraw}}
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
{{command:batch}}
                                    --format json returns chrome-cdp-ex.batch.v1 failure handoff
                                    Pipe syntax: 'fill @3 hello | fill @5 world | click @7'
                                    JSON syntax: '[{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]'
                                    --parallel  Run read-only/extraction commands concurrently (mutating commands are rejected as Kind:usage / cdp help batch)
                                    --plain     Human-readable per-step output (default: pretty JSON)
                                    --compact   One line per step (head + first line of result)
{{command:flow}}
                                    Each step is a normal command (e.g. "click @1"), a millisecond wait
                                    such as wait 2000, or a settle alias:
                                    "wait dom stable" / "wait network idle" — uses settle helper.
                                    A semicolon separates flow steps only outside quotes (' " \`).
                                    A quote opens only at the start of a word. Inside quotes, a backslash is literal, except \\; which keeps a semicolon. The opening quote always closes.
                                    An unquoted \\; before a command name fails unless it is an unquoted eval, eval64, or call body. Quote a trailing backslash: fill #p "C:\\a\\"; summary.
                                    A backtick-quoted word in a non-script step is one argument with the backticks removed. A value with significant whitespace or a quote must be wrapped in a quote kind it does not contain. An unquoted fill or type value is trimmed, and a run of whitespace is an argument boundary.
                                    Assertions: "assert selector <css>", "assert selector-missing <css>", "assert text <value>".
                                    Halts and exits non-zero on the first failing step; JSON preserves chrome-cdp-ex.flow.v1.
                                    Example: flow A7BA "click @1; wait 2000; eval const x = 1; x; summary"
{{command:repeat}}
                                    --continue / -c: keep going through errors and report tally.
                                    --until-selector <css> | --until-selector-missing <css> | --until-text <text>
                                    re-checks after each settled iteration; cap exhaustion exits non-zero.
                                    Cannot wrap repeat/batch/stop (recursion / IPC corruption).
                                    Can wrap flow for multi-step turn loops, e.g.
                                    repeat A7BA 3 flow "click @1; wait dom stable; text .log"
                                    Useful for advancing MUD dialogue ("repeat 5 press space"),
                                    retry-style probes, or short keypress sequences. Re-perceive
                                    between iterations if the DOM changes — refs are not auto-remapped.
                                    Example: repeat A7BA 5 press c
{{command:doctor}}
                                    daemon socket state, fd limit, CDP_PORT/DevToolsActivePort reachability,
                                    debuggable tab inventory, browser permission, Recommendation, and onboarding next steps.
                                    Readiness: ready | usable-with-warnings | blocked.
                                    Checks expose severity: blocking | warning | advisory | ok.
                                    Headless CDP sessions treat unconfirmed permission as advisory, not a blocker.
                                    When CDP is unreachable, FAIL hint is one same-profile relaunch line from the
                                    last known --user-data-dir; do not invent a new profile or DISPLAY.
                                    No target required. Exits 1 if any check FAILs.
{{command:keepalive}}
{{command:open}}
                                    JSON includes schema/target/approval/recommendation/nextSteps for agents.
                                    Default open returns the target prefix and a follow-up perceive command.
                                    --perceive dumps the full page after attach (opt-in).
                                    --reuse-url reuses an existing tab matching the URL when unique.
                                    --background (or CDP_BACKGROUND=1) opens the tab without focusing it.
                                    Default attach wait is fail-fast (5s). Use --attach-timeout-ms 60000
                                    when Chrome may still prompt "Allow debugging?".
                                    --attach-timeout-ms 0 returns the target handoff without waiting.
                                    --ready-timeout-ms bounds document.readyState waiting after attach.
                                    --ready-selector also waits for a CSS selector before returning.
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
{{command:spawn-debug-browser}}
                                    Rejects an occupied listener before spawning; choose another --port.
                                    --host HOST binds remote debugging address (default 127.0.0.1).
                                    --headless [new|old], --no-sandbox, --disable-gpu help CI/container/headless runs.
                                    --wait-ms N bounds the readiness probe before success.
                                    --background adds anti-throttling flags and minimizes the new window.
                                    Returns ready target prefix + next perceive command when a page is available.
                                    JSON includes pid/profileDir/port/url/targetId/targetPrefix/readiness/cleanup.
                                    Uses --remote-debugging-port + --user-data-dir; does not touch your main profile.
                                    "spawn" is a short alias.
{{command:dismiss-modal}}
                                    avoids triggering background shortcuts the way a bare "press Space" does.
{{command:stop}}

ACTION FEEDBACK
  click, verify-click, jsclick, clickxy, drag, fill, type, press, select, scroll,
  upload, inject, dismiss-modal, and viewport (when resizing) automatically wait for DOM to
  settle and return compact action evidence plus a perceive diff.
  Named click / jsclick (a control name, not @ref or CSS)
  is report-only: skinny URL receipt, no AX dump. A named click is a
  pointer click that moves focus; the receipt says Clicked. jsclick and
  click --js keep the in-page click and say JS-clicked. Unique off-screen
  names scrollIntoView first.   Mouse click @ref still
  fail-closes with no-input-events. Mouse click @ref / CSS hit-tests the
  click point first: when another element is on top it fails with
  Kind: covered, names that element, and sends nothing. Next is overlay when a
  fixed or sticky layer that does not contain the target and can receive hits
  covers most of the viewport, dismiss-modal for a dialog, and click --js for a
  header, sidebar, toast, bottom strip, or pointer-events:none shell. After the click is
  sent, the intended element must receive it (Kind: misdirected when it lands
  elsewhere). A click or jsclick on a control that should react exits 1 with
  Kind: click-no-change when nothing visible changes. A download, a new tab
  (including window.open), or a cross-origin frame click exits 0 and Next does
  not repeat it. click, fill and select
  on a CSS selector wait up to 2s (--wait-ms N; 0 = no wait) for the element to be
  attached, visible and enabled; a disabled target (or @ref) fails with
  Kind: disabled and sends nothing. scroll to top/to bottom is also
  report-only (window document or nested overflow).
  Sequential batch fill then press Enter is report-only on the fill:
  leftover typeahead AX / quicksearch is not the success signal.
  Sequential batch hover then eval is report-only on the hover:
  leftover AX recapture races CSS :hover and is not the success signal.
  hover prints its receipt only after the target matches :hover. On a visible
  tab, a point another element covers fails within a few polls and names that
  element (is covered by <…>); if the point is on the target and :hover still
  does not match, the wait is about 1s. A hidden tab keeps the longer wait so
  a late compositor delivery can succeed. If :hover never matches, the command
  fails with Kind: hover-not-delivered and one Next command
  (CDP_BACKGROUND=0 cdp hover when the tab is hidden).
  Search-submit press probes once or opens /models?search=<filled>,
  then returns on the listing URL. No 1500 ms typeahead poll.
  qa returns a semantic QA report and includes action evidence when --click is used.
  back, forward, and nav return action evidence plus a full perceive.
  reload returns action evidence plus a bounded lightweight page observation.
  Each mutating action also snapshots console/exception/network buffers before
  dispatch and reports compact deltas such as console errors, failed requests,
  or requests still pending after the action observation window.
  If that post-action observation times out after the action was sent, the
  command reports success with "observation timed out" instead of a pure timeout.
  No need to manually run perceive or perceive --diff after these actions.
  To re-check what the last action changed, run perceive --since-action.

<target> is a unique targetId prefix from "cdp list" or a saved alias from
"cdp use <target> --name app". If a prefix is ambiguous, use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: perceive, status, summary, console, frame, snap, controls, eval, eval64, call, wait, keepalive, shot, diff-shot,
  elshot, fullshot, scanshot, html, nav, net, mock, clock, throttle, click, jsclick, clickxy, hover, drag, type, press,
  scroll, fill, select, waitfor, loadall, styles, cookies, cookieset, cookiedel, dialog,
  viewport, emulate, upload, text, table, components, back, forward, reload, closetab, netlog, inject, cascade,
  record, checkpoint, restore, record-actions, export-playwright, replay, report, qa, responsive-audit,
  verify-click, evalraw, batch, flow, repeat, stop.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;
export function renderCliHelp(surface = COMMAND_SURFACE, template = CLI_HELP_TEMPLATE) {
  if (!isCommandSurface(surface)) {
    throw new Error('CLI help surface: validated command surface required');
  }
  const markers = [...String(template).matchAll(/\{\{command:([^}]+)}}/g)].map(match => match[1]);
  if (surface.commands.length !== CLI_HELP_LAYOUT.length) {
    throw new Error(`CLI help surface: expected exactly ${CLI_HELP_LAYOUT.length} commands`);
  }
  const expected = [...surface.commands]
    .sort((left, right) => left.help.order - right.help.order)
    .map(command => command.name);
  for (const name of markers) {
    if (!surface.resolve(name)) throw new Error(`CLI help template: unknown command marker ${name}`);
  }
  if (markers.length !== expected.length || new Set(markers).size !== markers.length) {
    throw new Error('CLI help template: every help marker must appear exactly once');
  }
  if (!markers.every((name, index) => name === expected[index])) {
    throw new Error('CLI help template: command marker order drifted');
  }
  let output = String(template);
  const layoutByName = new Map(CLI_HELP_LAYOUT.map(record => [record.name, record]));
  if (layoutByName.size !== CLI_HELP_LAYOUT.length) throw new Error('CLI help layout: duplicate command name');
  for (const name of expected) {
    const record = layoutByName.get(name);
    if (!record) throw new Error(`CLI help layout: missing whitespace record for ${name}`);
    const command = surface.resolve(name);
    const tokens = command.help.synopsis.trim().split(/\s+/);
    const synopsis = tokens.length === 1
      ? tokens[0]
      : `${tokens[0]}${' '.repeat(record.headGap)}${tokens.slice(1).join(' ')}`;
    const row = record.summaryGap === null
      ? `  ${synopsis}\n${' '.repeat(record.summaryIndent)}${command.help.summary}`
      : `  ${synopsis}${' '.repeat(record.summaryGap)}${command.help.summary}`;
    output = output.replace(`{{command:${record.name}}}`, row);
  }
  if (/\{\{command:/.test(output)) throw new Error('CLI help template: unresolved command marker');
  return output;
}
export function renderCardHelp(surface = COMMAND_SURFACE) {
  if (!isCommandSurface(surface)) {
    throw new Error('CLI card help: validated command surface required');
  }
  const rows = [];
  for (const name of SURVIVOR_COMMANDS) {
    const command = surface.resolve(name);
    if (!command) throw new Error(`CLI card help: missing survivor ${name}`);
    rows.push(`  ${command.help.synopsis}`);
  }
  return `cdp - attach to the Chrome/Electron tab you already have

Usage: cdp <command> [args]

  help [command]                    Survivor card; leftover verbs still have topic help

${rows.join('\n')}

Flags (not product names): click --js is JS click; eval --b64 is base64.
Unique off-screen click names scrollIntoView if off-screen.
perceive -C -d 8 for structure/@refs; -x <sel> / --exclude drops chrome.
text --auto for what the page says.
Window size: viewport|resize <target> WxH; responsive-audit <target> --viewport WxH.

First step: chrome://inspect/#remote-debugging (keeps logins). spawn-debug-browser, --daily-profile, and isolated profiles have no user logins; ask first.
Electron or a browser on its own port: CDP_PORT=<port> (example 9333, not 9222).
Opt-in guardrails (not a security boundary): CDP_CONTENT_BOUNDARIES=1, CDP_ALLOWED_ORIGINS, CDP_DENY_ACTIONS, CDP_FRAME_SITES, CDP_ISOLATED_ONLY=1.

cdp help <command> prints leftover topic help.
`;
}
export const CATALOG_USAGE = renderCliHelp(COMMAND_SURFACE);
export const USAGE = renderCardHelp(COMMAND_SURFACE);
export const COMMANDS = projectCliCommands(COMMAND_SURFACE);
export const NEEDS_TARGET = new Set(
  COMMANDS
    .filter(command => command.needsTarget)
    .flatMap(command => [command.name, ...command.aliases])
);
// Commands that can run `fill --secret NAME`, directly or as a step.
export const SECRET_FILL_COMMANDS = new Set(['fill', 'batch', 'flow', 'repeat', 'record', 'replay']);
export const TYPE_SECRET_UNSUPPORTED = 'type: --secret is supported by fill only; use fill <target> <selector|@ref> --secret NAME';
// #637: Next is only the command. Kind stays on its own line. A consent gate is
// `Ask a human first` on its own line, never a suffix of the command.

// Lines printed after a failure's own Next: line that do not replace it: a composite command's halt
// summary (flow, repeat, replay), and the receipts a failed action appends (#460 answered dialogs,
// #472 saved download or the download-behaviour warning).
export const HALT_TRAILER_RE = /^(?:(?:Flow|Replay) halted at |Repeat halted at iteration |Done: \d+ ok, \d+ failed(?:, \d+ skipped)?$|Dialog: |Downloaded "|Warning: could not set the browser's download behaviour )/;
// A step header that starts a failed step's block: `[2/3] …`, `[env 1/2] …`.
export const STEP_HEADER_RE = /^\[(?:env )?\d+\/\d+\]/;
// `open` always creates a blank tab, then navigates only after the tab daemon is attached.
// The created URL is the signal for whether that navigation has already been requested (#644).
export const OPEN_CREATED_TARGET_URL = 'about:blank';

// Kinds printed on a CLI or action failure. Both classifiers return only these.
// A page exception is the page's own error. It is not tool usage.
export const ERROR_KINDS = Object.freeze([
  'assertion',
  'browser-cdp',
  'click-no-change',
  'covered',
  'daemon-disconnect',
  'dialog-open',
  'disabled',
  'dom-rewrite',
  'download-canceled',
  'download-missing',
  'download-save-failed',
  'download-unsupported',
  'drag-incomplete',
  'drag-not-started',
  'eval',
  'fd-limit',
  'fill-no-change',
  'fill-value-mismatch',
  'hidden-tab',
  'hover-not-delivered',
  'invalid-selector',
  'loading',
  'misdirected',
  'native-dialog',
  'navigation',
  'navigation-cancelled',
  'no-click-box',
  'no-input-events',
  'no-navigation',
  'not-fillable',
  'not-in-viewport',
  'not-scrollable',
  'opener-blocked',
  'overlay',
  'page-exception',
  'pdf-viewer',
  'policy',
  'popup-uncommitted',
  'press-not-delivered',
  'profile-in-use',
  'runtime-dir',
  'screenshot-capture',
  'selector',
  'stale-daemon',
  'stale-ref',
  'target-closed',
  'target-resolution',
  'timeout',
  'unknown',
  'usage',
  'wrong-frame',
]);
const ERROR_KIND_SET = new Set(ERROR_KINDS);

export function sealErrorRecovery(recovery) {
  const kind = recovery?.kind;
  if (!ERROR_KIND_SET.has(kind)) throw new Error(`unlisted error kind: ${kind}`);
  return recovery;
}

// Failures whose Kind is decided by where they were raised, not by page prose.
// Returns null when a later specialist (a dismissed navigation, a selector miss) owns it.
export function sourceFailureRecovery(err, message, target = '<target>') {
  const text = String(message ?? '').trim();
  const where = String(target || '<target>');
  if (err?.pageException === true) {
    return {
      kind: 'page-exception',
      next: `cdp console ${where}`,
      strategy: 'read-page-exception',
      reason: 'The page script threw. The tab is still live. Read the exception; the message is the page\'s, not a command-usage error.',
    };
  }
  if (err?.navigationCancelled) return null;
  if (err?.navigationFailure === true || /^net::ERR_[A-Z0-9_]+$/.test(text)) {
    return {
      kind: 'navigation',
      next: `cdp status ${where}`,
      strategy: 'check-current-page',
      reason: 'Chrome reported a network error (net::ERR_*). The navigation did not finish. Check the tab before retrying with a reachable URL.',
    };
  }
  if (err?.unknownFrame === true || /^unknown frame\b/i.test(text)) {
    return {
      kind: 'wrong-frame',
      next: `cdp frame ${where}`,
      strategy: 'list-frames',
      reason: 'That @fN ref is not in the current frame tree. List frames, then perceive a listed frame.',
    };
  }
  if (/^direction required\b/i.test(text)) {
    return {
      kind: 'usage',
      next: 'cdp help scroll',
      strategy: 'show-help',
      reason: 'scroll needs a direction: down, up, left, right, x,y, or to top / to bottom.',
    };
  }
  return null;
}
