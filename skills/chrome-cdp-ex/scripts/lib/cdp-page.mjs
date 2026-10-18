// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { querySelectorEvalCommand } from './action-recovery.mjs';
import { bindCdpTransport, createCdpDomains } from './cdp-domains.mjs';
import { classifyPageHealth, pageHealthScript } from './page-health.mjs';
import { MAX_PDF_BYTES, bufferFromPdfBase64, pdfPageFetchExpression } from './pdf-text.mjs';
import { goldenPathListRecommendation, goldenPathOpenPageRecommendation } from './perception-model.mjs';
import { redactUrl } from './redaction.mjs';
import { screenshotHealthScript, unavailableScreenshotSanity } from './screenshot-health.mjs';
import { distinctTargets } from './target-binding.mjs';
import { buildWebVitalsModel, buildWebVitalsUnavailable, webVitalsPageScript } from './web-vitals.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Script } from 'node:vm';
import { compactRedactedText } from './cdp-action-result.mjs';
import { CDP_DOMAIN_CLIENTS, DIFF_SHOT_LABEL_CHARS, DIFF_SHOT_LABEL_SOURCE_CHARS, DIFF_SHOT_REGION_CELL_PX, DIFF_SHOT_REGION_LIMIT, DIFF_SHOT_REGION_MIN_PIXELS, DIFF_SHOT_SPILL_PX, DIFF_SHOT_STRIP_PX, DOCUMENT_SCROLLER_JS, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, FULLSHOT_TIMEOUT_MS, HIDDEN_TAB_CAPTURE_TIMEOUT_MS, HIDDEN_TAB_ERROR_CODE, INTERACTIVE_ROLES, NAVIGATION_TIMEOUT, NAV_DOCUMENT_PROBE_EXPR, NAV_DOCUMENT_PROBE_INTERVAL_MS, PERCEIVE_PRIORITY_TEXT_RE, RUNTIME_DIR, SCREENSHOT_TIER_LABELS, SCREENSHOT_TIMEOUT, STATUS_PAGE_INFO_TIMEOUT, STATUS_VITALS_TIMEOUT, TIMEOUT, sleep } from './cdp-base.mjs';
import { aliasesForTarget, formatJson, getDisplayPrefixLength, isBlankPageUrl, pageTargetScore, parseFormatArgs, rankPageTargets, takeUnsafeFullArg } from './cdp-browser.mjs';
import { targetPrefixForDisplay } from './cdp-cli.mjs';
import { displayUrl } from './cdp-core.mjs';
import { enableDaemonDomains } from './cdp-daemon.mjs';
import { assertScreenshotOutputDirectory, documentScrollToJs, getDpr, probePageVisibility, rememberSessionTarget, writeScreenshotFile } from './cdp-input.mjs';
import { capFullshotHeight, formatFullshotOutput, fullshotFitsViewport, fullshotFrameRefError, fullshotHideScrollbarsExpression, fullshotPlanError, fullshotRestoreExpression, fullshotScrollPlanExpression, parseFullshotArgs, parseTextArgs } from './cdp-page-commands.mjs';
import { axNodeAccessibleName, axPropertyValue, elementScreenshotClip, elshotReceiptLabel, elshotRefLabel, formatElshotReceipt, isRef, parseFrameRef, resolveRef, resolveRefNode, resolvedNodeSession, validateUrl } from './cdp-perceive.mjs';
import { appendSessionScreenshot, diffShotScreenshotCaptureOptions, ensureSessionScreenshotDir, isScreenshotTimeoutError, sessionScreenshotDir } from './cdp-session-report.mjs';

export function cdpDomains(cdp) {
  let clients = CDP_DOMAIN_CLIENTS.get(cdp);
  if (!clients) {
    clients = createCdpDomains(bindCdpTransport(cdp));
    CDP_DOMAIN_CLIENTS.set(cdp, clients);
  }
  return clients;
}
// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

export async function getPages(cdp) {
  const { targetInfos } = await cdpDomains(cdp).Target.getTargets();
  // Keep regular page targets, including about:blank so agents always have a
  // usable handle. Skip chrome://, edge://, and devtools:// internal pages. One entry per
  // target id: a list that names one tab twice is still one tab (#546). The first copy is kept;
  // which copy is fresher right after a reload is not known.
  return distinctTargets(targetInfos.filter(t => t.type === 'page'
    && !t.url.startsWith('chrome://')
    && !t.url.startsWith('edge://')
    && !t.url.startsWith('devtools://')));
}
export function formatPageList(pages, browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = opts.ranked === false ? pages : rankPageTargets(pages);
  const lines = [];
  if (browserInfo) {
    const ua = browserInfo['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    if (m) lines.push(`[Electron ${m[1]}]`);
  }
  const prefixLen = getDisplayPrefixLength(ranked.map(p => p.targetId));
  const recommendedId = (rankPageTargets(pages).find(p => !isBlankPageUrl(p.url)) || ranked[0])?.targetId;
  lines.push(...ranked.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const isBlank = isBlankPageUrl(p.url);
    const rawTitle = isBlank ? '(blank tab)' : (p.title || '');
    const title = rawTitle.substring(0, 54).padEnd(54);
    const aliasNames = aliasesForTarget(p.targetId, aliases);
    const aliasSuffix = aliasNames.length ? `  ${aliasNames.map(name => `@${name}`).join(' ')}` : '';
    const rec = p.targetId === recommendedId ? ' *' : '';
    return `${id}  ${title}  ${displayUrl(p.url || '', opts)}${aliasSuffix}${rec}`;
  }));
  return lines.join('\n');
}
export function pageListBrowserModel(browserInfo = null) {
  if (!browserInfo) return null;
  const ua = browserInfo['User-Agent'] || '';
  const electron = ua.match(/Electron\/([\d.]+)/)?.[1] || null;
  return {
    product: browserInfo.Browser || browserInfo.product || null,
    userAgent: ua || null,
    electron,
  };
}
export function buildPageListModel(pages = [], browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = rankPageTargets(pages);
  const prefixLength = getDisplayPrefixLength(pages.map(p => p.targetId || ''));
  const modelPages = ranked.map((p, index) => {
    const isBlank = isBlankPageUrl(p.url);
    return {
      index: index + 1,
      targetId: p.targetId || '',
      targetPrefix: String(p.targetId || '').slice(0, prefixLength),
      type: p.type || 'page',
      title: isBlank ? '(blank tab)' : (p.title || ''),
      url: displayUrl(p.url || '', opts),
      isBlank,
      score: pageTargetScore(p),
      recommended: false,
      aliases: aliasesForTarget(p.targetId || '', aliases),
    };
  });
  const recommendedPage = modelPages.find(page => !page.isBlank) || modelPages[0];
  if (recommendedPage) recommendedPage.recommended = true;
  const recommendation = recommendedPage
    ? goldenPathListRecommendation()
    : goldenPathOpenPageRecommendation();
  const nextSteps = recommendation.commands;
  return {
    schema: 'chrome-cdp-ex.list.v1',
    targetCount: modelPages.length,
    prefixLength,
    browser: pageListBrowserModel(browserInfo),
    pages: modelPages,
    recommended: recommendedPage
      ? {
          targetId: recommendedPage.targetId,
          targetPrefix: recommendedPage.targetPrefix,
          url: recommendedPage.url,
          title: recommendedPage.title,
          score: recommendedPage.score,
        }
      : null,
    aliases: Object.values(aliases).map(alias => ({ ...alias })),
    recommendation,
    nextSteps,
  };
}
export function formatPageListOutput(pages, browserInfo = null, { format = 'text', aliases = {}, unsafeFull = false } = {}) {
  if (format === 'json') return formatJson(buildPageListModel(pages, browserInfo, { aliases, unsafeFull }));
  return formatPageList(pages, browserInfo, { aliases, unsafeFull });
}
export function shouldShowAxNode(node, compact = false, parentNode = null) {
  const role = node.role?.value || '';
  const name = axNodeAccessibleName(node);
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  // In compact mode, filter StaticText that duplicates parent's name
  if (compact && role === 'StaticText' && parentNode) {
    const parentName = axNodeAccessibleName(parentNode);
    if (parentName && parentName.includes(name)) return false;
  }
  if (role === 'none' || role === 'generic') return false;
  // Unnamed empty textboxes/checkboxes/radios are still actionable. Filtering
  // them left Interactive counts advertising controls that had no @ref.
  if (INTERACTIVE_ROLES.has(role)) return true;
  return !(name === '' && (value === '' || value == null));
}
export function axNodeTokenState(node, name) {
  const direct = node?.[name];
  if (direct && typeof direct === 'object' && 'value' in direct) {
    if (direct.value === '' || direct.value == null) return '';
    return String(direct.value);
  }
  if (typeof direct === 'boolean' || typeof direct === 'number' || typeof direct === 'string') {
    return String(direct);
  }
  return axPropertyValue(node, name);
}
export function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = axNodeAccessibleName(node);
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  const checked = axNodeTokenState(node, 'checked');
  if (checked !== '') line += ` checked=${checked}`;
  // aria-pressed / aria-expanded land here as pressed / expanded. A toggle
  // whose only change is that token used to diff as identical (#664).
  const pressed = axNodeTokenState(node, 'pressed');
  if (pressed !== '') line += ` pressed=${pressed}`;
  const expanded = axNodeTokenState(node, 'expanded');
  if (expanded !== '') line += ` expanded=${expanded}`;
  const selected = axNodeTokenState(node, 'selected');
  if (selected === 'true') line += ' selected';
  else if (selected && selected !== 'false' && selected !== '') line += ` selected=${selected}`;
  return line;
}
export function isPriorityPerceiveTextLine(line) {
  return PERCEIVE_PRIORITY_TEXT_RE.test(String(line || ''));
}
export function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}
export async function snapshotStr(cdp, sid, compact = false, extra = {}) {
  const targetPrefix = extra.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const { nodes } = await cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth, parentNode = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact, parentNode)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  lines.push('');
  lines.push('(Hint: `snap` gives only the raw AX tree. Use `perceive` instead for layout, @refs, style hints, and console health — it is the recommended starting command.)');
  return lines.join('\n');
}
// Decode a base64-encoded eval expression. Used by `eval64` and `eval --b64`
// so agents can ship CJK / Unicode / shell-hostile expressions without losing
// bytes to the surrounding shell quoting rules. We validate eagerly because a
// silently-corrupted expression would still compile and could match the wrong
// elements — better to surface a base64 error than to evaluate garbage.
export function evalBase64Decode(b64) {
  if (b64 == null || b64 === '') {
    throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
  }
  if (typeof b64 !== 'string') {
    throw new Error('eval --b64: expression must be a base64 string');
  }
  const cleaned = b64.replace(/\s+/g, '');
  // Charset check is intentionally loose on `=` so a misplaced pad falls
  // through to the dedicated padding check below with a clearer message.
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error('eval --b64: invalid base64 input (only A-Z, a-z, 0-9, +, /, = are allowed)');
  }
  // Standard base64 must be a multiple of 4 chars after padding, and `=`
  // padding may only appear at the very end. Node's Buffer base64 decoder is
  // intentionally lenient (it silently drops trailing junk), so without these
  // checks a corrupted or truncated payload would decode to a partial JS
  // expression and run as if it were the agent's intent.
  if (cleaned.length % 4 !== 0) {
    throw new Error(`eval --b64: invalid base64 length (${cleaned.length} chars; must be a multiple of 4 with = padding)`);
  }
  const padIdx = cleaned.indexOf('=');
  if (padIdx !== -1 && padIdx < cleaned.length - 2) {
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  if (padIdx === cleaned.length - 2 && cleaned[cleaned.length - 1] !== '=') {
    // e.g. "AB=Y" — first `=` at -2 but final char is not `=`; means body
    // starts after a single trailing pad, which is also illegal.
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  let decoded;
  try {
    decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`eval --b64: cannot decode base64 (${e.message})`);
  }
  if (!decoded) {
    throw new Error('eval --b64: decoded expression is empty');
  }
  // Round-trip guard: re-encoding the decoded bytes must reproduce the
  // canonical input. This catches cases where the lenient Node decoder
  // accepted bytes it should not have (e.g. a tail char that does not align
  // to a 6-bit boundary), which would otherwise yield a silently-truncated
  // expression. We compare to the original `cleaned` form so legitimate
  // whitespace in the wire format is still tolerated.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
  if (reencoded !== cleaned) {
    throw new Error('eval --b64: input is not canonical base64 (decoder dropped bytes — payload may be truncated or corrupt)');
  }
  return decoded;
}
export function runtimeExceptionMessage(exceptionDetails) {
  const text = exceptionDetails?.text;
  const description = exceptionDetails?.exception?.description;
  if (description && (text === 'Uncaught' || text === 'Uncaught (in promise)' || !text)) return description;
  return text || description || 'Unknown runtime exception';
}
function runtimeExceptionError(exceptionDetails, { pageException = false } = {}) {
  const err = new Error(runtimeExceptionMessage(exceptionDetails));
  if (pageException) err.pageException = true;
  return err;
}
function navigationFailureError(message) {
  const text = String(message ?? '');
  const err = new Error(text);
  if (/^net::ERR_[A-Z0-9_]+$/.test(text.trim())) err.navigationFailure = true;
  return err;
}
export function formatEvalValue(val, { raw = false } = {}) {
  // Preserve historical evalStr behavior: undefined prints as empty string.
  if (val === undefined) return '';
  if (val === null) return 'null';
  if (typeof val !== 'object') return String(val);
  // Default: pretty multi-line JSON for agents. --raw keeps a compact single-line encoding.
  return raw ? JSON.stringify(val) : JSON.stringify(val, null, 2);
}
export function lastTopLevelSemicolon(source) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let last = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) last = i;
  }
  return last;
}
export function codeWithoutStringsAndComments(source) {
  let output = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += '\n';
      } else output += ' ';
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        blockComment = false;
        i++;
      } else output += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      output += char === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      output += '  ';
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      output += ' ';
      quote = char;
      continue;
    }
    output += char;
  }
  return output;
}
// Blank everything nested inside (), [] or {} so a `return` inside an inner function is not
// mistaken for the wrapper's own top-level return (#396).
export function topLevelCodeOnly(source) {
  let output = '';
  let depth = 0;
  for (const char of codeWithoutStringsAndComments(source)) {
    if (char === '(' || char === '[' || char === '{') {
      output += depth === 0 ? char : ' ';
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      output += depth === 0 ? char : ' ';
    } else output += depth === 0 || char === '\n' ? char : ' ';
  }
  return output;
}
export function hasExplicitReturnStatement(source) {
  return /(?:^|[;{}:])\s*return\b/.test(topLevelCodeOnly(source));
}
// A let/const/class at statement start in the blanked top-level view. `let = 1`
// in sloppy mode is an assignment, so `let` counts only when a binding follows.
export function isLexicalStatementStart(source, index) {
  let cursor = index - 1;
  while (cursor >= 0) {
    const char = source[cursor];
    if (char === ' ' || char === '\t' || char === '\f' || char === '\v') {
      cursor -= 1;
      continue;
    }
    return char === ';' || char === '{' || char === '}' || char === '\n' || char === '\r';
  }
  return true;
}
export function continuesAsLetDeclaration(source, index) {
  let cursor = index;
  while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t' || source[cursor] === '\f' || source[cursor] === '\v')) {
    cursor += 1;
  }
  if (cursor >= source.length) return false;
  const char = source[cursor];
  if (char === '\n' || char === '\r') return false;
  if (char === '{' || char === '[') return true;
  return /[A-Za-z_$\\]/.test(char) || /\p{ID_Start}/u.test(char);
}
export function hasTopLevelLexicalDeclaration(source) {
  const top = topLevelCodeOnly(String(source));
  for (const match of top.matchAll(/\b(?:let|const|class)\b/g)) {
    if (!isLexicalStatementStart(top, match.index)) continue;
    if (match[0] === 'let' && !continuesAsLetDeclaration(top, match.index + match[0].length)) continue;
    return true;
  }
  return false;
}
export function skipSpaceAndComments(source, index, { stopAtNewline = false } = {}) {
  let cursor = index;
  let crossedNewline = false;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === ' ' || char === '\t' || char === '\f' || char === '\v') {
      cursor += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (stopAtNewline) return { index: cursor, newline: true };
      crossedNewline = true;
      cursor += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor += 1;
      if (stopAtNewline) return { index: cursor, newline: true };
      crossedNewline = true;
      continue;
    }
    if (char === '/' && next === '*') {
      cursor += 2;
      let commentNewline = false;
      while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) {
        if (source[cursor] === '\n' || source[cursor] === '\r') commentNewline = true;
        cursor += 1;
      }
      if (cursor >= source.length) return { index: cursor, newline: crossedNewline || commentNewline, unterminated: true };
      cursor += 2;
      if (commentNewline && stopAtNewline) return { index: cursor, newline: true };
      if (commentNewline) crossedNewline = true;
      continue;
    }
    return { index: cursor, newline: crossedNewline };
  }
  return { index: cursor, newline: crossedNewline };
}
// Use Strict Directive is the exact source `"use strict"` or `'use strict'` in the prologue.
export function readStringStatement(source, index) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let end = index + 1;
  let exact = true;
  while (end < source.length) {
    const char = source[end];
    if (char === '\\') {
      exact = false;
      if (end + 1 >= source.length) return null;
      end += 2;
      continue;
    }
    if (char === '\n' || char === '\r') return null;
    end += 1;
    if (char === quote) {
      const literal = source.slice(index, end);
      return {
        end,
        strict: exact && (literal === '"use strict"' || literal === "'use strict'"),
      };
    }
  }
  return null;
}
export function hasUseStrictDirective(source) {
  let cursor = skipSpaceAndComments(source, 0);
  if (cursor.unterminated) return false;
  let strict = false;
  while (cursor.index < source.length) {
    const literal = readStringStatement(source, cursor.index);
    if (!literal) break;
    const after = skipSpaceAndComments(source, literal.end, { stopAtNewline: true });
    if (after.unterminated) break;
    const boundary = source[after.index];
    const statementEnd = after.newline || boundary == null || boundary === ';';
    if (!statementEnd) break;
    if (literal.strict) strict = true;
    const nextIndex = boundary === ';' ? after.index + 1 : after.index;
    cursor = skipSpaceAndComments(source, nextIndex);
    if (cursor.unterminated) break;
  }
  return strict;
}
// #593: top-level let/const/class stay in the page script scope, so the next
// eval on that tab cannot declare the same name. A block gives this call its
// own lexical scope and keeps the last expression as the completion value.
// Runtime.evaluate replMode redeclares let/const and still keeps the binding,
// so a later var of that name throws. Await input is already inside a function.
export function wrapTopLevelLexicalScope(source) {
  if (!hasTopLevelLexicalDeclaration(source)) return source;
  const prologue = hasUseStrictDirective(source) ? '"use strict";' : '';
  return `${prologue}{${source}\n}`;
}
export function evalScopeHelpLines() {
  return [
    'The result is the last expression.',
    'A top-level return works with or without await.',
    'let, const, and class exist only for that call, so the same script can run again.',
    'var and assignments to globalThis or window stay on the tab. A sloppy function declaration stays too.',
    'A strict-mode function in a script that also uses let, const, or class stays in that call.',
    'A script that uses await returns its trailing expression; add an explicit return when the ending is ambiguous.',
    'A leading "use strict" or \'use strict\' directive still applies to the script.',
  ];
}
// A script with a top-level return is a syntax error. The same source is legal as a
// function body. Compile only; never run the script here.
const ILLEGAL_RETURN_STATEMENT = 'Illegal return statement';
function syncScriptNeedsFunctionBody(source) {
  let scriptError = null;
  try {
    new Script(source);
  } catch (err) {
    scriptError = err;
  }
  if (!scriptError || scriptError.message !== ILLEGAL_RETURN_STATEMENT) return false;
  try {
    new Script(`(()=>{${source}\n})`);
    return true;
  } catch {
    return false;
  }
}
export function wrapAwaitExpression(expression, autoWrap = false) {
  const source = String(expression || '');
  if (!autoWrap) return source;
  if (!/\bawait\b/.test(source)) {
    if (syncScriptNeedsFunctionBody(source)) return `(()=>{${source}\n})()`;
    return wrapTopLevelLexicalScope(source);
  }
  if (!source.includes(';') && !source.includes('\n')) return `(async()=>(${source}))()`;
  if (hasExplicitReturnStatement(source)) return `(async()=>{${source}})()`;

  const trimmed = source.replace(/;\s*$/, '').trimEnd();
  const separator = lastTopLevelSemicolon(trimmed);
  if (separator < 0) {
    // One expression that only spans lines or holds `;` inside nested blocks, e.g. an async IIFE.
    const single = `(async()=>(${trimmed}))()`;
    try {
      new Function(`return ${single}`);
      return single;
    } catch {
      throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
    }
  }
  const prefix = trimmed.slice(0, separator + 1);
  const finalExpression = trimmed.slice(separator + 1).trim();
  if (!finalExpression) {
    throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
  }
  const wrapped = `(async()=>{${prefix} return (${finalExpression});})()`;
  try {
    // Syntax-check only; the returned function is never invoked here.
    new Function(`return ${wrapped}`);
  } catch {
    throw new Error('eval: cannot infer the final async expression safely; add an explicit return for the desired result.');
  }
  return wrapped;
}
export async function evalStr(cdp, sid, expression, autoWrap = false, options = {}) {
  const expr = wrapAwaitExpression(expression, autoWrap);
  const params = {
    expression: expr, returnByValue: true, awaitPromise: true,
  };
  if (options.contextId != null) params.contextId = options.contextId;
  if (options.uniqueContextId != null) params.uniqueContextId = options.uniqueContextId;
  const result = await cdpDomains(cdp).Runtime.evaluate( params, sid, options.timeoutMs);
  if (result.exceptionDetails) {
    throw runtimeExceptionError(result.exceptionDetails, { pageException: options.pageException === true });
  }
  const val = result.result.value;
  return formatEvalValue(val, { raw: options.raw === true });
}
export function maybeAutoWrapEval(expression, autoWrap = false) {
  return wrapAwaitExpression(expression, autoWrap);
}
export async function evalFireAndForgetStr(cdp, sid, expression, autoWrap = false) {
  if (!expression) throw new Error('Expression required');
  await cdpDomains(cdp).Runtime.evaluate( {
    expression: maybeAutoWrapEval(expression, autoWrap),
    returnByValue: false,
    awaitPromise: false,
  }, sid);
  return 'Dispatched fire-and-forget eval (not awaiting returned promise)';
}
export function formatCallResult(remote) {
  if (!remote) return '';
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    if (remote.value === undefined) return 'undefined';
    const json = JSON.stringify(remote.value, null, 2);
    return json === undefined ? String(remote.value) : json;
  }
  if (remote.unserializableValue != null) return String(remote.unserializableValue);
  return remote.description ?? '';
}
export async function callStr(cdp, sid, expression) {
  if (!expression) throw new Error('Expression required');
  const wrapped = `(async () => {
    const value = (${expression});
    let result = (typeof value === 'function') ? value() : value;
    return await result;
  })()`;
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw runtimeExceptionError(result.exceptionDetails, { pageException: true });
  }
  return formatCallResult(result.result);
}
export function parseEvalArgs(args) {
  const opts = { expression: '', fireAndForget: false, raw: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fire-and-forget' || a === '--faf') opts.fireAndForget = true;
    else if (a === '--raw') opts.raw = true;
    else if (a === '--b64' || a === '-b') {
      const b64 = (args[++i] || '').trim();
      if (!b64) throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
      opts.expression = evalBase64Decode(b64);
    } else if (a === '--format' || a === '--compact' || String(a).startsWith('--')) {
      throw new Error(`eval: unknown argument ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (!opts.expression) opts.expression = rest.join(' ');
  if (!opts.expression) throw new Error('Expression required');
  return opts;
}
export function normalizeEvalCliArgs(args = []) {
  const fireAndForget = args.includes('--fire-and-forget') || args.includes('--faf');
  const raw = args.includes('--raw');
  const ignored = new Set(['--fire-and-forget', '--faf', '--raw']);
  const prefix = [
    ...(fireAndForget ? ['--fire-and-forget'] : []),
    ...(raw ? ['--raw'] : []),
  ];
  for (const arg of args) {
    if (ignored.has(arg) || arg === '--b64' || arg === '-b') continue;
    if (arg === '--format' || arg === '--compact' || String(arg).startsWith('--')) {
      throw new Error(`eval: unknown argument ${arg}`);
    }
  }
  const b64Index = args.findIndex(arg => arg === '--b64' || arg === '-b');
  if (b64Index !== -1) {
    const b64 = args.slice(b64Index + 1)
      .filter(arg => !ignored.has(arg) && !String(arg).startsWith('--'))
      .join('')
      .trim();
    if (!b64) throw new Error('base64 expression required');
    return [...prefix, '--b64', b64];
  }
  const expression = args.filter(arg => !ignored.has(arg)).join(' ').trim();
  if (!expression) throw new Error('expression required');
  return [...prefix, expression];
}
// ---------------------------------------------------------------------------
// emulate: media feature overrides (dark/light, reduced-motion, ...)
// ---------------------------------------------------------------------------

export function emptyEmulateState() {
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    colorScheme: null,
    reducedMotion: null,
    features: [],
    focus: false,
  };
}
export function parseEmulateArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    mode: 'status',
    colorScheme: null,
    reducedMotion: null,
    focus: null,
  };
  const tokens = fopts.args;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'status' || token === 'show') opts.mode = 'status';
    else if (token === 'off' || token === 'reset' || token === 'clear') opts.mode = 'off';
    else if (token === 'dark' || token === 'light' || token === 'no-preference') {
      opts.mode = 'set';
      opts.colorScheme = token;
    } else if (token === 'color-scheme' || token === '--color-scheme') {
      const value = tokens[++i];
      if (!value || !['dark', 'light', 'no-preference'].includes(value)) {
        throw new Error('emulate: color-scheme requires dark|light|no-preference');
      }
      opts.mode = 'set';
      opts.colorScheme = value;
    } else if (token === 'reduced-motion' || token === '--reduced-motion') {
      const value = tokens[++i];
      if (!value || !['reduce', 'no-preference'].includes(value)) {
        throw new Error('emulate: reduced-motion requires reduce|no-preference');
      }
      opts.mode = 'set';
      opts.reducedMotion = value;
    } else if (token === 'reduce-motion') {
      opts.mode = 'set';
      opts.reducedMotion = 'reduce';
    } else if (token === '--focus') {
      // #536: Emulation.setFocusEmulationEnabled, so a background tab behaves as focused.
      opts.mode = 'set';
      opts.focus = true;
    } else {
      throw new Error(`emulate: unknown argument ${token}`);
    }
  }
  // The last mode token used to win silently (`--focus off`, `off --focus`, `dark status`, `off status`).
  const modes = ['off', 'status'].filter(word => tokens.some(token => (word === 'off' ? ['off', 'reset', 'clear'] : ['status', 'show']).includes(token)));
  const hasSetting = opts.colorScheme != null || opts.reducedMotion != null || opts.focus != null;
  for (const word of modes) {
    if (hasSetting || modes.length > 1) {
      throw new Error(`emulate: ${word} cannot be combined with another setting or mode; run \`emulate <target> ${word}\` on its own`);
    }
  }
  return opts;
}
export function buildEmulateFeatures({ colorScheme = null, reducedMotion = null } = {}) {
  const features = [];
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
  return features;
}
export function buildEmulateModel(state = emptyEmulateState(), { targetPrefix = null, nextCommand = null } = {}) {
  const features = Array.isArray(state.features) ? state.features : buildEmulateFeatures(state);
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    targetPrefix,
    colorScheme: state.colorScheme || null,
    reducedMotion: state.reducedMotion || null,
    features,
    focus: state.focus === true,
    active: features.length > 0 || state.focus === true,
    nextCommand: nextCommand || (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null),
  };
}
export function formatEmulateText(model) {
  if (!model.active) {
    return [
      'Emulation: off (browser defaults)',
      model.nextCommand ? `Next: ${model.nextCommand}` : null,
    ].filter(Boolean).join('\n');
  }
  const lines = ['Emulation: active'];
  if (model.colorScheme) lines.push(`  prefers-color-scheme: ${model.colorScheme}`);
  if (model.reducedMotion) lines.push(`  prefers-reduced-motion: ${model.reducedMotion}`);
  if (model.focus) lines.push('  focus: emulated (document.hasFocus() true, page reported visible)');
  if (model.nextCommand) lines.push(`Next: ${model.nextCommand}`);
  return lines.join('\n');
}
export async function emulateStr(cdp, sid, session, args = [], { targetPrefix = null } = {}) {
  const opts = parseEmulateArgs(args);
  session.emulate = session.emulate || emptyEmulateState();
  if (opts.mode === 'off') {
    await cdpDomains(cdp).Emulation.setEmulatedMedia( { features: [] }, sid);
    if (session.emulate.focus) await cdpDomains(cdp).Emulation.setFocusEmulationEnabled( { enabled: false }, sid);
    session.emulate = emptyEmulateState();
  } else if (opts.mode === 'set') {
    const next = {
      ...session.emulate,
      colorScheme: opts.colorScheme ?? session.emulate.colorScheme,
      reducedMotion: opts.reducedMotion ?? session.emulate.reducedMotion,
    };
    // Explicitly setting only one feature still replaces the whole media feature list.
    if (opts.colorScheme != null) next.colorScheme = opts.colorScheme;
    if (opts.reducedMotion != null) next.reducedMotion = opts.reducedMotion;
    next.features = buildEmulateFeatures(next);
    // A --focus-only call leaves the media features as they are.
    if (opts.colorScheme != null || opts.reducedMotion != null) {
      await cdpDomains(cdp).Emulation.setEmulatedMedia( { features: next.features }, sid);
    }
    if (opts.focus) {
      await cdpDomains(cdp).Emulation.setFocusEmulationEnabled( { enabled: true }, sid);
      next.focus = true;
    }
    session.emulate = next;
  }
  const model = buildEmulateModel(session.emulate, {
    targetPrefix,
    nextCommand: targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null,
  });
  return opts.format === 'json' ? formatJson(model) : formatEmulateText(model);
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
export let _lastScreenshotTier = 1;
export function resetScreenshotTier() { _lastScreenshotTier = 1; }
export function getScreenshotTier() { return _lastScreenshotTier; }
export function createScreenshotTierState() { return { tier: 1 }; }
// Clip / captureBeyondViewport timeouts are a different Chrome code path and must
// not make a multi-capture command skip its viewport tiers.
export function screenshotCaptureUsesSessionTier(params = {}) {
  return params.captureBeyondViewport !== true && params.clip == null;
}
// Chrome's generic capture failure (e.g. a native window snapshot that fails) is worth
// trying the next pipeline for; other protocol errors (target closed) are not.
export function isScreenshotCaptureFailure(err) {
  return /unable to capture screenshot/i.test(String(err?.message || ''));
}
// Why a capture is a fallback frame: the tiers that failed before it (#452), or a timeout.
export function screenshotFallbackReason(capture = {}) {
  const attempts = Array.isArray(capture.attempts) ? capture.attempts : [];
  if (!attempts.length || attempts.every(a => a.timedOut)) return 'timed out';
  return `fell back to ${capture.method} (${attempts.map(a => `tier ${a.tier}: ${a.message}`).join('; ')})`;
}
export function screenshotFailureError(attempts) {
  const allTimedOut = attempts.length > 0 && attempts.every(a => a.timedOut);
  const detail = attempts
    .map(a => `tier ${a.tier} ${SCREENSHOT_TIER_LABELS[a.tier]}: ${a.message}`)
    .join('; ');
  const error = new Error(
    `Screenshot failed: ${allTimedOut ? 'all methods timed out' : 'no capture method succeeded'} (${detail}).`,
  );
  error.code = 'screenshot_capture_failed';
  error.screenshotAttempts = attempts;
  return error;
}
export async function screencastFallback(cdp, sid, timeoutMs = SCREENSHOT_TIMEOUT) {
  const frame = cdp.waitForEvent('Page.screencastFrame', timeoutMs);
  try {
    await cdpDomains(cdp).Page.startScreencast( { format: 'png', quality: 100, everyNthFrame: 1 }, sid);
    const result = await frame.promise;
    // Acknowledge so the screencast doesn't stall
    cdpDomains(cdp).Page.screencastFrameAck( { sessionId: result.sessionId }, sid).catch(() => {});
    return result.data;
  } finally {
    frame.cancel();
    cdpDomains(cdp).Page.stopScreencast( {}, sid).catch(() => {});
  }
}
export async function inspectScreenshotFrame(cdp, sid, data, { clip = null } = {}) {
  try {
    return JSON.parse(await evalStr(cdp, sid, screenshotHealthScript(data, { clip }), false, { timeoutMs: 2000 }));
  } catch (error) {
    return unavailableScreenshotSanity(error?.message || 'inspection-unavailable');
  }
}
export async function waitForScreenshotPaint(cdp, sid) {
  try {
    await evalStr(cdp, sid, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', false, { timeoutMs: 1000 });
  } catch {
    await sleep(32);
  }
}
export let _backgroundCaptureGuard = false;
export function setBackgroundCaptureGuard(on) { _backgroundCaptureGuard = on === true; }
export function hiddenTabCaptureError(cause = null) {
  const error = new Error(
    `Tab is hidden (document.visibilityState=hidden): Chrome rendered no frame for it within ${HIDDEN_TAB_CAPTURE_TIMEOUT_MS} ms. `
    + 'Chrome may render no frames for a background tab or a tab in a minimized window, and background mode (the default) does not bring tabs to the front; CDP_BACKGROUND=0 does.',
  );
  error.code = HIDDEN_TAB_ERROR_CODE;
  if (cause) error.cause = cause;
  return error;
}
export function isHiddenTabCaptureError(err) {
  return err?.code === HIDDEN_TAB_ERROR_CODE || /tab is hidden \(document\.visibilitystate=hidden\)/i.test(String(err?.message || ''));
}
export async function captureHiddenTabFrame(cdp, sid, params, hooks, inspectFrame) {
  const timeoutMs = Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0
    ? Math.min(hooks.timeoutMs, HIDDEN_TAB_CAPTURE_TIMEOUT_MS)
    : HIDDEN_TAB_CAPTURE_TIMEOUT_MS;
  const isTimeout = error => String(error?.message || '').startsWith('Timeout:');
  // #535: a minimized window or background tab renders no frame, but focus emulation makes the document
  // visible (live, Chrome 154: minimized capture timed out, then succeeded in ~0.1 s). Capture once with
  // it, never activating the tab, and switch it off again whatever happens.
  const captureWithFocusEmulation = async (firstTimeout) => {
    let enabled = false;
    try {
      enabled = true; // before the call: an enable that timed out may still have been applied
      try {
        await cdpDomains(cdp).Emulation.setFocusEmulationEnabled( { enabled: true }, sid);
      } catch (enableError) {
        throw /target closed|detached|no (?:target|session) with/i.test(enableError?.message || '') ? enableError : hiddenTabCaptureError(firstTimeout || enableError);
      }
      try {
        return await cdpDomains(cdp).Page.captureScreenshot( params, sid, timeoutMs);
      } catch (retryError) {
        // Still no frame: the hidden-tab recovery applies. Anything else (target closed) is the real error.
        throw isTimeout(retryError) ? hiddenTabCaptureError(retryError) : retryError;
      }
    } finally {
      if (enabled) {
        try { await cdpDomains(cdp).Emulation.setFocusEmulationEnabled( { enabled: false }, sid); } catch {}
      }
    }
  };
  let result;
  let focusEmulated = false;
  if (hooks.tierState?.hiddenNeedsFocusEmulation) {
    // An earlier capture of this command (a scanshot segment, a responsive-audit size) needed it:
    // skip the frameless wait instead of paying it per segment.
    result = await captureWithFocusEmulation(null);
    focusEmulated = true;
  } else {
    try {
      result = await cdpDomains(cdp).Page.captureScreenshot( params, sid, timeoutMs);
    } catch (err) {
      if (!isTimeout(err)) throw err;
      result = await captureWithFocusEmulation(err);
      focusEmulated = true;
      if (hooks.tierState) hooks.tierState.hiddenNeedsFocusEmulation = true;
    }
  }
  const captured = {
    data: result.data, fallback: false, method: 'captureScreenshot', tier: 1, hiddenTab: true,
    ...(focusEmulated ? { focusEmulated: true } : {}),
  };
  return { ...captured, retryCount: 0, sanity: await inspectFrame(captured) };
}
// Returns capture data plus bounded method/retry diagnostics.
// `params` is passed to Page.captureScreenshot (format, clip, etc.).
export async function captureScreenshot(cdp, sid, params = { format: 'png' }, hooks = {}) {
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
// Parse `shot` arguments. Returns { filePath, quiet, verbose }.
// Recognised flags: --quiet (only the saved path), --verbose (full DPR guidance).
// Default (no flags): saved path on the first line, then a brief DPR note —
// scripts that read `head -1` get a clean path without prelude noise.
export function parseShotArgs(args) {
  const opts = { filePath: null, quiet: false, verbose: false };
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  for (const t of tokens) {
    if (t === '--quiet' || t === '-q') opts.quiet = true;
    else if (t === '--verbose' || t === '-v') opts.verbose = true;
    else if (typeof t === 'string' && !t.startsWith('--')) opts.filePath = t;
  }
  return opts;
}
export function formatScreenshotCaptureDiagnostics(capture = {}) {
  const { fallback, method, retryCount = 0, sanity, firstFrameSanity, attempts = [], focusEmulated = false } = capture;
  const lines = [];
  if (focusEmulated) {
    lines.push('(hidden tab captured with temporary focus emulation; the page saw visibilitychange and focus events while it ran)');
  }
  if (fallback && retryCount === 0) {
    lines.push(attempts.length
      ? `(screenshot fallback method=${method}: ${attempts.map(a => `tier ${a.tier} ${a.message}`).join('; ')})`
      : '(screenshot fallback — Page.captureScreenshot timed out)');
  }
  if (retryCount) {
    const reason = firstFrameSanity?.reason || sanity?.reason || 'unknown';
    lines.push(`(screenshot retry=${retryCount} method=${method} reason=${reason})`);
  }
  return lines.join('\n');
}
export async function shotStr(cdp, sid, filePathOrOpts, targetId, maybeOpts) {
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
export function parseDiffShotArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { format: fopts.format, thresholdRatio: 0, reset: false, keepBaseline: false };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--reset') opts.reset = true;
    else if (token === '--keep-baseline') opts.keepBaseline = true;
    else if (token === '--threshold') {
      const raw = fopts.args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error('diff-shot --threshold requires a non-negative percent value');
      opts.thresholdRatio = n / 100;
    } else {
      throw new Error(`diff-shot: unknown option ${token}`);
    }
  }
  return opts;
}
export function formatPercentRatio(value) {
  const n = Number(value);
  return `${((Number.isFinite(n) ? n : 0) * 100).toFixed(2)}%`;
}
// #661: changed pixels are binned into 16 px cells, and cells that touch (diagonals too) form one
// region whose box is the exact extent of its changed pixels. Pure, so it runs in the page and in tests.
export function diffShotRegionsSource() {
  return `function diffShotRegions(cells, gridW, gridH, minCount) {
    const seen = new Uint8Array(gridW * gridH);
    const regions = [];
    for (let start = 0; start < gridW * gridH; start++) {
      if (seen[start] || cells.count[start] < minCount) continue;
      seen[start] = 1;
      const stack = [start];
      const region = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, changedPixels: 0, cells: [] };
      while (stack.length) {
        const index = stack.pop();
        region.cells.push(index);
        region.changedPixels += cells.count[index];
        region.x0 = Math.min(region.x0, cells.minX[index]);
        region.y0 = Math.min(region.y0, cells.minY[index]);
        region.x1 = Math.max(region.x1, cells.maxX[index]);
        region.y1 = Math.max(region.y1, cells.maxY[index]);
        const cx = index % gridW;
        const cy = (index - cx) / gridW;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
            const next = ny * gridW + nx;
            if (!seen[next] && cells.count[next] >= minCount) {
              seen[next] = 1;
              stack.push(next);
            }
          }
        }
      }
      regions.push({ x: region.x0, y: region.y0, width: region.x1 - region.x0 + 1, height: region.y1 - region.y0 + 1, changedPixels: region.changedPixels, cells: region.cells });
    }
    return regions.sort((a, b) => b.changedPixels - a.changedPixels);
  }`;
}
export function diffShotCompareScript(baselinePngBase64, currentPngBase64) {
  return `
(async () => {
  ${diffShotRegionsSource()}
  const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const load = async (b64) => {
    const blob = new Blob([decode(b64)], { type: 'image/png' });
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  };
  const [baseline, current] = await Promise.all([
    load(${JSON.stringify(baselinePngBase64)}),
    load(${JSON.stringify(currentPngBase64)}),
  ]);
  const width = Math.min(baseline.width, current.width);
  const height = Math.min(baseline.height, current.height);
  if (!width || !height) throw new Error('diff-shot: screenshot has empty dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(baseline, 0, 0, width, height);
  const baselineData = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(current, 0, 0, width, height);
  const currentData = ctx.getImageData(0, 0, width, height);
  const diffData = ctx.createImageData(width, height);
  const cellPx = ${DIFF_SHOT_REGION_CELL_PX};
  const gridW = Math.ceil(width / cellPx);
  const gridH = Math.ceil(height / cellPx);
  const cells = {
    count: new Uint32Array(gridW * gridH),
    minX: new Int32Array(gridW * gridH).fill(width),
    minY: new Int32Array(gridW * gridH).fill(height),
    maxX: new Int32Array(gridW * gridH).fill(-1),
    maxY: new Int32Array(gridW * gridH).fill(-1),
  };
  let changedPixels = 0;
  for (let i = 0; i < baselineData.data.length; i += 4) {
    const dr = Math.abs(baselineData.data[i] - currentData.data[i]);
    const dg = Math.abs(baselineData.data[i + 1] - currentData.data[i + 1]);
    const db = Math.abs(baselineData.data[i + 2] - currentData.data[i + 2]);
    const da = Math.abs(baselineData.data[i + 3] - currentData.data[i + 3]);
    const changed = dr + dg + db + da > 0;
    if (changed) changedPixels++;
    if (changed) {
      const p = i >> 2;
      const x = p % width;
      const y = (p - x) / width;
      const cell = Math.floor(y / cellPx) * gridW + Math.floor(x / cellPx);
      cells.count[cell]++;
      if (x < cells.minX[cell]) cells.minX[cell] = x;
      if (y < cells.minY[cell]) cells.minY[cell] = y;
      if (x > cells.maxX[cell]) cells.maxX[cell] = x;
      if (y > cells.maxY[cell]) cells.maxY[cell] = y;
      diffData.data[i] = 255;
      diffData.data[i + 1] = 0;
      diffData.data[i + 2] = 180;
      diffData.data[i + 3] = 255;
    } else {
      const gray = Math.round((currentData.data[i] + currentData.data[i + 1] + currentData.data[i + 2]) / 3 * 0.35);
      diffData.data[i] = gray;
      diffData.data[i + 1] = gray;
      diffData.data[i + 2] = gray;
      diffData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(diffData, 0, 0);
  const diffPngBase64 = canvas.toDataURL('image/png').split(',')[1] || '';
  const totalPixels = width * height;
  // #661: name each region by the smallest element on the page now that holds all of it. When that
  // element did not change itself (no changed cell lands on it, only on its children), the region is
  // split by child, so a toggled button above a restyled card is two regions, not one <main>. A region
  // no element holds is "around" the smallest one that holds it give or take ${DIFF_SHOT_SPILL_PX} px (an
  // outline, a focus ring, a shadow), or else around the page.
  // Screenshot pixels are device pixels; boxes are reported in CSS pixels.
  const sx = (window.innerWidth || width) / width;
  const sy = (window.innerHeight || height) / height;
  const rounding = 2;
  const isPage = (node) => !node || node === document.body || node === document.documentElement;
  const cellBox = (index) => ({ x0: cells.minX[index], y0: cells.minY[index], x1: cells.maxX[index], y1: cells.maxY[index] });
  const unionBox = (list) => list.reduce((box, index) => ({
    x0: Math.min(box.x0, cells.minX[index]),
    y0: Math.min(box.y0, cells.minY[index]),
    x1: Math.max(box.x1, cells.maxX[index]),
    y1: Math.max(box.y1, cells.maxY[index]),
  }), { x0: Infinity, y0: Infinity, x1: -1, y1: -1 });
  const toCss = (box) => ({
    x: Math.round(box.x0 * sx),
    y: Math.round(box.y0 * sy),
    width: Math.max(1, Math.round((box.x1 - box.x0 + 1) * sx)),
    height: Math.max(1, Math.round((box.y1 - box.y0 + 1) * sy)),
  });
  const atCenter = (box) => {
    const css = toCss(box);
    const x = Math.min(Math.max(0, css.x + css.width / 2), (window.innerWidth || 1) - 1);
    const y = Math.min(Math.max(0, css.y + css.height / 2), (window.innerHeight || 1) - 1);
    return document.elementFromPoint(x, y);
  };
  const holds = (node, box, slack) => {
    const css = toCss(box);
    const r = node.getBoundingClientRect();
    return r.left <= css.x + slack && r.top <= css.y + slack
      && r.right >= css.x + css.width - slack && r.bottom >= css.y + css.height - slack;
  };
  const ownerOf = (box, slack) => {
    for (let node = atCenter(box); node && node.nodeType === 1 && !isPage(node); node = node.parentElement) {
      if (holds(node, box, slack)) return node;
    }
    return null;
  };
  const childOf = (owner, node) => {
    for (let n = node; n && n.nodeType === 1 && !isPage(n); n = n.parentElement) {
      if (n.parentElement === owner) return n;
      if (n === owner) return owner;
    }
    return owner;
  };
  // A cell that hit-tests to the parent but whose changed pixels all lie within ${DIFF_SHOT_STRIP_PX} px of one
  // child is that child's outline or shadow. A gap or padding repainted edge to edge is not. Child
  // boxes are read once per parent, and not for a long list.
  const strip = ${DIFF_SHOT_STRIP_PX};
  const childBoxes = new Map();
  const outlinedChild = (parent, box) => {
    if (!childBoxes.has(parent)) {
      const children = parent.children.length <= 200 ? [...parent.children] : [];
      childBoxes.set(parent, children.map(child => ({ child, r: child.getBoundingClientRect() })).filter(({ r }) => r.width && r.height));
    }
    const css = toCss(box);
    const found = childBoxes.get(parent).find(({ r }) => r.left - strip <= css.x && r.top - strip <= css.y
      && r.right + strip >= css.x + css.width && r.bottom + strip >= css.y + css.height);
    return found ? found.child : null;
  };
  const attribute = (list, depth) => {
    const box = unionBox(list);
    const owner = ownerOf(box, rounding);
    const around = owner ? null : ownerOf(box, ${DIFF_SHOT_SPILL_PX});
    const parent = owner || around || document.body;
    if (!parent || depth >= 2) return [{ owner, around, list }];
    const groups = new Map();
    for (const index of list) {
      let child = childOf(parent, atCenter(cellBox(index)));
      if (child === parent) child = outlinedChild(parent, cellBox(index)) || parent;
      if (!groups.has(child)) groups.set(child, []);
      groups.get(child).push(index);
    }
    if (groups.has(parent)) return [{ owner, around, list }];
    // Every cell is one child's: the region is that child's, past its box if the child does not hold it.
    if (groups.size === 1) {
      const [child] = groups.keys();
      return [{ owner: holds(child, box, rounding) ? child : null, around: child, list }];
    }
    return [...groups.values()].flatMap(group => attribute(group, depth + 1));
  };
  // An element is named by its id, its aria-label, or its only heading. One that is not, such as the
  // figure inside a card, is shown "in" its nearest named ancestor. <html> and <body> get no label.
  const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const onlyHeading = (el) => {
    const found = typeof el.querySelectorAll === 'function' ? el.querySelectorAll(HEADINGS) : [];
    return found.length === 1 ? found[0] : null;
  };
  const ariaLabel = (el) => (typeof el.getAttribute === 'function' && el.getAttribute('aria-label')) || '';
  const named = (el) => Boolean(el.id || ariaLabel(el) || onlyHeading(el));
  const describe = (el, withContext) => {
    const tag = String(el.tagName || 'node').toUpperCase();
    const id = el.id ? '#' + el.id : '';
    const classes = !id && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const heading = isPage(el) ? null : onlyHeading(el);
    const text = isPage(el) ? '' : String(ariaLabel(el) || (heading && (heading.innerText || heading.textContent)) || el.innerText || el.textContent || '')
      .replace(/\\s+/g, ' ').trim();
    const described = { selector: '<' + tag + id + classes + '>', label: text.slice(0, ${DIFF_SHOT_LABEL_SOURCE_CHARS}), labelCut: text.length > ${DIFF_SHOT_LABEL_SOURCE_CHARS} };
    if (withContext && !isPage(el) && !named(el)) {
      let up = el.parentElement;
      while (up && !isPage(up) && !named(up)) up = up.parentElement;
      if (up && !isPage(up)) described.within = describe(up, false);
    }
    return described;
  };
  // Regions in one element are one change to that element, so they share a line.
  const byElement = new Map();
  for (const part of diffShotRegions(cells, gridW, gridH, ${DIFF_SHOT_REGION_MIN_PIXELS}).flatMap(region => attribute(region.cells, 0))) {
    const subject = part.owner || part.around || document.documentElement;
    const group = byElement.get(subject);
    if (group) {
      group.list.push(...part.list);
      group.contained = group.contained && Boolean(part.owner);
    } else {
      byElement.set(subject, { subject, list: [...part.list], contained: Boolean(part.owner) });
    }
  }
  const pixelsOf = (list) => list.reduce((sum, index) => sum + cells.count[index], 0);
  const byPixels = (a, b) => b.changedPixels - a.changedPixels;
  const changes = [...byElement.values()]
    .map(group => ({ ...group, box: unionBox(group.list), changedPixels: pixelsOf(group.list) }))
    .sort(byPixels);
  // A change inside both the element and the box of a larger change is part of it: the grid's new
  // background showing at a card's rounded corner is the grid's change, not the card's.
  for (let i = changes.length - 1; i > 0; i--) {
    const part = changes[i];
    const into = changes.slice(0, i).find(other => other.subject !== part.subject && other.subject.contains(part.subject)
      && other.box.x0 <= part.box.x0 && other.box.y0 <= part.box.y0 && other.box.x1 >= part.box.x1 && other.box.y1 >= part.box.y1);
    if (!into) continue;
    into.list.push(...part.list);
    into.changedPixels += part.changedPixels;
    changes.splice(i, 1);
  }
  changes.sort(byPixels);
  const regions = changes.slice(0, ${DIFF_SHOT_REGION_LIMIT}).map(group => ({
    ...toCss(group.box),
    changedPixels: group.changedPixels,
    element: describe(group.subject, true),
    contained: group.contained,
  }));
  return JSON.stringify({
    width,
    height,
    baselineWidth: baseline.width,
    baselineHeight: baseline.height,
    currentWidth: current.width,
    currentHeight: current.height,
    changedPixels,
    totalPixels,
    changedRatio: totalPixels ? changedPixels / totalPixels : 0,
    regions,
    regionCount: changes.length,
    diffPngBase64,
  });
})()
`;
}
export function formatDiffShotElement(element = {}) {
  return `${element.selector || '<?>'}${element.label ? ` "${element.label}"` : ''}`;
}
// #661: one line per changed region, largest first: the element that holds it and its CSS box.
// "around" marks a region its element does not hold: pixels past the element's box, or a change
// across the page (<HTML>). Changed pixels with no region are each alone in their cell
// (DIFF_SHOT_REGION_MIN_PIXELS is 2).
export function formatDiffShotRegionLines(model = {}) {
  const regions = Array.isArray(model.regions) ? model.regions : [];
  if (!regions.length) {
    return [Number(model.changedPixels || 0) > 0
      ? `Changed regions: none; each changed pixel is alone in its ${DIFF_SHOT_REGION_CELL_PX} px cell`
      : 'Changed regions: none'];
  }
  const total = Number(model.regionCount) || regions.length;
  return [
    `Changed regions (${total > regions.length ? `${regions.length} of ${total}` : regions.length}):`,
    ...regions.map(region => {
      const element = region.element || {};
      const within = element.within ? ` in ${formatDiffShotElement(element.within)}` : '';
      const name = `${region.contained === false ? 'around ' : ''}${formatDiffShotElement(element)}${within}`;
      return `  ${name} at ${region.x},${region.y} ${region.width}×${region.height} (${region.changedPixels} px)`;
    }),
  ];
}
export function formatDiffShotResult(model = {}) {
  const lines = [];
  if (model.baselineCaptured) {
    lines.push(`Diff-shot baseline captured: ${model.baselinePath}`);
    if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
    lines.push('Make the change to compare, then run diff-shot again: it names the regions that changed.');
    lines.push(`Next: cdp diff-shot ${targetPrefixForDisplay(model.targetId)}`);
    return lines.join('\n');
  }

  lines.push(`Diff-shot: changed ${model.changedPixels || 0}/${model.totalPixels || 0} px (${formatPercentRatio(model.changedRatio)})`);
  lines.push(...formatDiffShotRegionLines(model));
  if (Number(model.thresholdRatio || 0) > 0) {
    lines.push(`Threshold: ${formatPercentRatio(model.thresholdRatio)} (${model.exceedsThreshold ? 'exceeded' : 'within threshold'})`);
  }
  lines.push(`Baseline: ${model.baselinePath}`);
  lines.push(`Current: ${model.currentPath}`);
  lines.push(`Diff image: ${model.diffPath}`);
  if (model.width && model.height) lines.push(`Compared: ${model.width}x${model.height} screenshot pixels`);
  if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
  lines.push(model.advancedBaseline ? 'Baseline advanced to current capture.' : 'Baseline kept; pass without --keep-baseline to advance.');
  lines.push('Pixel diff: the regions say where pixels changed, not why; use cascade or perceive for the cause.');
  return lines.join('\n');
}
// #661: redact a region's labels before cutting them to receipt size, as action receipts do (#459),
// so the cut never shows part of a token.
export function diffShotReceiptElement(element) {
  if (!element) return null;
  const { label = '', labelCut = false, within = null, ...rest } = element;
  const receipt = { ...rest, label: compactRedactedText(label, { max: DIFF_SHOT_LABEL_CHARS, truncated: labelCut }) };
  if (within) receipt.within = diffShotReceiptElement(within);
  return receipt;
}
export function diffShotReceiptRegion(region) {
  return { ...region, element: diffShotReceiptElement(region?.element) };
}
export function nextDiffShotArtifactPaths(session) {
  if (!session.diffShot) session.diffShot = {};
  const seq = Number(session.diffShot.seq || 0) + 1;
  session.diffShot.seq = seq;
  const dir = ensureSessionScreenshotDir(session) || session.screenshotDir || sessionScreenshotDir(session.targetId);
  const padded = String(seq).padStart(3, '0');
  return {
    baselinePath: resolve(dir, `diff-shot-baseline-${padded}.png`),
    currentPath: resolve(dir, `diff-shot-current-${padded}.png`),
    diffPath: resolve(dir, `diff-shot-diff-${padded}.png`),
  };
}
export async function diffShotStr(cdp, sid, session, opts = {}) {
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
export async function htmlStr(cdp, sid, selectorOrArgs, extra = {}) {
  // Share selector/root resolution rules with text where practical.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const targetPrefix = extra.targetPrefix || opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const selector = opts.selectors[0] || null;
  const root = opts.root || 'document';
  const result = await evalStr(cdp, sid, `(function() {
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    let scope = document.documentElement;
    const rootSetting = ${JSON.stringify(root)};
    if (rootSetting === 'body') scope = document.body || document.documentElement;
    else if (rootSetting === 'auto' || rootSetting === 'default') {
      scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
    } else if (rootSetting !== 'document') {
      scope = safeQuery(document, rootSetting);
      if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
    }
    if (!${JSON.stringify(selector)}) {
      return JSON.stringify({ ok: true, root: rootSetting, html: (scope || document.documentElement).outerHTML });
    }
    const el = scope === document || scope === document.documentElement
      ? safeQuery(document, ${JSON.stringify(selector)})
      : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
    if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
    return JSON.stringify({ ok: true, root: rootSetting, html: el.outerHTML });
  })()`);
  let parsed;
  try { parsed = JSON.parse(result); } catch { return result; }
  if (!parsed.ok) {
    const rootLabel = parsed.root || root || 'document';
    const sel = parsed.selector || selector || '';
    throw new Error(
      `html: no element matched within root "${rootLabel}"${sel ? ` for selector ${sel}` : ''}. ` +
      `Fallback: ${querySelectorEvalCommand(targetPrefix, sel, '?.outerHTML') || `cdp perceive ${targetPrefix} -C -d 8`}`
    );
  }
  return parsed.html || '';
}
export function parseNavigationDocumentProbe(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      url: String(raw.url || ''),
      readyState: String(raw.readyState || ''),
    };
  }
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text === 'complete' || text === 'interactive' || text === 'loading') {
    return { url: '', readyState: text };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      return {
        url: String(parsed.url || ''),
        readyState: String(parsed.readyState || ''),
      };
    }
  } catch {
    // Probe results are best-effort; keep polling until dest+complete or timeout.
  }
  return null;
}
export function navigationDocumentIsReady(parsed, url) {
  return Boolean(parsed)
    && parsed.readyState === 'complete'
    && navigationDestinationMatches(parsed.url, url);
}
export async function probeNavigationDocument(cdp, sid, options = {}) {
  const raw = await evalStr(cdp, sid, NAV_DOCUMENT_PROBE_EXPR, false, {
    timeoutMs: options.probeTimeoutMs,
  });
  return parseNavigationDocumentProbe(raw);
}
export async function waitForCommittedDocumentReady(cdp, sid, url, timeoutMs = 5000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  const sleepFn = options.sleepFn || sleep;
  const loadEvent = options.loadEvent;
  const frameEvent = options.frameEvent;
  let lastState = '';
  let lastError;
  let loadDone = false;
  let frameDone = false;

  const check = async () => {
    try {
      const parsed = await probeNavigationDocument(cdp, sid, options);
      lastState = parsed?.readyState || '';
      if (parsed?.url) lastState = `${parsed.readyState} ${parsed.url}`;
      return navigationDocumentIsReady(parsed, url);
    } catch (error) {
      lastError = error;
      return false;
    }
  };

  if (await check()) return;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wakes = [sleepFn(Math.min(NAV_DOCUMENT_PROBE_INTERVAL_MS, remaining)).then(() => 'poll')];
    if (loadEvent?.promise && !loadDone) {
      wakes.push(loadEvent.promise.then(() => {
        loadDone = true;
        return 'load';
      }).catch(() => {
        loadDone = true;
        return 'load-fail';
      }));
    }
    if (frameEvent?.promise && !frameDone) {
      wakes.push(frameEvent.promise.then(() => {
        frameDone = true;
        return 'frame';
      }).catch(() => {
        frameDone = true;
        return 'frame-fail';
      }));
    }
    await Promise.race(wakes);
    if (await check()) return;
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}
export async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState', false, { timeoutMs: options.probeTimeoutMs });
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}
export function navigationDestinationMatches(observedUrl, requestedUrl) {
  if (!observedUrl || !requestedUrl) return false;
  if (isBlankPageUrl(observedUrl)) return false;
  if (observedUrl === requestedUrl) return true;
  try {
    return new URL(observedUrl).href === new URL(requestedUrl).href;
  } catch {
    return false;
  }
}
export async function observeSameTargetDestination(cdp, targetId, url, {
  delayMs = 250,
  shouldStop = () => false,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (delayMs > 0) await sleepFn(delayMs);
  const deadline = now() + TIMEOUT;
  while (!shouldStop() && now() <= deadline) {
    try {
      const { targetInfos } = await cdpDomains(cdp).Target.getTargets( {}, undefined, 1000);
      const target = (targetInfos || []).find(info => info.targetId === targetId);
      if (target && navigationDestinationMatches(target.url, url)) return target.url;
    } catch {
      // Browser-level Target.getTargets is best-effort while Page.navigate is outstanding.
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || shouldStop()) break;
    await sleepFn(Math.min(50, remainingMs));
  }
  return null;
}
export async function settleObservedNavigation(cdp, sid, {
  targetId,
  onSessionId,
  readyTimeoutMs = 5000,
  probeTimeoutMs,
} = {}) {
  try {
    await waitForDocumentReady(cdp, sid, readyTimeoutMs, { probeTimeoutMs });
    return sid;
  } catch (error) {
    if (!targetId) throw error;
    const attached = await cdpDomains(cdp).Target.attachToTarget(
      { targetId, flatten: true },
      undefined,
      5000,
    );
    const nextSid = attached?.sessionId;
    if (!nextSid) throw error;
    await enableDaemonDomains(cdp, nextSid);
    rememberSessionTarget(nextSid, targetId);
    onSessionId?.(nextSid);
    await waitForDocumentReady(cdp, nextSid, readyTimeoutMs, { probeTimeoutMs });
    return nextSid;
  }
}
export async function navStr(cdp, sid, url, opts = {}) {
  validateUrl(url);
  await cdpDomains(cdp).Page.enable( {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const frameEvent = cdp.waitForEvent('Page.frameNavigated', NAVIGATION_TIMEOUT);
  const cancelNavWaiters = () => {
    loadEvent.cancel();
    frameEvent.cancel();
  };
  const targetId = opts.targetId || null;
  let navigateSettled = false;
  const navigatePromise = (async () => {
    try {
      const result = await cdpDomains(cdp).Page.navigate( { url }, sid);
      return { kind: 'rpc', result };
    } finally {
      navigateSettled = true;
    }
  })();
  const observePromise = targetId
    ? observeSameTargetDestination(cdp, targetId, url, {
        delayMs: opts.observeDelayMs ?? 250,
        shouldStop: () => navigateSettled,
      }).then(href => (href ? { kind: 'observed', href } : null))
    : null;

  let outcome;
  try {
    outcome = observePromise
      ? await Promise.race([
          navigatePromise,
          observePromise.then(value => value || navigatePromise),
        ])
      : await navigatePromise;
  } catch (e) {
    cancelNavWaiters();
    throw e;
  }

  if (outcome.kind === 'observed') {
    cancelNavWaiters();
    navigatePromise.catch(() => {});
    // Target.getTargets shows the pending URL while beforeunload still runs, so the URL alone does not
    // prove the navigation happened. When asked, wait (bounded) for Page.navigate's own answer (#490).
    if (opts.confirmNavigateMs > 0) {
      const answer = await Promise.race([
        navigatePromise.catch(() => null),
        sleep(opts.confirmNavigateMs).then(() => null),
      ]);
      if (answer?.result?.errorText) throw navigationFailureError(answer.result.errorText);
    }
    await settleObservedNavigation(cdp, sid, {
      targetId,
      onSessionId: opts.onSessionId,
      readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
      probeTimeoutMs: opts.probeTimeoutMs,
    });
    return `Navigated to ${url}`;
  }

  const result = outcome.result;
  if (result.errorText) {
    cancelNavWaiters();
    throw navigationFailureError(result.errorText);
  }
  try {
    await waitForCommittedDocumentReady(cdp, sid, url, opts.readyTimeoutMs ?? 5000, {
      probeTimeoutMs: opts.probeTimeoutMs,
      loadEvent,
      frameEvent,
    });
  } finally {
    cancelNavWaiters();
  }
  return `Navigated to ${url}`;
}
export async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 4096), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  // Redact before cutting to 120 chars so a cut never exposes a secret value (#455).
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${redactUrl(e.name).substring(0, 120)}`
  ).join('\n');
}
export function formatMetricValue(name, value) {
  if (name === 'JSHeapUsedSize' || name === 'JSHeapTotalSize') {
    if (!Number.isFinite(value)) return String(value);
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
export async function runtimeMetricsStr(cdp, sid) {
  try { await cdpDomains(cdp).Performance.enable( {}, sid); } catch {}
  const { metrics = [] } = await cdpDomains(cdp).Performance.getMetrics( {}, sid);
  const wanted = ['Documents', 'Frames', 'JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'Tasks'];
  const byName = new Map(metrics.map(m => [m.name, m.value]));
  const lines = ['Runtime metrics (Performance.getMetrics):'];
  for (const name of wanted) {
    if (!byName.has(name)) continue;
    lines.push(`  ${name}: ${formatMetricValue(name, byName.get(name))}`);
  }
  if (lines.length === 1) lines.push('  (no requested metrics returned by this target)');
  return lines.join('\n');
}
export async function webVitalsModel(cdp, sid) {
  const result = await cdpDomains(cdp).Runtime.evaluate({
    expression: webVitalsPageScript(), returnByValue: true, awaitPromise: true,
  }, sid, STATUS_VITALS_TIMEOUT);
  if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  return buildWebVitalsModel(result.result?.value);
}
export async function webVitalsModelOrUnavailable(cdp, sid) {
  try {
    return await webVitalsModel(cdp, sid);
  } catch (e) {
    return buildWebVitalsUnavailable(e.message);
  }
}
export function isPdfViewerContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('application/pdf');
}
export function pdfViewerNextCommand(targetPrefix = '<target>') {
  return `cdp eval ${targetPrefix} "document.contentType"`;
}
export function pdfViewerHandoffModel(meta = {}, { targetPrefix = '<target>', unsafeFull = false } = {}) {
  return {
    schema: 'chrome-cdp-ex.pdf-viewer.v1',
    title: meta.title || '',
    url: displayUrl(meta.url || '', { unsafeFull }),
    contentType: meta.contentType || 'application/pdf',
    nextCommand: pdfViewerNextCommand(targetPrefix),
    message: 'Chrome is rendering a PDF plugin, not an HTML document.',
  };
}
export function pdfViewerReportRecommendation(targetPrefix = '<target>') {
  const run = pdfViewerNextCommand(targetPrefix);
  return {
    source: 'pdf-viewer',
    actionIndex: null,
    action: null,
    diagnosisKind: 'pdf-viewer',
    strategy: 'do-not-probe-ax',
    priority: 'high',
    verifyCommand: run,
    commands: [run],
  };
}
export function formatPdfViewerOutput(meta = {}, { targetPrefix = '<target>', unsafeFull = false } = {}) {
  const model = pdfViewerHandoffModel(meta, { targetPrefix, unsafeFull });
  return [
    model.schema,
    `PDF viewer: ${model.message}`,
    `Page: ${model.title || '(untitled)'}`,
    `URL: ${model.url || '(unknown)'}`,
    `contentType: ${model.contentType}`,
    'Accessibility tree is empty for this viewer. Do not retry perceive. Use text --auto to read page-1 text.',
    `Next: ${model.nextCommand}`,
  ].join('\n');
}
export function pdfViewerHandoffModelFromOutput(output, targetPrefix = '<target>') {
  const text = String(output || '');
  const title = text.match(/^Page: (.*)$/m)?.[1];
  const url = text.match(/^URL: (.*)$/m)?.[1];
  const contentType = text.match(/^contentType: (.*)$/m)?.[1];
  return pdfViewerHandoffModel({
    title: !title || title === '(untitled)' ? '' : title,
    url: !url || url === '(unknown)' ? '' : url,
    contentType,
  }, { targetPrefix });
}
export function pdfViewerError(meta = {}, { targetPrefix = '<target>' } = {}) {
  const err = new Error(formatPdfViewerOutput(meta, { targetPrefix }));
  err.code = 'pdf_viewer';
  return err;
}
export async function assertNotPdfViewerPage(cdp, sid, { targetPrefix = '<target>', allowPdf = false } = {}) {
  try {
    const page = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })',
      false,
      { timeoutMs: STATUS_PAGE_INFO_TIMEOUT },
    ));
    if (isPdfViewerContentType(page.contentType) && !allowPdf) {
      throw pdfViewerError(page, { targetPrefix });
    }
    return page;
  } catch (error) {
    if (error?.code === 'pdf_viewer') throw error;
    return null;
  }
}
export function fileUrlToPath(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'file:') return null;
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}
export function asPdfBuffer(loaded) {
  if (Buffer.isBuffer(loaded)) return loaded;
  if (loaded instanceof Uint8Array) return Buffer.from(loaded);
  return Buffer.alloc(0);
}
export async function loadPdfBytesForText(cdp, sid, url, extra = {}) {
  if (typeof extra.loadPdfBytes === 'function') {
    return asPdfBuffer(await extra.loadPdfBytes(url));
  }
  const filePath = fileUrlToPath(url);
  if (filePath) {
    try {
      const bytes = readFileSync(filePath);
      if (bytes.length && bytes.length <= (extra.maxPdfBytes || MAX_PDF_BYTES)) return bytes;
    } catch {
      // Fall through to in-page / Node fetch.
    }
  }
  try {
    const encoded = await evalStr(
      cdp,
      sid,
      pdfPageFetchExpression(url, extra.maxPdfBytes || MAX_PDF_BYTES),
      false,
      { timeoutMs: extra.pdfFetchTimeoutMs || TIMEOUT },
    );
    const fromPage = bufferFromPdfBase64(encoded);
    if (fromPage.length) return fromPage;
  } catch {
    // Chrome PDF plugin pages often block fetch; Node fetch is the fallback.
  }
  const fetchImpl = extra.fetch || (process.env.NODE_ENV === 'test' ? null : globalThis.fetch);
  if (typeof fetchImpl !== 'function' || !url) return Buffer.alloc(0);
  try {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response?.ok) return Buffer.alloc(0);
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length || buf.length > (extra.maxPdfBytes || MAX_PDF_BYTES)) return Buffer.alloc(0);
    return buf;
  } catch {
    return Buffer.alloc(0);
  }
}
export async function collectPageHealth(cdp, sid, { changed = false, retryIndeterminate = true } = {}) {
  const sample = async () => {
    const signals = JSON.parse(await evalStr(cdp, sid, pageHealthScript(), false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    return classifyPageHealth({ ...signals, changed });
  };
  let health = await sample();
  if (retryIndeterminate && health.status === 'indeterminate') {
    await sleep(50);
    health = await sample();
  }
  return health;
}
export function parseConsoleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const lifted = takeUnsafeFullArg(fopts.args);
  if (lifted.args.length > 1) {
    throw new Error('console: choose exactly one mode: --all, --errors, or --clear.');
  }
  const flag = lifted.args[0];
  const modes = new Map([
    [undefined, 'new'],
    ['--all', 'all'],
    ['--errors', 'errors'],
    ['--clear', 'clear'],
  ]);
  if (!modes.has(flag)) {
    throw new Error(`console: unknown option ${flag}. Supported options: --all, --errors, --clear, --unsafe-full, --format text|json.`);
  }
  return { mode: modes.get(flag), format: fopts.format, unsafeFull: lifted.unsafeFull };
}
export async function elshotStr(cdp, sid, selector, targetId, refMap, refState, filePath = null) {
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
async function pinFullshotRef(cdp, sid, refMap, ref, refState) {
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const nodeSid = resolvedNodeSession(cdp, sid, objectId);
  const token = `fs${Date.now().toString(36)}`;
  await cdpDomains(cdp).Runtime.callFunctionOn( {
    objectId,
    functionDeclaration: 'function(token) { this.setAttribute("data-cdp-fullshot-target", token); return true; }',
    arguments: [{ value: token }],
    returnByValue: true,
  }, nodeSid);
  return `[data-cdp-fullshot-target="${token}"]`;
}

export async function fullshotStr(cdp, sid, filePathOrArgs, targetId, extra = {}) {
  const parsed = Array.isArray(filePathOrArgs)
    ? parseFullshotArgs(filePathOrArgs)
    : {
        filePath: typeof filePathOrArgs === 'string' && filePathOrArgs ? filePathOrArgs : null,
        scrollContainer: extra.scrollContainer || null,
        format: extra.format || 'text',
      };
  if (parsed.filePath) assertScreenshotOutputDirectory(parsed.filePath, 'fullshot');
  const requestedContainer = parsed.scrollContainer;
  // A frame ref resolves in the iframe document. The plan then looks the marker
  // up in the main document, misses, and restore never clears the attribute.
  if (requestedContainer && parseFrameRef(requestedContainer)) {
    throw fullshotFrameRefError(requestedContainer);
  }
  const targetPrefix = targetPrefixForDisplay(targetId);
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });

  let selector = requestedContainer;
  let pinned = false;
  if (selector && isRef(selector)) {
    selector = await pinFullshotRef(cdp, sid, extra.refMap, selector, extra.refState);
    pinned = true;
  }

  let prepared = { ok: true, mode: 'document' };
  let containerMode = false;
  try {
    try {
      const raw = await evalStr(cdp, sid, fullshotScrollPlanExpression({
        selector,
        label: requestedContainer,
      }));
      const plan = JSON.parse(raw);
      if (plan && typeof plan === 'object') prepared = plan;
    } catch (error) {
      if (error?.selectorMiss === true || error?.usage === true || error?.code === 'pdf_viewer') throw error;
      prepared = { ok: true, mode: 'document' };
    }
    if (prepared.ok === false) throw fullshotPlanError(prepared);
    containerMode = prepared.mode === 'container';
    if (containerMode) {
      // Expanding html/body to overflow:visible makes the document scroll, which
      // reserves a scrollbar and shrinks layout width. The sheet takes effect on
      // the next frame, so measure only after that frame.
      await evalStr(cdp, sid, fullshotHideScrollbarsExpression());
    }
    const dpr = await getDpr(cdp, sid);
    const metrics = await cdpDomains(cdp).Page.getLayoutMetrics( {}, sid);
    const width = metrics.cssContentSize?.width || metrics.contentSize?.width || 1280;
    const layoutHeight = metrics.cssContentSize?.height || metrics.contentSize?.height || 800;
    const contentHeight = Number(prepared.contentHeight) || 0;
    const height = containerMode ? Math.max(layoutHeight, contentHeight) : layoutHeight;
    let viewport = null;
    try {
      viewport = JSON.parse(await evalStr(
        cdp,
        sid,
        'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
      ));
    } catch {}
    const limited = capFullshotHeight(height);
    const fitsViewport = fullshotFitsViewport({ width, height: limited.height }, viewport);
    const params = fitsViewport
      ? { format: 'png' }
      : {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: limited.height, scale: 1 },
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

    const out = parsed.filePath || resolve(RUNTIME_DIR, `fullshot-${(targetId || 'unknown').slice(0, 8)}.png`);
    writeScreenshotFile(out, capture.data, 'fullshot');
    const diagnostics = formatScreenshotCaptureDiagnostics(capture);
    return formatFullshotOutput({
      path: out,
      width,
      height: limited.height,
      dpr,
      diagnostics,
      container: containerMode ? (requestedContainer || prepared.label || 'container') : null,
      capped: limited,
    }, parsed.format);
  } finally {
    if (containerMode || pinned) {
      await evalStr(cdp, sid, fullshotRestoreExpression()).catch(() => {});
    }
  }
}
export async function scanshotStr(cdp, sid, targetId) {
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
export async function annotshotStr(cdp, sid, targetId, refMap) {
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
