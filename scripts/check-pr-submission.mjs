#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BLOCKED_COAUTHOR = /bot|agent|cursor|copilot|\[bot\]/i;
const COAUTHOR_LINE = /^\s*co-authored-by:\s*(.*)$/i;
const USAGE = 'Usage: node scripts/check-pr-submission.mjs --body-file F --head SHA [--commits-file F]';

export function checkVerification(body) {
  const lines = normalizeNewlines(body).split('\n');
  const start = lines.findIndex(line => /^## Verification\s*$/.test(line));
  if (start === -1) return ['missing ## Verification heading'];

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }

  const section = lines.slice(start + 1, end).join('\n').toLowerCase();
  const problems = [];
  if (!section.includes('proof')) problems.push('Verification section missing Proof');
  if (!section.includes('evidence class')) problems.push('Verification section missing Evidence class');
  return problems;
}

export function checkForbiddenText(text, extraTerms = []) {
  const source = String(text ?? '');
  const problems = [];
  const found = [];
  for (const pattern of localPathPatterns()) {
    for (const match of source.matchAll(pattern)) {
      const path = tidyPath(match[0]);
      if (path) found.push({ index: match.index ?? 0, path });
    }
  }
  found.sort((left, right) => left.index - right.index);
  const seenPaths = new Set();
  for (const item of found) {
    if (seenPaths.has(item.path)) continue;
    seenPaths.add(item.path);
    problems.push(`path ${item.path}`);
  }

  const terms = Array.isArray(extraTerms) ? extraTerms : [];
  const seenTerms = new Set();
  const haystack = source.toLowerCase();
  for (const term of terms) {
    const needle = String(term ?? '').trim();
    if (!needle) continue;
    const key = needle.toLowerCase();
    if (seenTerms.has(key)) continue;
    if (!haystack.includes(key)) continue;
    seenTerms.add(key);
    problems.push(`term ${needle}`);
  }
  return problems;
}

export function checkCoAuthors(commitMessages) {
  const messages = Array.isArray(commitMessages) ? commitMessages : [];
  const problems = [];
  messages.forEach((message, commitIndex) => {
    const lines = normalizeNewlines(message).split('\n');
    lines.forEach((line, lineIndex) => {
      const match = COAUTHOR_LINE.exec(line);
      if (!match) return;
      if (!BLOCKED_COAUTHOR.test(match[1])) return;
      problems.push(`commit ${commitIndex} line ${lineIndex + 1}: ${line.trim()}`);
    });
  });
  return problems;
}

export function checkHeadSha(body, headSha) {
  const text = textOutsideQuotedCode(body);
  const head = String(headSha ?? '');
  const headLower = head.toLowerCase();
  const citation = /\bhead\b(?:\s+(?:sha|commit))?(?:[\s:`])*([0-9a-f]{7,40})\b/gi;
  const problems = [];
  const seen = new Set();
  for (const match of text.matchAll(citation)) {
    const token = match[1];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (headLower.startsWith(key)) continue;
    problems.push(`body cites head ${token} but current head is ${head}`);
  }
  return problems;
}

const CODE_GAP = '\u0000';
const BARE_SHA = /^[0-9a-fA-F]{7,40}$/;

function textOutsideQuotedCode(body) {
  return stripInlineCode(stripFencedCode(normalizeNewlines(body)));
}

function stripFencedCode(text) {
  const lines = text.split('\n');
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const open = openingFence(lines[index]);
    if (!open) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    while (index < lines.length && !closingFence(lines[index], open)) index += 1;
    if (index < lines.length) index += 1;
    kept.push(CODE_GAP);
  }
  return kept.join('\n');
}

function openingFence(line) {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2];
  const info = match[3];
  if (marker[0] === '`' && info.includes('`')) return null;
  return { char: marker[0], size: marker.length };
}

function closingFence(line, open) {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  const marker = match[2];
  return marker[0] === open.char && marker.length >= open.size;
}

function stripInlineCode(text) {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') {
      result += text[index];
      index += 1;
      continue;
    }
    let size = 0;
    while (index + size < text.length && text[index + size] === '`') size += 1;
    const closer = findBacktickRun(text, index + size, size);
    if (closer === -1) {
      result += text.slice(index, index + size);
      index += size;
      continue;
    }
    const raw = text.slice(index + size, closer);
    // A backticked hex token is the citation form (`head sha \`abc1234\``), not quoted output.
    if (BARE_SHA.test(unwrapCodeSpan(raw))) {
      result += text.slice(index, closer + size);
    } else {
      result += CODE_GAP;
    }
    index = closer + size;
  }
  return result;
}

function findBacktickRun(text, from, size) {
  let index = from;
  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    let run = 0;
    while (index + run < text.length && text[index + run] === '`') run += 1;
    if (run === size) return index;
    index += run;
  }
  return -1;
}

function unwrapCodeSpan(raw) {
  if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && /[^ ]/.test(raw)) {
    return raw.slice(1, -1);
  }
  return raw;
}

function localPathPatterns() {
  return [
    /\/home\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]\S*/g,
    /\/Users\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]\S*/g,
    /\/root\/[A-Za-z0-9_.-]\S*/g,
    /\/workspace\/[A-Za-z0-9_.-]\S*/g,
    /C:\\Users\\[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]\S*/gi,
    /~\/[A-Za-z0-9_.-]\S*/g,
  ];
}

function tidyPath(value) {
  return value.replace(/[`'".,;:!?)\]]+$/g, '');
}

function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseForbiddenTerms(raw) {
  return normalizeNewlines(raw)
    .split(/[\n,]/)
    .map(term => term.trim())
    .filter(Boolean);
}

function splitCommitMessages(text) {
  const lines = normalizeNewlines(text).split('\n');
  const messages = [];
  let current = [];
  for (const line of lines) {
    if (line === '---commit---') {
      messages.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.some(line => line !== '')) messages.push(current.join('\n'));
  return messages;
}

function parseArgs(argv) {
  const options = { bodyFile: '', head: '', commitsFile: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg !== '--body-file' && arg !== '--head' && arg !== '--commits-file') return null;
    if (next == null || next.startsWith('--')) return null;
    if (arg === '--body-file') options.bodyFile = next;
    else if (arg === '--head') options.head = next;
    else options.commitsFile = next;
    index += 1;
  }
  if (!options.bodyFile || !options.head) return null;
  return options;
}

function readText(filePath, label) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    console.error(`Cannot read ${label}: ${filePath}`);
    process.exit(2);
  }
}

function collectProblems({ body, head, commitMessages, extraTerms }) {
  const problems = [];
  for (const detail of checkVerification(body)) {
    problems.push({ rule: 'verification', detail });
  }
  for (const detail of checkForbiddenText(body, extraTerms)) {
    problems.push({ rule: 'forbidden-text', detail });
  }
  commitMessages.forEach((message, index) => {
    for (const detail of checkForbiddenText(message, extraTerms)) {
      problems.push({ rule: 'forbidden-text', detail: `commit ${index}: ${detail}` });
    }
  });
  for (const detail of checkCoAuthors(commitMessages)) {
    problems.push({ rule: 'co-author', detail });
  }
  for (const detail of checkHeadSha(body, head)) {
    problems.push({ rule: 'head-sha', detail });
  }
  return problems;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error(USAGE);
    process.exit(2);
  }

  const body = readText(options.bodyFile, 'body file');
  const commitText = options.commitsFile ? readText(options.commitsFile, 'commits file') : '';
  const problems = collectProblems({
    body,
    head: options.head,
    commitMessages: splitCommitMessages(commitText),
    extraTerms: parseForbiddenTerms(process.env.PR_FORBIDDEN_TERMS),
  });

  if (problems.length === 0) {
    console.log('OK');
    process.exit(0);
  }
  for (const problem of problems) {
    console.log(`FAIL ${problem.rule}: ${problem.detail}`);
  }
  process.exit(1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}
