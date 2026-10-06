import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SURVIVOR_COMMANDS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

process.env.NODE_ENV = 'test';

const R = await import('../scripts/usage-report.mjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T00:00:00.000Z');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cdp-544-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function counterLine(offsetMs, command) {
  return JSON.stringify({ ts: new Date(NOW - offsetMs).toISOString(), command, via: 'cli' });
}

describe('#544 dual-window usage report', () => {
  it('T1: the default and --windows 7d,30d select those two trailing windows', () => {
    expect(R.parseUsageReportArgs([])).toMatchObject({ since: null, windowSpecs: ['7d', '30d'] });
    expect(R.parseUsageReportArgs(['--windows', '7d,30d'])).toMatchObject({ since: null, windowSpecs: ['7d', '30d'] });
    expect(() => R.parseUsageReportArgs(['--windows', '7d'])).toThrow(/--windows/);
    expect(() => R.parseUsageReportArgs(['--windows', '7d,7d'])).toThrow(/--windows/);
    expect(() => R.parseUsageReportArgs(['--since', '2026-10-01', '--windows', '7d,30d'])).toThrow(/--since|--windows/);
  });

  it('T2: a 10-day-old event is 30d only, and a 1-day-old event is in both windows', async () => {
    const usageFile = join(dir, 'usage.jsonl');
    writeFileSync(usageFile, [
      counterLine(10 * DAY_MS, 'eval'),
      counterLine(1 * DAY_MS, 'list'),
      counterLine(7 * DAY_MS, 'nav'),
      counterLine(7 * DAY_MS + 1, 'fill'),
      counterLine(40 * DAY_MS, 'shot'),
    ].join('\n') + '\n');
    const model = await R.buildUsageComparison({
      claudeDir: join(dir, 'missing-claude'),
      codexDir: join(dir, 'missing-codex'),
      usageFile,
      now: NOW,
      windowSpecs: ['7d', '30d'],
    });
    const row = name => model.commands.find(item => item.command === name);
    expect(model.windows.map(window => window.id)).toEqual(['7d', '30d']);
    expect(model.windows[0].since).toBe(NOW - 7 * DAY_MS);
    expect(model.windows[1].since).toBe(NOW - 30 * DAY_MS);
    expect(row('eval').windows['7d'].total).toBe(0);
    expect(row('eval').windows['30d'].total).toBe(1);
    expect(row('list').windows['7d'].total).toBe(1);
    expect(row('list').windows['30d'].total).toBe(1);
    expect(row('nav').windows['7d'].total).toBe(1);
    expect(row('fill').windows['7d'].total).toBe(0);
    expect(row('fill').windows['30d'].total).toBe(1);
    expect(row('shot').windows['7d'].total).toBe(0);
    expect(row('shot').windows['30d'].total).toBe(0);
  });

  it('T3: zeroInBoth is usage evidence, onCard follows the survivor card, and there is no fate', async () => {
    mkdirSync(join(dir, 'claude'), { recursive: true });
    const usageFile = join(dir, 'usage.jsonl');
    writeFileSync(usageFile, `${counterLine(2 * DAY_MS, 'click')}\n`);
    writeFileSync(join(dir, 'claude', 'a.jsonl'), `${JSON.stringify({
      type: 'assistant',
      cwd: '/work/chrome-cdp-ex',
      timestamp: new Date(NOW - 2 * DAY_MS).toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs doctor' } }] },
    })}\n`);
    const model = await R.buildUsageComparison({
      claudeDir: join(dir, 'claude'),
      codexDir: join(dir, 'missing-codex'),
      usageFile,
      now: NOW,
    });
    const card = new Set(SURVIVOR_COMMANDS);
    for (const row of model.commands) {
      expect(row.onCard).toBe(card.has(row.command));
      expect(row).not.toHaveProperty('fate');
    }
    expect(model).not.toHaveProperty('fate');
    expect(JSON.stringify(model)).not.toContain('"fate"');
    expect(model.zeroInBoth).not.toContain('click');
    expect(model.zeroInBoth).not.toContain('doctor');
    expect(model.commands.find(row => row.command === 'doctor').windows['30d'].dev).toBe(1);
    expect(model.commands.find(row => row.command === 'doctor').windows['30d'].total).toBe(0);
    expect(model.zeroInBoth).toContain('jsclick');
    expect(model.commands.find(row => row.command === 'jsclick').onCard).toBe(false);
    expect(model.commands.find(row => row.command === 'click').onCard).toBe(true);
    const evidenced = new Set(model.zeroInBoth);
    for (const row of model.commands) {
      const unused = model.windows.every(window => row.windows[window.id].total === 0 && row.windows[window.id].dev === 0);
      expect(evidenced.has(row.command)).toBe(unused);
    }
  });

  it('T4: one hint line, and no transcript text in the report', async () => {
    mkdirSync(join(dir, 'claude'), { recursive: true });
    writeFileSync(join(dir, 'claude', 'a.jsonl'), `${JSON.stringify({
      type: 'assistant',
      cwd: '/w',
      timestamp: new Date(NOW - DAY_MS).toISOString(),
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs eval X "SECRET_TEXT"' } }] },
    })}\n`);
    const model = await R.buildUsageComparison({
      claudeDir: join(dir, 'claude'),
      codexDir: join(dir, 'missing-codex'),
      usageFile: join(dir, 'none.jsonl'),
      now: NOW,
    });
    expect(model.schema).toBe('chrome-cdp-ex.usage-report.v2');
    expect(model.hint).toBe(R.USAGE_COMPARISON_HINT);
    expect(model.hint).toMatch(/zero use in both windows may deprecate/);
    expect(model.hint).toMatch(/fold list/);
    expect(model.hint).toMatch(/stay on the card/);
    expect(model.hint).toMatch(/does not remove commands/);
    expect(model.hint).not.toContain('\n');
    const text = R.formatUsageComparison(model);
    expect(text.split('\n').filter(line => line.startsWith('Hint:'))).toEqual([model.hint]);
    expect(text).not.toContain('SECRET_TEXT');
    expect(JSON.stringify(model)).not.toContain('SECRET_TEXT');
    expect(model.commands.find(row => row.command === 'eval').windows['7d'].total).toBe(1);
  });

  it('T5: --since stays the single-window v1 report', async () => {
    expect(R.parseUsageReportArgs(['--format', 'json', '--since', '2026-10-01'])).toMatchObject({
      format: 'json',
      since: Date.parse('2026-10-01'),
      windowSpecs: null,
    });
    const model = await R.buildUsageReport({
      claudeDir: join(dir, 'missing-claude'),
      codexDir: join(dir, 'missing-codex'),
      usageFile: join(dir, 'none.jsonl'),
      since: Date.parse('2026-10-01'),
    });
    expect(model.schema).toBe('chrome-cdp-ex.usage-report.v1');
    expect(model.unused.length).toBeGreaterThan(0);
    expect(model).not.toHaveProperty('zeroInBoth');
    expect(model).not.toHaveProperty('hint');
  });

  it('T6: command docs describe the default 7d vs 30d comparison', () => {
    for (const path of ['../skills/chrome-cdp-ex/references/commands.md', '../docs/reference.md']) {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(text, path).toMatch(/7d/);
      expect(text, path).toMatch(/30d/);
      expect(text, path).toMatch(/usage:report/);
    }
  });
});
