// `click --expect-download` (#472): capture the file a click downloads.
// Browser.setDownloadBehavior is a browser-context setting on the user's real browser, so it is
// opt-in per click and always set back to `default` afterwards, on success, failure and timeout.
// CDP cannot read the previous behaviour, so `default` (the browser's own download handling) is
// what gets restored. Chrome also drops the override when the connection that set it closes, so a
// daemon that exits or crashes mid-wait does not leave it behind. With `allowAndName` Chrome saves
// the file as <dir>/<guid>; it is renamed to a sanitised form of the suggested name that never
// overwrites an existing file.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { redactUrl } from './redaction.mjs';

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// ext4 and APFS allow 255 UTF-8 bytes per name; 200 leaves room for a " (999)" collision suffix.
const MAX_FILENAME_BYTES = 200;
const MAX_EXTENSION_BYTES = 20;
const MAX_URL_CHARS = 300;
const FILE_APPEAR_WAIT_MS = 2000;
// clickStr / jsClickStr: `Click on <A href="…"> did not navigate. Try jsclick or click --js.`
const LINK_DID_NOT_NAVIGATE_RE = /did not navigate/i;

export function clickDownloadError(kind, message, details = {}) {
  const error = new Error(`click --expect-download: ${message}`);
  error.download = { kind, ...details };
  return error;
}

// Flags for `click`. Returns the remaining tokens and `download` (null without --expect-download).
export function parseExpectDownloadArgs(tokens = []) {
  const rest = [];
  let expect = false;
  let dir = null;
  let timeoutMs = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--expect-download') {
      expect = true;
    } else if (token === '--out') {
      const value = tokens[++i];
      if (value == null || value === '' || String(value).startsWith('--')) {
        throw new Error('click: --out needs a folder path');
      }
      dir = String(value);
    } else if (token === '--timeout') {
      const raw = tokens[++i];
      const ms = Number(raw);
      if (!/^\d+$/.test(String(raw ?? '')) || !Number.isSafeInteger(ms) || ms < 1 || ms > MAX_DOWNLOAD_TIMEOUT_MS) {
        throw new Error(`click: --timeout needs milliseconds from 1 to ${MAX_DOWNLOAD_TIMEOUT_MS}`);
      }
      timeoutMs = ms;
    } else {
      rest.push(token);
    }
  }
  if (!expect && (dir != null || timeoutMs != null)) {
    throw new Error('click: --out and --timeout only apply with --expect-download');
  }
  return {
    args: rest,
    download: expect ? { dir, timeoutMs: timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS } : null,
  };
}

// The daemon may run in another working directory, so the CLI sends --out as an absolute path.
export function absolutizeExpectDownloadOut(args = [], cwd = process.cwd()) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === '--out' && out[i + 1] && !String(out[i + 1]).startsWith('--') && !isAbsolute(String(out[i + 1]))) {
      out[i + 1] = resolve(cwd, String(out[i + 1]));
    }
  }
  return out;
}

// IPC budget for a click that waits for a download: the wait plus room for the click itself.
export function expectDownloadIpcTimeoutMs(args = []) {
  try {
    const { download } = parseExpectDownloadArgs(args.filter(arg => typeof arg === 'string'));
    return download ? download.timeoutMs + 60_000 : null;
  } catch {
    return null;
  }
}

// Device names Windows reserves, with or without an extension (`CON.txt`, `CON .txt`); older
// Windows also reserves COM¹-³ / LPT¹-³ and CONIN$ / CONOUT$.
const RESERVED_WINDOWS_STEM_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;
// Control characters, characters Windows refuses in names, and bidi overrides that can disguise an extension.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS_RE = /[\u0000-\u001f\u007f<>:"|?*‪-‮⁦-⁩]/g;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, cut on a code-point boundary.
function truncateUtf8(text, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

// A file name that stays inside the download folder: no separators, no `..`, no reserved device
// names, and at most MAX_FILENAME_BYTES UTF-8 bytes (extension kept when it is short).
export function safeDownloadFilename(value, fallback = 'download') {
  let name = String(value ?? '').split(/[\\/]/).pop() || '';
  name = name.replace(LONE_SURROGATE_RE, '_').replace(UNSAFE_FILENAME_CHARS_RE, '_').trim().replace(/[. ]+$/, '');
  if (!name || /^\.+$/.test(name)) name = fallback;
  const stem = name.split('.')[0].replace(/[ .]+$/, '');
  if (RESERVED_WINDOWS_STEM_RE.test(stem)) name = `_${name}`;
  if (Buffer.byteLength(name) > MAX_FILENAME_BYTES) {
    let ext = extname(name);
    if (Buffer.byteLength(ext) > MAX_EXTENSION_BYTES || ext === name) ext = '';
    const head = truncateUtf8(name.slice(0, name.length - ext.length), MAX_FILENAME_BYTES - Buffer.byteLength(ext))
      .replace(/[. ]+$/, '');
    name = `${head || fallback}${ext}`;
  }
  return name;
}

function numberedFilename(name, n) {
  if (n === 0) return name;
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext && ext !== name ? ext : ''}`;
}

// Reserve a free name with an exclusive create, so a concurrent writer cannot take it between check and rename.
async function reserveDownloadPath(dir, name, { openFile = open } = {}) {
  for (let n = 0; n < 1000; n++) {
    const path = join(dir, numberedFilename(name, n));
    try {
      const handle = await openFile(path, 'wx');
      await handle.close();
      return path;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const error = new Error(`no free file name for "${name}"`);
  error.code = 'ENAMESEXHAUSTED';
  throw error;
}

// Move <dir>/<guid> to a reserved name and make it owner-only. A name the file system refuses
// (ENAMETOOLONG, EINVAL) falls back to `download<ext>` once.
async function saveDownloadedFile(folder, filename, source, { fs = {} } = {}) {
  const { renameFile = rename, chmodFile = chmod, removeFile = rm, openFile = open } = fs;
  let path;
  try {
    path = await reserveDownloadPath(folder, filename, { openFile });
  } catch (error) {
    const fallback = safeDownloadFilename(`download${extname(filename)}`);
    if (error?.code === 'ENAMESEXHAUSTED' || fallback === filename) throw error;
    path = await reserveDownloadPath(folder, fallback, { openFile });
  }
  try {
    await renameFile(source, path);
  } catch (error) {
    await removeFile(path, { force: true }).catch(() => {});
    throw error;
  }
  // Chrome writes with the process umask; downloads can hold private data (#472 review).
  await chmodFile(path, 0o600).catch(() => {});
  return path;
}

export function compactDownloadUrl(url) {
  const value = String(url ?? '');
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    return comma < 0 ? 'data:(invalid)' : `${value.slice(0, Math.min(comma, 80) + 1)}(${value.length - comma - 1} chars)`;
  }
  const redacted = redactUrl(value);
  return redacted.length > MAX_URL_CHARS ? `${redacted.slice(0, MAX_URL_CHARS - 1)}…` : redacted;
}

export function formatDownloadBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// Text receipt lines for effects.download: the saved file when the download completed, and on any
// path a warning when the browser's download behaviour could not be set back to default.
export function downloadReceiptLines(download) {
  if (!download || typeof download !== 'object') return [];
  const lines = download.state === 'completed'
    ? [`Downloaded "${download.filename}" ${formatDownloadBytes(download.bytes)} sha256=${download.sha256} → ${download.path}`]
    : [];
  if (download.behavior && download.behavior.restored === false) {
    lines.push(`Warning: could not set the browser's download behaviour back to default (${download.behavior.restoreError || 'unknown error'}); downloads may keep going to ${download.dir || 'the capture folder'} without a prompt until this tab's daemon disconnects (\`cdp stop <target>\`).`);
  }
  return lines;
}

export function downloadOutcomeReason(download) {
  return `Downloaded "${download.filename}" (${formatDownloadBytes(download.bytes)}).`;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return { bytes, sha256: hash.digest('hex') };
}

async function waitForFile(path, waitMs, sleep) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const info = await stat(path);
      if (info.isFile()) return true;
    } catch {}
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

// Chrome sends Browser.downloadWillBegin for every download in the browser to every client that
// enabled events, whatever context the behaviour was scoped to. Only a download whose frameId is
// one of this tab's frames is the click's. `frameIds()` returns the tab's frame ids (null when
// unknown: then every download counts); it is asked again for a frame it has not seen, since the
// click may have added an iframe.
function createOwnFrameCheck(frameIds) {
  let known = null;
  return async (frameId) => {
    if (typeof frameIds !== 'function' || !frameId) return true;
    if (known?.has(frameId)) return true;
    let ids = null;
    try { ids = await frameIds(); } catch {}
    if (!Array.isArray(ids)) return known === null;
    known = new Set(ids);
    return known.has(frameId);
  };
}

// Collects Browser.downloadWillBegin / downloadProgress from the moment it is created.
function watchDownloadEvents(onEvent, isOwnFrame = async () => true) {
  const begun = [];
  const own = new Map();
  const progress = new Map();
  let wake = null;
  const notify = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };
  const offs = [
    onEvent('Browser.downloadWillBegin', (params = {}) => {
      if (params.guid) begun.push(params);
      notify();
    }),
    onEvent('Browser.downloadProgress', (params = {}) => {
      if (!params.guid) return;
      const previous = progress.get(params.guid);
      // completed / canceled are final; a late inProgress event must not undo them.
      if (previous && (previous.state === 'completed' || previous.state === 'canceled')) return;
      progress.set(params.guid, params);
      notify();
    }),
  ];
  async function firstOwnBegin() {
    for (const begin of begun) {
      if (!own.has(begin.guid)) own.set(begin.guid, await isOwnFrame(begin.frameId));
      if (own.get(begin.guid)) return begin;
    }
    return null;
  }
  return {
    async wait(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const begin = await firstOwnBegin();
        const latest = begin ? progress.get(begin.guid) || null : null;
        if (latest && (latest.state === 'completed' || latest.state === 'canceled')) return { begin, progress: latest };
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return { begin, progress: latest, timedOut: true, foreign: begun.filter(b => own.get(b.guid) === false).length };
        }
        await new Promise((resolvePromise) => {
          const timer = setTimeout(() => {
            wake = null;
            resolvePromise();
          }, remaining);
          wake = () => {
            clearTimeout(timer);
            resolvePromise();
          };
        });
      }
    },
    stop() {
      for (const off of offs) {
        try { off?.(); } catch {}
      }
    },
  };
}

async function enableDownloadCapture(browser, dir) {
  let contextId = null;
  try {
    contextId = (await browser.browserContextId()) || null;
  } catch {}
  const params = { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true };
  if (contextId) {
    try {
      await browser.setDownloadBehavior({ ...params, browserContextId: contextId });
      return { browserContextId: contextId, scope: 'target-context' };
    } catch {
      // If Chrome refuses the tab's context id, the call without an id sets the default context.
    }
  }
  try {
    await browser.setDownloadBehavior(params);
  } catch (error) {
    throw clickDownloadError(
      'unsupported',
      `this browser does not allow download capture (Browser.setDownloadBehavior: ${error?.message || error}). Nothing was clicked.`,
    );
  }
  return { browserContextId: null, scope: 'default-context' };
}

async function restoreDownloadBehavior(browser, scope) {
  const params = { behavior: 'default', eventsEnabled: false };
  if (scope.browserContextId) params.browserContextId = scope.browserContextId;
  try {
    await browser.setDownloadBehavior(params);
    return { scope: scope.scope, restored: true };
  } catch (error) {
    return { scope: scope.scope, restored: false, restoreError: String(error?.message || error).slice(0, 200) };
  }
}

function progressDetails(progress) {
  if (!progress) return {};
  const details = {};
  if (Number.isFinite(progress.receivedBytes)) details.receivedBytes = progress.receivedBytes;
  if (Number.isFinite(progress.totalBytes) && progress.totalBytes > 0) details.totalBytes = progress.totalBytes;
  return details;
}

/**
 * Run `run()` (the click) with download capture on, then wait for the first download this tab starts.
 * `browser` = { setDownloadBehavior(params), browserContextId(), frameIds(), cancelDownload(params),
 * onEvent(method, handler) → off }. `effects` receives `download` on every path that got past enabling
 * capture. Resolves to run()'s text.
 */
export async function captureClickDownload({
  browser,
  dir,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  run,
  effects = {},
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  fileAppearWaitMs = FILE_APPEAR_WAIT_MS,
  fs = {},
}) {
  const folder = resolve(String(dir || ''));
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw clickDownloadError('usage', `cannot create the download folder ${folder}: ${error?.code || error?.message}`);
  }
  const events = watchDownloadEvents(browser.onEvent, createOwnFrameCheck(browser.frameIds));
  let scope = null;
  try {
    scope = await enableDownloadCapture(browser, folder);
    let dispatchText;
    let clickError = null;
    try {
      dispatchText = await run();
    } catch (error) {
      // A link whose response is an attachment never navigates, so the click path reports
      // `did not navigate`. With a download expected, a download from this tab is the success path.
      // Any other click error (selector miss, covered, disabled) means nothing was clicked.
      if (!LINK_DID_NOT_NAVIGATE_RE.test(String(error?.message || ''))) throw error;
      clickError = error;
      const link = String(error?.message || '').match(/Click on (<[^>]*>)/)?.[1] || 'the link';
      dispatchText = `Clicked ${link}; it started a download instead of navigating`;
    }
    const seen = await events.wait(timeoutMs);
    // The link neither navigated nor downloaded: the original click failure is the answer.
    if (clickError && !seen.begin) throw clickError;
    const begin = seen.begin;
    const filename = begin ? safeDownloadFilename(begin.suggestedFilename) : null;
    const base = begin
      ? { suggestedFilename: String(begin.suggestedFilename || ''), url: compactDownloadUrl(begin.url), dir: folder }
      : { dir: folder };
    if (seen.timedOut) {
      if (!begin) {
        effects.download = { state: 'not-started', timeoutMs, ...(seen.foreign ? { otherTabDownloads: seen.foreign } : {}), ...base };
        const other = seen.foreign ? ` (${seen.foreign} download${seen.foreign === 1 ? '' : 's'} from other tabs ignored)` : '';
        throw clickDownloadError('timeout', `no download started within ${timeoutMs} ms of the click${other}`, { phase: 'begin', timeoutMs });
      }
      // A download still running after the wait is cancelled, so it does not finish later as a stray <guid> file.
      let cancelled = false;
      try {
        await browser.cancelDownload({ guid: begin.guid, ...(scope.browserContextId ? { browserContextId: scope.browserContextId } : {}) });
        cancelled = true;
      } catch {}
      const sizes = progressDetails(seen.progress);
      effects.download = { state: 'timeout', filename, timeoutMs, cancelled, ...sizes, ...base };
      const received = sizes.receivedBytes != null
        ? ` (${formatDownloadBytes(sizes.receivedBytes)}${sizes.totalBytes ? ` of ${formatDownloadBytes(sizes.totalBytes)}` : ''} received)`
        : '';
      throw clickDownloadError('timeout', `download "${filename}" did not finish within ${timeoutMs} ms${received}${cancelled ? '; it was cancelled' : ''}`, { phase: 'progress', timeoutMs });
    }
    if (seen.progress.state === 'canceled') {
      effects.download = { state: 'canceled', filename, ...progressDetails(seen.progress), ...base };
      throw clickDownloadError('canceled', `the browser canceled the download "${filename}"`);
    }
    const source = join(folder, begin.guid);
    if (!(await waitForFile(source, fileAppearWaitMs, sleep))) {
      effects.download = { state: 'missing', filename, ...base };
      throw clickDownloadError('missing', `the browser reported "${filename}" complete, but ${source} does not exist`);
    }
    let path;
    try {
      path = await saveDownloadedFile(folder, filename, source, { fs });
    } catch (error) {
      // The raw <guid> file has no usable name and would sit in the folder unnoticed: remove it.
      await (fs.removeFile || rm)(source, { force: true }).catch(() => {});
      effects.download = { state: 'save-failed', filename, ...base };
      throw clickDownloadError('save-failed', `could not save "${filename}" in ${folder} (${error?.code || error?.message}); the downloaded data was removed`, { code: error?.code || null });
    }
    const { bytes, sha256 } = await hashFile(path);
    const savedAs = basename(path);
    effects.download = {
      state: 'completed',
      filename: savedAs,
      ...(savedAs !== base.suggestedFilename ? { suggestedFilename: base.suggestedFilename } : {}),
      bytes,
      sha256,
      path,
      url: base.url,
      dir: folder,
    };
    return dispatchText;
  } finally {
    events.stop();
    if (scope) {
      const behavior = await restoreDownloadBehavior(browser, scope);
      if (effects.download) effects.download.behavior = behavior;
      else effects.download = { state: 'not-observed', dir: folder, behavior };
    }
  }
}
