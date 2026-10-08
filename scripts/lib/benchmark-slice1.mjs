// Scoring and board rendering for the slice1 benchmark. No browser I/O.

import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, sep } from 'node:path';

export const VIEWPORT = Object.freeze({ width: 1042, height: 632 });
export const DENSE_CONTROL_COUNT = 40;
export const CONTROL_NAMES = Object.freeze(
  Array.from({ length: DENSE_CONTROL_COUNT }, (_, index) => `Control ${String(index + 1).padStart(2, '0')}`),
);
export const TOKEN_ESTIMATOR = 'chars/4';
export const SUBJECT_TOOL = 'chrome-cdp-ex';
export const SLICE1_TOOLS = Object.freeze(['chrome-cdp-ex', '@playwright/cli', 'chrome-devtools-mcp']);
export const STALE_REF_JOB = 'stale-ref-recover-act';
export const OFFSET_PRESENT_MS = 250;
export const OFFSET_ABSENT_MS = 150;
const BROWSER_GUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;

export const JOBS = Object.freeze([
  { id: 'overlay-honesty', task: 1, title: 'Overlay honesty' },
  { id: 'covered-click', task: 2, title: 'Fail-closed covered click' },
  { id: 'perceive-snapshot-size', task: 3, title: 'Perceive / snapshot size' },
  { id: 'stale-ref-recover-act', task: 4, title: 'Stale-ref, recover, act' },
  { id: 'attach-keeps-session', task: 5, title: 'Attach keeps the existing session' },
]);

export function unicodeLength(text) {
  return Array.from(String(text ?? '')).length;
}

export function estimateTokens(chars) {
  const count = Number(chars);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.ceil(count / 4);
}

export function combineOutput(stdout, stderr) {
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  if (!out) return err;
  if (!err) return out;
  return `${out}\n${err}`;
}

export function median(values) {
  const nums = values.map(Number).filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function mentionsDialog(text) {
  return /dialog|overlay|blocking|SLICE1_DIALOG_BODY|Slice1 consent/i.test(text);
}

export function scoreOverlayHonesty({ output, groundTruth }) {
  const text = String(output ?? '');
  if (groundTruth?.coversViewport !== true) {
    return { pass: false, notes: 'invalid run: overlay did not cover the viewport after the tool returned' };
  }
  const saysBlocking = /Overlay detector:\s*blocking\b/i.test(text);
  const saysClear = /Overlay detector:\s*clear\b/i.test(text) || /No visible blocking overlays/i.test(text);
  if (saysClear && !saysBlocking) {
    return { pass: false, notes: 'tool reported a clear page while the dialog still covered the viewport' };
  }
  if (!mentionsDialog(text)) {
    return { pass: false, notes: 'tool output omitted the dialog while it still covered the viewport' };
  }
  return { pass: true, notes: 'dialog still covered the viewport and the tool reported it' };
}

export function scoreCoveredClick({ output, groundTruth }) {
  const status = groundTruth?.status;
  if (status === 'landed:submit') {
    return { pass: false, notes: 'covered button handler ran (landed:submit)' };
  }
  if (status === 'landed:cover') {
    return { pass: false, notes: 'click landed on the cover (landed:cover)' };
  }
  if (status !== 'landed:none') {
    return { pass: false, notes: `unexpected click status ${status ?? 'missing'}` };
  }
  const refused = /Kind:\s*covered|is covered by|intercepts pointer events|Timeout\b|not clickable|click was not sent/i.test(String(output ?? ''));
  if (!refused) {
    return { pass: false, notes: 'handlers did not run, but the tool did not report a covered or intercepted click' };
  }
  return { pass: true, notes: 'button and cover handlers did not run; tool refused the covered click' };
}

export function scoreDenseObservation({ output, names = CONTROL_NAMES }) {
  const text = String(output ?? '');
  const missing = names.filter(name => !text.includes(name));
  if (missing.length) {
    const sample = missing.slice(0, 6).join(', ');
    return { pass: false, notes: `missing ${missing.length} of ${names.length} controls (${sample})` };
  }
  return { pass: true, notes: `listed all ${names.length} controls` };
}

export function scoreStaleRecovery({ groundTruth }) {
  const status = groundTruth?.status;
  if (status === 'saved:fresh') {
    return { pass: true, notes: 'post-rewrite control reached saved:fresh' };
  }
  if (status === 'saved:stale') {
    return { pass: false, notes: 'action hit the pre-rewrite control (saved:stale)' };
  }
  return { pass: false, notes: `fresh control was not activated (status ${status ?? 'missing'})` };
}

export function scoreAttachSession({ output, browserUnchanged }) {
  const text = String(output ?? '');
  if (browserUnchanged === false) {
    return { pass: false, notes: 'browser websocket id changed; the tool did not keep the existing Chrome' };
  }
  return cookieVisible(text);
}

function cookieVisible(text) {
  if (text.includes('slice1_session') && text.includes('already-set')) {
    return { pass: true, notes: 'existing Chrome stayed up and slice1_session=already-set was visible' };
  }
  return { pass: false, notes: 'slice1_session=already-set was not in the tool output' };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractChromeCdpListPrefix(output, origin) {
  const line = String(output ?? '').split(/\r?\n/).find(entry => entry.includes(origin));
  const match = line?.match(/^([A-Fa-f0-9]{4,})\b/);
  return match ? match[1] : null;
}

export function staleClickNote(output) {
  const text = String(output ?? '');
  const parts = [];
  if (/Kind:\s*stale-ref|Unknown ref|Refs were invalidated|not found in the current page snapshot|did not become interactive/i.test(text)) {
    parts.push('first click rejected the stale ref');
  }
  if (/Next:.*perceive/i.test(text)) parts.push('Next included perceive');
  return parts.join('; ');
}

export function extractChromeCdpRef(output, label) {
  const line = String(output ?? '').split(/\r?\n/).find(entry => entry.includes(label) && /@\d+/.test(entry));
  const match = line?.match(/@(\d+)/);
  return match ? `@${match[1]}` : null;
}

export function extractPlaywrightRef(output, label) {
  const match = String(output ?? '').match(new RegExp(`button "${escapeRegExp(label)}" \\[ref=([^\\]]+)\\]`));
  return match ? match[1] : null;
}

export function extractDevtoolsUid(output, label) {
  const match = String(output ?? '').match(new RegExp(`uid=(\\S+) button "${escapeRegExp(label)}"`));
  return match ? match[1] : null;
}

export function extractDevtoolsPageId(output) {
  const match = String(output ?? '').match(/^\s*(\d+): .+$/m);
  return match ? match[1] : null;
}

export function summarizeTool(runs) {
  const passCount = runs.filter(run => run.pass).length;
  return {
    pass: runs.length > 0 && passCount === runs.length,
    steps: median(runs.map(run => run.steps)),
    wallMs: median(runs.map(run => run.wallMs)),
    agentChars: median(runs.map(run => run.agentChars)),
    notes: `${passCount}/${runs.length} runs passed`,
  };
}

export function findLosses(rows, subject = SUBJECT_TOOL) {
  const losses = [];
  const jobIds = [];
  for (const row of rows) {
    if (!jobIds.includes(row.jobId)) jobIds.push(row.jobId);
  }
  for (const jobId of jobIds) {
    const ours = rows.find(row => row.jobId === jobId && row.tool === subject);
    if (!ours) continue;
    if (!ours.pass) losses.push({ jobId, kind: 'fail', tool: subject });
    for (const peer of rows.filter(row => row.jobId === jobId && row.tool !== subject)) {
      if (ours.wallMs > peer.wallMs) {
        losses.push({ jobId, kind: 'slower', tool: subject, peer: peer.tool, ours: ours.wallMs, theirs: peer.wallMs, peerPass: peer.pass });
      }
      if (ours.agentChars > peer.agentChars) {
        losses.push({ jobId, kind: 'more-output', tool: subject, peer: peer.tool, ours: ours.agentChars, theirs: peer.agentChars, peerPass: peer.pass });
      }
      if (ours.steps > peer.steps) {
        losses.push({ jobId, kind: 'more-steps', tool: subject, peer: peer.tool, ours: ours.steps, theirs: peer.steps, peerPass: peer.pass });
      }
    }
  }
  return losses;
}

function cell(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function nodeExecutable(executable) {
  if (executable === process.execPath) return true;
  const base = basename(String(executable)).toLowerCase();
  return base === 'node' || base === 'node.exe';
}

function portablePath(root, value) {
  const text = String(value);
  if (!isAbsolute(text)) return text.replaceAll('\\', '/');
  const rel = relative(root, text);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return basename(text);
  return rel.split(sep).join('/');
}

function redactLocalUrlPorts(value) {
  return redactBenchmarkText(value);
}

export function hashBrowserId(id) {
  return createHash('sha256').update(String(id).toLowerCase()).digest('hex').slice(0, 12);
}

export function redactBenchmarkText(text) {
  return String(text)
    .replace(/--remote-debugging-port=\d+\b/g, '--remote-debugging-port=<port>')
    .replace(/--user-data-dir=(?!<tmp-profile>)\S+/g, '--user-data-dir=<tmp-profile>')
    .replace(/(ws|wss|https?):\/\/(127\.0\.0\.1|localhost):\d+\b/g, '$1://$2:<port>')
    .replace(/(?<![:/\w])(127\.0\.0\.1|localhost):\d+\b/g, '$1:<port>')
    .replace(new RegExp(`/devtools/browser/(${BROWSER_GUID})\\b`, 'g'), (_, id) => `/devtools/browser/${hashBrowserId(id)}`);
}

export function redactBenchmarkTree(value) {
  if (typeof value === 'string') return redactBenchmarkText(value);
  if (Array.isArray(value)) return value.map(item => redactBenchmarkTree(item));
  if (value && typeof value === 'object') {
    const redacted = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'chromeBinary' && typeof item === 'string') redacted[key] = basename(item);
      else redacted[key] = redactBenchmarkTree(item);
    }
    return redacted;
  }
  return value;
}

const ABSOLUTE_PATH_SOURCE = String.raw`(?:^|[\s"'=])(?:\/(?:tmp|opt|home|usr|var|workspace|exec-daemon|root|etc|proc|sys|dev|run|private|Users)(?:\/[^\s"'\\]*)?|\/[A-Za-z0-9._@+-]+\/[A-Za-z0-9._@+-][^\s"'\\]*|[A-Za-z]:[\\/][^\s"'\\]*)`;

const DOCUMENT_LEAKS = [
  { kind: 'temp-dir', source: String.raw`\/tmp(?:\/[^\s"'\\]*)?|slice1-(?:chrome|xdg|work)-[A-Za-z0-9._-]+` },
  { kind: 'absolute-path', source: ABSOLUTE_PATH_SOURCE },
  { kind: 'port', source: String.raw`--remote-debugging-port=\d+\b|(?:127\.0\.0\.1|localhost):\d+\b` },
  { kind: 'browser-id', source: `/devtools/browser/${BROWSER_GUID}\\b` },
];

export function portableDocumentLeaks(text) {
  const value = String(text);
  const leaks = [];
  for (const pattern of DOCUMENT_LEAKS) {
    const re = new RegExp(pattern.source, 'g');
    let match = re.exec(value);
    while (match) {
      const at = match.index;
      leaks.push({
        kind: pattern.kind,
        text: value.slice(Math.max(0, at - 40), at + match[0].length + 40).replace(/\s+/g, ' '),
      });
      if (leaks.length >= 20) return leaks;
      match = re.exec(value);
    }
  }
  return leaks;
}

export function assertPortableBenchmarkJson(text) {
  const leaks = portableDocumentLeaks(text);
  if (!leaks.length) return;
  const sample = leaks.map(leak => `${leak.kind}: ${leak.text}`).join('\n');
  throw new Error(`slice1 benchmark JSON leaked machine-local data (${leaks.length}):\n${sample}`);
}

export function loadIsIdle(oneMinute, nproc) {
  return Number(oneMinute) < Number(nproc);
}

export function formatLoadSample(sample) {
  if (!sample) return '';
  return `${sample.one}/${sample.five}/${sample.fifteen}`;
}

export function recordedCommand(root, executable, args) {
  const head = nodeExecutable(executable) ? 'node' : portablePath(root, executable);
  const shown = args.map(arg => {
    const text = String(arg);
    const eq = text.indexOf('=');
    if (eq !== -1) {
      const key = text.slice(0, eq + 1);
      const value = text.slice(eq + 1);
      if (isAbsolute(value)) return redactLocalUrlPorts(key + portablePath(root, value));
    }
    if (isAbsolute(text)) return portablePath(root, text);
    return redactLocalUrlPorts(text);
  });
  return [head, ...shown].join(' ');
}

export function recordedChromeArgs(args) {
  return args.map(arg => {
    const text = String(arg);
    if (text.startsWith('--user-data-dir=')) return '--user-data-dir=<tmp-profile>';
    if (text.startsWith('--remote-debugging-port=')) return '--remote-debugging-port=<port>';
    return redactLocalUrlPorts(text);
  });
}

export function machineLocalLeak(text) {
  const value = String(text);
  if (/(?:^|[\s"'=])\/tmp(?:\/|$)/.test(value) || /slice1-(?:chrome|xdg|work)-/.test(value)) return 'temp-dir';
  if (new RegExp(ABSOLUTE_PATH_SOURCE).test(value)) return 'absolute-path';
  if (/(?:--remote-debugging-port=|(?:127\.0\.0\.1|localhost):)\d+\b/.test(value)) return 'port';
  if (new RegExp(`/devtools/browser/${BROWSER_GUID}\\b`).test(value)) return 'browser-id';
  return '';
}

export function portableSurfaceLeaks(texts) {
  const leaks = [];
  for (const text of texts) {
    const kind = machineLocalLeak(text);
    if (kind) leaks.push({ kind, text });
  }
  return leaks;
}

export function recordedSurface(report) {
  const surface = [];
  const add = value => {
    if (typeof value === 'string' && value) surface.push(value);
  };
  for (const arg of report?.environment?.chromeArgs || []) add(arg);
  const entries = [...(report?.warmup || []), ...(report?.discardedWarmup || [])];
  for (const entry of entries) {
    add(entry?.command);
    for (const command of entry?.commands || []) add(typeof command === 'string' ? command : command?.command);
  }
  for (const run of report?.runs || []) {
    for (const command of run?.commands || []) add(command?.command);
  }
  return surface;
}

export function chromeSandboxMode({ uid = null, euid = null, envFlag = '' } = {}) {
  if (uid === 0 || euid === 0) return { noSandbox: true, reason: 'root' };
  if (/^(1|true|yes|on)$/i.test(String(envFlag))) return { noSandbox: true, reason: 'SLICE1_NO_SANDBOX' };
  return { noSandbox: false, reason: '' };
}

export function coveredClickTimingNote(tool, samples) {
  if (tool !== '@playwright/cli') return '';
  const output = (samples || []).flatMap(sample => (sample.commands || []).map(command => command.output || '')).join('\n');
  if (!/Timeout 5000ms/.test(output)) return '';
  return 'wallMs is mostly the 5000ms Playwright actionability timeout';
}

export function sandboxLine(environment = {}) {
  if (!environment.noSandbox) return 'Sandbox: Chrome was launched with its default sandbox.';
  if (environment.noSandboxReason === 'root') {
    return 'Sandbox: Chrome was launched with --no-sandbox because the process is running as root.';
  }
  if (environment.noSandboxReason === 'SLICE1_NO_SANDBOX') {
    return 'Sandbox: Chrome was launched with --no-sandbox because SLICE1_NO_SANDBOX is set.';
  }
  return 'Sandbox: Chrome was launched with --no-sandbox.';
}

export function firstCommandTiming(runs, jobId, tool) {
  const first = [];
  const later = [];
  for (const run of runs || []) {
    if (run?.jobId !== jobId || run?.tool !== tool || run?.discarded === true) continue;
    const commands = Array.isArray(run.commands) ? run.commands : [];
    const head = commands[0];
    if (!head || typeof head === 'string' || !Number.isFinite(head.wallMs)) continue;
    first.push(head.wallMs);
    for (const command of commands.slice(1)) {
      if (command && typeof command !== 'string' && Number.isFinite(command.wallMs)) later.push(command.wallMs);
    }
  }
  const firstMs = median(first);
  const laterMs = median(later);
  return {
    jobId,
    tool,
    firstMs,
    laterMs,
    offsetMs: firstMs === null || laterMs === null ? null : firstMs - laterMs,
    samples: first.length,
  };
}

export function firstCommandRows(runs) {
  const jobs = [];
  const tools = [];
  for (const run of runs || []) {
    if (run?.jobId && !jobs.includes(run.jobId)) jobs.push(run.jobId);
    if (run?.tool && !tools.includes(run.tool)) tools.push(run.tool);
  }
  return jobs.flatMap(jobId => tools.map(tool => firstCommandTiming(runs, jobId, tool)));
}

export function classifyFirstCommand(baseline, comparison, thresholds = {}) {
  const presentMs = thresholds.presentMs ?? OFFSET_PRESENT_MS;
  const absentMs = thresholds.absentMs ?? OFFSET_ABSENT_MS;
  if (
    baseline?.offsetMs === null
    || baseline?.offsetMs === undefined
    || comparison?.offsetMs === null
    || comparison?.offsetMs === undefined
    || baseline?.laterMs === null
    || baseline?.laterMs === undefined
    || comparison?.firstMs === null
    || comparison?.firstMs === undefined
  ) return 'missing';
  const shows = baseline.offsetMs >= presentMs;
  const still = comparison.offsetMs >= presentMs;
  const gone = comparison.offsetMs <= absentMs;
  const firstNearLater = Math.abs(comparison.firstMs - baseline.laterMs) <= absentMs;
  if (shows && (gone || firstNearLater)) return 'explained';
  if (shows && still) return 'persists';
  if (!shows) return 'absent';
  return 'unclear';
}

function timingNumbers(row) {
  return `${row.tool}: default first ${row.default.firstMs}ms, later ${row.default.laterMs}ms, offset ${row.default.offsetMs}ms; no-sandbox first ${row.noSandbox.firstMs}ms, later ${row.noSandbox.laterMs}ms, offset ${row.noSandbox.offsetMs}ms`;
}

export function sandboxAbConclusionText(conclusion) {
  const numbers = (conclusion.perTool || []).map(timingNumbers).join('. ');
  const presentMs = conclusion.thresholds.presentMs;
  const absentMs = conclusion.thresholds.absentMs;
  const jobId = conclusion.jobId;
  if (conclusion.verdict === 'sandbox-explains') {
    return `On ${jobId}, the default-sandbox arm shows a first-command offset of at least ${presentMs}ms for every tool, and the no-sandbox arm reduces that offset to at most ${absentMs}ms or places the no-sandbox first command within ${absentMs}ms of the default-sandbox later-command median. The sandbox accounts for the first-command offset, and that effect is consistent across the three tools. ${numbers}.`;
  }
  if (conclusion.verdict === 'sandbox-does-not-explain') {
    return `On ${jobId}, every tool still shows a first-command offset of at least ${presentMs}ms on the no-sandbox arm. The sandbox does not account for the first-command offset, and that result is consistent across the three tools. ${numbers}.`;
  }
  if (conclusion.verdict === 'offset-absent') {
    return `On ${jobId}, the default-sandbox arm does not show a first-command offset of at least ${presentMs}ms for any of the three tools. This paired run does not reproduce the offset, so it does not show that the sandbox accounts for it. ${numbers}.`;
  }
  return `On ${jobId}, the paired runs are inconclusive under the pre-specified rule (default-sandbox offset at least ${presentMs}ms, and no-sandbox offset at most ${absentMs}ms or no-sandbox first command within ${absentMs}ms of the default-sandbox later-command median). The effect is not consistent across the three tools. ${numbers}.`;
}

function uniformRunCount(runs) {
  const counts = new Map();
  for (const run of runs || []) {
    if (!run?.jobId || !run?.tool) continue;
    const key = `${run.jobId}\0${run.tool}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const values = [...counts.values()];
  if (!values.length || values.some(value => value !== values[0])) return null;
  return values[0];
}

export function honestOffsetParagraph(conclusion, arms) {
  const subject = (conclusion?.perTool || []).find(row => row.tool === SUBJECT_TOOL);
  const from = subject?.default?.offsetMs;
  const to = subject?.noSandbox?.offsetMs;
  const defaultArm = (arms || []).find(arm => arm.id === 'default');
  const noSandboxArm = (arms || []).find(arm => arm.id === 'no-sandbox');
  const firstLoad = defaultArm?.loadAvg?.start?.one;
  const secondLoad = noSandboxArm?.loadAvg?.start?.one;
  const samples = subject?.default?.samples;
  const n = uniformRunCount(defaultArm?.runs);
  const ordered = (arms || [])[0]?.id === 'default' && (arms || [])[1]?.id === 'no-sandbox';
  if (
    !ordered
    || conclusion?.verdict !== 'inconclusive'
    || !Number.isFinite(from)
    || !Number.isFinite(to)
    || !Number.isFinite(firstLoad)
    || !Number.isFinite(secondLoad)
    || n === null
    || n !== uniformRunCount(noSandboxArm?.runs)
    || samples !== n
    || subject?.noSandbox?.samples !== n
  ) return '';
  const accounted = from - to;
  if (!(accounted > 0) || !(secondLoad > firstLoad)) return '';
  return `chrome-cdp-ex's first-command offset is unexplained. With the sandbox off it fell from ${from} ms to ${to} ms, so the sandbox accounts for about ${accounted} ms and about ${to} ms remains; the verdict is inconclusive and the remaining offset is not attributed to the sandbox. Caveats: the two arms ran one after the other, not interleaved; the second (no-sandbox) arm started at a higher load (1-minute ${secondLoad} vs ${firstLoad}); each arm has n=${n} scored runs per tool per task.`;
}

export function concludeSandboxAb(defaultRuns, noSandboxRuns, tools = SLICE1_TOOLS) {
  const perTool = tools.map(tool => {
    const baseline = firstCommandTiming(defaultRuns, STALE_REF_JOB, tool);
    const comparison = firstCommandTiming(noSandboxRuns, STALE_REF_JOB, tool);
    return {
      tool,
      effect: classifyFirstCommand(baseline, comparison),
      default: baseline,
      noSandbox: comparison,
    };
  });
  const effects = perTool.map(row => row.effect);
  let verdict = 'inconclusive';
  if (effects.length && effects.every(effect => effect === 'explained')) verdict = 'sandbox-explains';
  else if (effects.length && effects.every(effect => effect === 'persists')) verdict = 'sandbox-does-not-explain';
  else if (effects.length && effects.every(effect => effect === 'absent')) verdict = 'offset-absent';
  const conclusion = {
    jobId: STALE_REF_JOB,
    thresholds: { presentMs: OFFSET_PRESENT_MS, absentMs: OFFSET_ABSENT_MS },
    perTool,
    verdict,
  };
  conclusion.text = sandboxAbConclusionText(conclusion);
  return conclusion;
}

function snapshotArm(report, id, label) {
  return {
    id,
    label,
    noSandbox: report.environment.noSandbox,
    noSandboxReason: report.environment.noSandboxReason,
    nproc: report.environment.nproc,
    loadAvg: report.environment.loadAvg,
    measuredAt: report.measuredAt,
    gitSha: report.gitSha,
    rows: report.rows,
    losses: report.losses,
    runs: report.runs,
    discardedWarmup: report.discardedWarmup,
    warmup: report.warmup,
  };
}

export function buildSandboxAb(defaultReport, noSandboxReport) {
  if (defaultReport?.environment?.noSandbox !== false) {
    throw new Error('default sandbox arm launched Chrome with --no-sandbox');
  }
  if (noSandboxReport?.environment?.noSandbox !== true || noSandboxReport?.environment?.noSandboxReason !== 'SLICE1_NO_SANDBOX') {
    throw new Error('no-sandbox arm did not launch Chrome because of SLICE1_NO_SANDBOX');
  }
  const arms = [
    snapshotArm(defaultReport, 'default', 'default sandbox'),
    snapshotArm(noSandboxReport, 'no-sandbox', 'SLICE1_NO_SANDBOX=1'),
  ];
  return {
    label: 'Paired sandbox comparison. This object does not replace the headline rows, runs, losses, or environment.',
    replacesHeadline: false,
    order: ['default', 'no-sandbox'],
    rule: 'A tool shows the first-command offset on stale-ref-recover-act when the median first-command wallMs minus the median later-command wallMs is at least 250. The sandbox accounts for that tool when the default-sandbox arm shows the offset and the no-sandbox offset is at most 150, or the no-sandbox first-command median is within 150ms of the default-sandbox later-command median. The effect is consistent only when all three tools agree. Any other pattern is inconclusive.',
    arms,
    firstCommand: {
      default: firstCommandRows(defaultReport.runs),
      'no-sandbox': firstCommandRows(noSandboxReport.runs),
    },
    conclusion: conclusionWithHonestOffset(concludeSandboxAb(defaultReport.runs, noSandboxReport.runs), arms),
  };
}

function conclusionWithHonestOffset(conclusion, arms) {
  const honest = honestOffsetParagraph(conclusion, arms);
  if (!honest) return conclusion;
  return { ...conclusion, text: `${conclusion.text}\n\n${honest}` };
}

function lossLines(losses) {
  if (!losses?.length) return ['chrome-cdp-ex was not slower, not larger, and did not fail any compared row.'];
  return losses.map(loss => {
    if (loss.kind === 'fail') return `- ${loss.jobId}: chrome-cdp-ex failed the effect.`;
    if (loss.kind === 'slower') return `- ${loss.jobId}: chrome-cdp-ex wallMs ${loss.ours} vs ${loss.peer} ${loss.theirs} (peer pass=${loss.peerPass}).`;
    if (loss.kind === 'more-output') return `- ${loss.jobId}: chrome-cdp-ex agentChars ${loss.ours} vs ${loss.peer} ${loss.theirs} (peer pass=${loss.peerPass}).`;
    if (loss.kind === 'more-steps') return `- ${loss.jobId}: chrome-cdp-ex steps ${loss.ours} vs ${loss.peer} ${loss.theirs} (peer pass=${loss.peerPass}).`;
    return `- ${loss.jobId}: ${loss.kind}.`;
  });
}

function resultTable(rows) {
  const lines = [
    '| job | tool | pass | steps | agentChars | tokens (chars/4) | wallMs | notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows || []) {
    lines.push(`| ${cell(row.jobId)} | ${cell(row.tool)} | ${row.pass ? 'PASS' : 'FAIL'} | ${cell(row.steps)} | ${cell(row.agentChars)} | ${cell(estimateTokens(row.agentChars))} | ${cell(row.wallMs)} | ${cell(row.notes)} |`);
  }
  return lines;
}

function renderSandboxAb(report) {
  const ab = report.sandboxAb;
  if (!ab) return [];
  const lines = [
    '## Sandbox A/B',
    '',
    ab.label,
    '',
    'Run order: default sandbox, then SLICE1_NO_SANDBOX=1. Each arm waited until the 1-minute load average was below nproc, then measured all three tools with n=3 scored runs and one discarded warm-up per tool per task. The headline table above is a separate default-sandbox measurement and is not replaced by these arms.',
    '',
    ab.rule,
    '',
  ];
  for (const arm of ab.arms || []) {
    lines.push(`### ${arm.label}`);
    lines.push('');
    lines.push(`- Measured: ${arm.measuredAt}`);
    lines.push(`- git: ${arm.gitSha}`);
    const reason = arm.noSandboxReason ? ` Reason: ${arm.noSandboxReason}.` : '';
    lines.push(`- ${arm.noSandbox ? 'Chrome was launched with --no-sandbox.' : 'Chrome was launched with its default sandbox.'}${reason}`);
    lines.push(`- Load: nproc ${arm.nproc}; start ${formatLoadSample(arm.loadAvg?.start)}; end ${formatLoadSample(arm.loadAvg?.end)}.`);
    lines.push('');
    lines.push(...resultTable(arm.rows));
    lines.push('');
    lines.push('Losses:');
    lines.push('');
    lines.push(...lossLines(arm.losses));
    lines.push('');
  }
  lines.push('### First command vs later commands');
  lines.push('');
  lines.push('firstMs is the median wallMs of the first scored command. laterMs is the median wallMs of every later scored command in those runs. offsetMs is firstMs minus laterMs. Discarded warm-up runs are excluded.');
  lines.push('');
  lines.push('| arm | job | tool | firstMs | laterMs | offsetMs |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const armId of ab.order || []) {
    for (const row of ab.firstCommand?.[armId] || []) {
      lines.push(`| ${cell(armId)} | ${cell(row.jobId)} | ${cell(row.tool)} | ${cell(row.firstMs)} | ${cell(row.laterMs)} | ${cell(row.offsetMs)} |`);
    }
  }
  lines.push('');
  lines.push('### Conclusion');
  lines.push('');
  lines.push(ab.conclusion?.text || '');
  lines.push('');
  if (ab.rerun) {
    lines.push('Re-run this comparison without replacing the headline:');
    lines.push('');
    lines.push('```bash');
    lines.push(ab.rerun);
    lines.push('```');
    lines.push('');
  }
  return lines;
}

export function renderSlice1Board(report) {
  const lines = [];
  lines.push(`# Slice 1 benchmark (${report.date})`);
  lines.push('');
  lines.push('Measured on one machine. Every number below is a median from the runs in the sibling JSON file. Heuristic baselines, PK-324, and example JSON are not inputs.');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push(`- Date: ${report.measuredAt}`);
  lines.push(`- OS: ${report.environment.os}`);
  lines.push(`- Node: ${report.environment.node}`);
  lines.push(`- Chrome: ${report.environment.chrome}`);
  if (report.environment.chromeBinary) lines.push(`- Chrome binary: ${report.environment.chromeBinary}`);
  lines.push(`- ${sandboxLine(report.environment)}`);
  lines.push(`- Viewport: ${report.viewport.width}x${report.viewport.height} CSS pixels (read back ${report.viewport.readback ?? 'n/a'})`);
  if (report.environment.nproc) {
    const start = formatLoadSample(report.environment.loadAvg?.start);
    const end = formatLoadSample(report.environment.loadAvg?.end);
    lines.push(`- Load: nproc ${report.environment.nproc}; start ${start}; end ${end}. The run waited until the 1-minute load average was below nproc.`);
  }
  if (report.discardedWarmupPerTool) {
    lines.push('- Warm-up: one discarded run per tool per task, excluded from the median');
  }
  lines.push(`- Runs: n=${report.runsPerTool}, median`);
  lines.push(`- Token estimator: ${report.tokenEstimator} (not a tokenizer count)`);
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  for (const tool of report.tools) {
    lines.push(`- ${tool.name} ${tool.version}${tool.detail ? ` (${tool.detail})` : ''}`);
  }
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  if (report.discardedWarmupPerTool) {
    lines.push('Every tool uses the same already-running Chrome, the same local fixtures, and a 1042x632 CSS viewport. Each task starts with one discarded warm-up run per tool. That run uses the same commands as a scored run and is excluded from steps, agentChars, wallMs, and the median. The discarded warm-up is applied to every tool. Scored runs then rotate tool order, and the table reports the median of those scored runs.');
  } else {
    lines.push('Every tool uses the same already-running Chrome, the same local fixtures, and a 1042x632 CSS viewport. The table reports the median of the scored runs.');
  }
  if (report.environment.nproc) {
    lines.push('');
    lines.push(`The run waited until the 1-minute load average was below nproc ${report.environment.nproc}, and records the 1, 5, and 15 minute load averages at the start and end.`);
  }
  lines.push('');
  lines.push('## Protocol');
  lines.push('');
  lines.push(report.protocol);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('Effect first. `agentChars` is the Unicode code-point length of stdout plus stderr. `tokens` is `ceil(agentChars / 4)`.');
  lines.push('');
  lines.push(...resultTable(report.rows));
  lines.push('');
  lines.push('## Losses');
  lines.push('');
  lines.push(...lossLines(report.losses));
  lines.push('');
  lines.push(...renderSandboxAb(report));
  lines.push('## Re-run');
  lines.push('');
  lines.push('```bash');
  lines.push(report.rerun);
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
