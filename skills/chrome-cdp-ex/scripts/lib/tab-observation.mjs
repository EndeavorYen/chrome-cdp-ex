// Bounded on-disk copy of the tab daemon's action log and netlog (#606, #618).
// Both used to live only in the daemon process, so a restart or exit made
// `netlog` and `record-actions` look like nothing had happened. The file is
// written when the buffers change (not from an exit hook) so kill -9 keeps
// the last successful write. URLs and headers are stored redacted. Response
// bodies are not stored: Chrome drops them with the CDP session.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { redactHeaders } from './netlog.mjs';
import { redactSensitiveString, redactUrl } from './redaction.mjs';

export const TAB_OBSERVE_SCHEMA = 'chrome-cdp-ex.tab-observe.v1';
export const TAB_OBSERVE_SUFFIX = '.observe.json';
export const TAB_OBSERVE_RECORDS_MAX = 64;
export const TAB_OBSERVE_MAX_ACTIONS = 100;
export const TAB_OBSERVE_MAX_ENVIRONMENT = 100;
export const TAB_OBSERVE_MAX_NETLOG = 100;
export const TAB_OBSERVE_MAX_BYTES = 1024 * 1024;

const RESTORED_REQUEST_PREFIX = 'restored:';
let observeWriteSeq = 0;

export function tabObservePath(targetId, runtimeDir) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}${TAB_OBSERVE_SUFFIX}`);
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function netlogEntryForDisk(entry, id) {
  const status = entry?.status;
  const saved = {
    id: Number.isInteger(id) && id > 0 ? id : null,
    method: clip(entry?.method || 'GET', 32),
    url: clip(redactUrl(entry?.url || ''), 2048),
    status: status == null || status === 'pending' ? status : finiteNumber(status),
    type: clip(entry?.type || '', 64),
    duration: finiteNumber(entry?.duration) ?? 0,
    size: finiteNumber(entry?.size) ?? 0,
    ts: finiteNumber(entry?.ts) ?? 0,
  };
  if (entry?.failed === true) saved.failed = true;
  if (entry?.errorText) saved.errorText = clip(redactSensitiveString(entry.errorText), 300);
  if (entry?.pending === true || status === 'pending') saved.pending = true;
  return saved;
}

export function netlogDetailForDisk(detail) {
  if (!detail || !Number.isInteger(detail.id) || detail.id < 1) return null;
  const headers = value => redactHeaders(value || {}, { unsafeFull: false });
  const state = detail.state === 'complete' || detail.state === 'failed' ? detail.state : 'pending';
  return {
    id: detail.id,
    method: clip(detail.method || 'GET', 32),
    url: clip(redactUrl(detail.url || ''), 2048),
    urlTruncated: detail.urlTruncated === true,
    resourceType: clip(detail.resourceType || 'Other', 64),
    initiator: detail.initiator && typeof detail.initiator === 'object'
      ? { type: clip(detail.initiator.type || 'other', 32), url: clip(redactUrl(detail.initiator.url || ''), 2048) }
      : null,
    hasPostData: detail.hasPostData === true,
    startedAt: finiteNumber(detail.startedAt),
    startTimestamp: finiteNumber(detail.startTimestamp),
    endTimestamp: finiteNumber(detail.endTimestamp),
    state,
    status: finiteNumber(detail.status),
    statusText: clip(detail.statusText || '', 120),
    mimeType: clip(detail.mimeType || '', 120),
    protocol: clip(detail.protocol || '', 40),
    fromCache: detail.fromCache === true,
    fromServiceWorker: detail.fromServiceWorker === true,
    encodedDataLength: finiteNumber(detail.encodedDataLength),
    errorText: detail.errorText ? clip(redactSensitiveString(detail.errorText), 300) : null,
    canceled: detail.canceled === true,
    blockedReason: detail.blockedReason ? clip(detail.blockedReason, 120) : null,
    corsError: detail.corsError ? clip(detail.corsError, 120) : null,
    timing: detail.timing && typeof detail.timing === 'object' && !Array.isArray(detail.timing) ? detail.timing : null,
    redirects: (Array.isArray(detail.redirects) ? detail.redirects : []).slice(0, 10).map(hop => ({
      status: hop?.status ?? null,
      url: clip(redactUrl(hop?.url || ''), 2048),
    })),
    requestHeaders: headers(detail.requestHeaders),
    requestHeaderCount: Number(detail.requestHeaderCount) || 0,
    requestHeadersTruncated: detail.requestHeadersTruncated === true,
    responseHeaders: detail.responseHeaders ? headers(detail.responseHeaders) : null,
    responseHeaderCount: Number(detail.responseHeaderCount) || 0,
    responseHeadersTruncated: detail.responseHeadersTruncated === true,
    ...(detail.headersOmitted === true ? { headersOmitted: true } : {}),
  };
}

export function snapshotNetlogForDisk(netReqBuf, requestStore, { max = TAB_OBSERVE_MAX_NETLOG } = {}) {
  const entries = [];
  const details = [];
  const seen = new Set();
  const list = typeof netReqBuf?.all === 'function' ? netReqBuf.all() : [];
  for (const entry of list) {
    const mapped = requestStore?.idFor?.(entry?.requestId);
    const fromRestored = typeof entry?.requestId === 'string' && entry.requestId.startsWith(RESTORED_REQUEST_PREFIX)
      ? Number(entry.requestId.slice(RESTORED_REQUEST_PREFIX.length))
      : null;
    const id = Number.isInteger(mapped) && mapped > 0
      ? mapped
      : (Number.isInteger(fromRestored) && fromRestored > 0 ? fromRestored : null);
    entries.push(netlogEntryForDisk(entry, id));
    if (id && !seen.has(id)) {
      const detail = requestStore?.get?.(id);
      const saved = detail ? netlogDetailForDisk(detail) : null;
      if (saved) {
        seen.add(id);
        details.push(saved);
      }
    }
  }
  const nextId = Number.isInteger(requestStore?.nextId) && requestStore.nextId >= 0 ? requestStore.nextId : 0;
  return {
    nextId,
    entries: entries.slice(-max),
    details: details.slice(-max),
  };
}

function parseActions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const actions = [];
  for (const entry of value.slice(-TAB_OBSERVE_MAX_ACTIONS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.action !== 'string' || !entry.action) return null;
    if (entry.sequence != null && !Number.isInteger(entry.sequence)) return null;
    actions.push(entry);
  }
  return actions;
}

function parseEnvironment(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const environment = [];
  for (const entry of value.slice(-TAB_OBSERVE_MAX_ENVIRONMENT)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const kind = entry.kind || entry.type;
    if (typeof kind !== 'string' || !kind) return null;
    environment.push(entry);
  }
  return environment;
}

function parseNetlog(value) {
  if (value == null) return { nextId: 0, entries: [], details: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.entries) || !Array.isArray(value.details)) return null;
  const entries = [];
  for (const entry of value.entries.slice(-TAB_OBSERVE_MAX_NETLOG)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    entries.push(netlogEntryForDisk(entry, Number.isInteger(entry.id) ? entry.id : null));
  }
  const details = [];
  for (const detail of value.details.slice(-TAB_OBSERVE_MAX_NETLOG)) {
    if (!detail || typeof detail !== 'object' || !Number.isInteger(detail.id) || detail.id < 1) return null;
    const saved = netlogDetailForDisk({ ...detail, headersOmitted: detail.headersOmitted === true });
    if (!saved) return null;
    if (detail.headersOmitted === true) {
      saved.requestHeaders = {};
      saved.responseHeaders = detail.responseHeaders ? {} : null;
      saved.headersOmitted = true;
    }
    details.push(saved);
  }
  const nextId = Number.isInteger(value.nextId) && value.nextId >= 0 ? value.nextId : 0;
  return { nextId, entries, details };
}

export function parseTabObservation(text, targetId) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { status: 'unreadable' };
  }
  if (!record || record.schema !== TAB_OBSERVE_SCHEMA || record.targetId !== String(targetId)) {
    return { status: 'unreadable' };
  }
  const actions = parseActions(record.actions);
  const environment = parseEnvironment(record.environment);
  const netlog = parseNetlog(record.netlog);
  if (!actions || !environment || !netlog) return { status: 'unreadable' };
  const fromActions = actions.reduce((max, entry) => Math.max(max, Number.isInteger(entry.sequence) ? entry.sequence : 0), 0);
  const actionSeq = Math.max(Number.isInteger(record.actionSeq) && record.actionSeq >= 0 ? record.actionSeq : 0, fromActions);
  return {
    status: 'ok',
    actionSeq,
    actions,
    environment,
    netlog,
  };
}

export function readTabObservation(targetId, { runtimeDir, reader = readFileSync } = {}) {
  let text;
  try {
    text = reader(tabObservePath(targetId, runtimeDir), 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
  }
  return parseTabObservation(text, targetId);
}

function byteLength(text) {
  return Buffer.byteLength(text);
}

function serializeObservation(record) {
  let body = record;
  let text = `${JSON.stringify(body)}\n`;
  if (byteLength(text) <= TAB_OBSERVE_MAX_BYTES) return text;
  body = {
    ...record,
    netlog: {
      ...record.netlog,
      details: (record.netlog?.details || []).map(detail => ({
        ...detail,
        requestHeaders: {},
        responseHeaders: detail.responseHeaders ? {} : null,
        headersOmitted: true,
      })),
    },
  };
  text = `${JSON.stringify(body)}\n`;
  let entries = body.netlog.entries || [];
  let details = body.netlog.details || [];
  while (entries.length > 1 && byteLength(text) > TAB_OBSERVE_MAX_BYTES) {
    const dropped = entries[0]?.id;
    entries = entries.slice(1);
    details = Number.isInteger(dropped) ? details.filter(detail => detail.id !== dropped) : details.slice(1);
    body = { ...body, netlog: { ...body.netlog, entries, details } };
    text = `${JSON.stringify(body)}\n`;
  }
  let actions = body.actions || [];
  while (actions.length > 1 && byteLength(text) > TAB_OBSERVE_MAX_BYTES) {
    actions = actions.slice(1).map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const slim = { ...entry };
      delete slim.receipt;
      delete slim.effectSample;
      delete slim.consoleSample;
      delete slim.exceptionSample;
      delete slim.networkSample;
      return slim;
    });
    body = { ...body, actions };
    text = `${JSON.stringify(body)}\n`;
  }
  return text;
}

function listObservationFiles(runtimeDir, { readdir = readdirSync, reader = readFileSync } = {}) {
  let names;
  try {
    names = readdir(runtimeDir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!name.startsWith('cdp-') || !name.endsWith(TAB_OBSERVE_SUFFIX)) continue;
    const path = resolve(runtimeDir, name);
    let setAt = '';
    let seq = 0;
    let readable = false;
    try {
      const record = JSON.parse(reader(path, 'utf8'));
      readable = record?.schema === TAB_OBSERVE_SCHEMA;
      setAt = readable ? String(record.setAt || '') : '';
      seq = readable && Number.isInteger(record.seq) ? record.seq : 0;
    } catch {
      readable = false;
    }
    records.push({ path, setAt, seq, readable });
  }
  return records;
}

function pruneObservationFiles(runtimeDir, keepPath, io) {
  const records = listObservationFiles(runtimeDir, io);
  const total = records.length;
  if (total <= TAB_OBSERVE_RECORDS_MAX) return;
  const extra = total - TAB_OBSERVE_RECORDS_MAX;
  const victims = records
    .filter(record => record.readable && record.path !== keepPath)
    .sort((a, b) => a.setAt.localeCompare(b.setAt) || a.seq - b.seq)
    .slice(0, extra);
  for (const old of victims) {
    try { io.remover(old.path); } catch { /* a file still open is removed on a later write */ }
  }
}

export function writeTabObservation(targetId, state, {
  runtimeDir,
  writer = writeFileSync,
  rename = renameSync,
  remover = unlinkSync,
  readdir = readdirSync,
  reader = readFileSync,
  now = Date.now,
} = {}) {
  if (!runtimeDir || !targetId) return false;
  const path = tabObservePath(targetId, runtimeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const stamp = typeof now === 'function' ? now() : now;
  observeWriteSeq += 1;
  const actions = Array.isArray(state?.actions) ? state.actions.slice(-TAB_OBSERVE_MAX_ACTIONS) : [];
  const environment = Array.isArray(state?.environment) ? state.environment.slice(-TAB_OBSERVE_MAX_ENVIRONMENT) : [];
  const netlog = state?.netlog && typeof state.netlog === 'object'
    ? {
      nextId: Number.isInteger(state.netlog.nextId) && state.netlog.nextId >= 0 ? state.netlog.nextId : 0,
      entries: Array.isArray(state.netlog.entries) ? state.netlog.entries.slice(-TAB_OBSERVE_MAX_NETLOG) : [],
      details: Array.isArray(state.netlog.details) ? state.netlog.details.slice(-TAB_OBSERVE_MAX_NETLOG) : [],
    }
    : { nextId: 0, entries: [], details: [] };
  const record = {
    schema: TAB_OBSERVE_SCHEMA,
    targetId: String(targetId),
    setAt: new Date(stamp).toISOString(),
    seq: observeWriteSeq,
    actionSeq: Number.isInteger(state?.actionSeq) && state.actionSeq >= 0 ? state.actionSeq : 0,
    actions,
    environment,
    netlog,
  };
  const text = serializeObservation(record);
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writer(tmp, text, { mode: 0o600 });
    rename(tmp, path);
  } catch {
    try { remover(tmp); } catch { /* the failed temp file is already gone */ }
    return false;
  }
  pruneObservationFiles(runtimeDir, path, { readdir, reader, remover });
  return true;
}

export function removeTabObservation(targetId, { runtimeDir, remover = unlinkSync } = {}) {
  try { remover(tabObservePath(targetId, runtimeDir)); } catch { /* already gone */ }
}

export function restoredNetlogEntry(entry, index) {
  const id = Number.isInteger(entry?.id) && entry.id > 0 ? entry.id : null;
  return {
    ...entry,
    id,
    requestId: id != null ? `${RESTORED_REQUEST_PREFIX}${id}` : `${RESTORED_REQUEST_PREFIX}anon:${index}`,
    restored: true,
  };
}
