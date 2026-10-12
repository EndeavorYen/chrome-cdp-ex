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
  const text = String(body ?? '');
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

function localPathPatterns() {
  return [
    /\/home\/[^/\s]+\/\S+/g,
    /\/Users\/[^/\s]+\/\S+/g,
    /\/root\/\S+/g,
    /\/workspace\/\S+/g,
    /C:\\Users\\[^\\\s]+\\\S+/gi,
    /~\/[^\s/]\S*/g,
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
