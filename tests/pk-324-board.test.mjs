import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import {
  LOCKED_PK_BOARD,
  PK_324_SCOREBOARD_FILE,
  passFaceWinners,
  renderPk324ScoreboardSvg,
  scoreCell,
} from '../scripts/lib/pk-324-board.mjs';

function jobNamed(name) {
  return LOCKED_PK_BOARD.jobs.find(job => job.name === name);
}

function cellChunk(svg, jobName, toolLabel) {
  const marker = `data-job="${jobName}" data-tool="${toolLabel}"`;
  const start = svg.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const groupStart = svg.lastIndexOf('<g', start);
  const groupEnd = svg.indexOf('</g>', start);
  return svg.slice(groupStart, groupEnd + 4);
}

describe('locked PK board scoreboard SVG', () => {
  it('keeps engineer mashup cells as success / steps / time / token', () => {
    const scroll = jobNamed('scroll to bottom (HF home)');
    expect(scoreCell(scroll, 'cdp')).toBe('PASS / 1 / 139 / 62');
  });

  it('names PASS winners per face and never lets FAIL win', () => {
    const scroll = jobNamed('scroll to bottom (HF home)');
    expect(passFaceWinners(scroll, 'steps')).toEqual(['cdp', 'browserUse', 'playwright']);
    expect(passFaceWinners(scroll, 'token')).toEqual(['playwright']);
    expect(passFaceWinners(scroll, 'time')).toEqual(['playwright']);

    const search = jobNamed('search submit bert');
    expect(passFaceWinners(search, 'steps')).toEqual(['cdp']);
    expect(passFaceWinners(search, 'token')).toEqual(['playwright']);
    expect(passFaceWinners(search, 'time')).toEqual(['cdp']);

    const pdf = jobNamed('PDF text one page');
    expect(pdf.browserUse.time).toBe(5);
    expect(pdf.playwright.token).toBe(0);
    expect(passFaceWinners(pdf, 'steps')).toEqual(['cdp']);
    expect(passFaceWinners(pdf, 'token')).toEqual(['cdp']);
    expect(passFaceWinners(pdf, 'time')).toEqual(['cdp']);

    const overlay = jobNamed('overlay detect');
    expect(overlay.browserUse.time).toBe(21);
    expect(passFaceWinners(overlay, 'steps')).toEqual(['cdp', 'playwright']);
    expect(passFaceWinners(overlay, 'token')).toEqual(['playwright']);
    expect(passFaceWinners(overlay, 'time')).toEqual(['playwright']);
  });

  it('renders locked steps / token / wall ms cells with PASS winners bold', () => {
    const svg = renderPk324ScoreboardSvg();
    expect(svg).toContain('steps / token / wall ms');
    expect(svg).toContain('data-value="10/10"');
    expect(svg).toContain('data-value="8/10"');
    expect(svg).toContain('data-value="9/10"');
    expect(svg).toMatch(/data-value="10\/10"[^>]*font-weight="700"/);
    expect(svg).not.toMatch(/data-value="8\/10"[^>]*font-weight="700"/);
    expect(svg).not.toMatch(/data-value="9\/10"[^>]*font-weight="700"/);
    expect(svg).not.toMatch(/\bcost\b/i);
    expect(svg).not.toMatch(/\bcp\b/i);

    const scrollCdp = cellChunk(svg, 'scroll to bottom (HF home)', 'chrome-cdp-ex');
    expect(scrollCdp).toContain('data-success="PASS"');
    expect(scrollCdp).toContain('data-steps="1"');
    expect(scrollCdp).toContain('data-token="62"');
    expect(scrollCdp).toContain('data-time="139"');
    expect(scrollCdp).toMatch(/data-face="steps"[^>]*font-weight="700"/);
    expect(scrollCdp).not.toMatch(/data-face="token"[^>]*font-weight="700"/);
    expect(scrollCdp).not.toMatch(/data-face="time"[^>]*font-weight="700"/);
    expect(scrollCdp).toContain('1 / 62 / 139');

    const scrollPw = cellChunk(svg, 'scroll to bottom (HF home)', 'Playwright');
    expect(scrollPw).toContain('1 / 41 / 2');
    expect(scrollPw).toMatch(/data-face="token"[^>]*font-weight="700"/);
    expect(scrollPw).toMatch(/data-face="time"[^>]*font-weight="700"/);
  });

  it('color-marks FAIL cells and still prints their scores', () => {
    const svg = renderPk324ScoreboardSvg();
    const pdfBu = cellChunk(svg, 'PDF text one page', 'Browser Use');
    const pdfPw = cellChunk(svg, 'PDF text one page', 'Playwright');
    const overlayBu = cellChunk(svg, 'overlay detect', 'Browser Use');
    const overlayPw = cellChunk(svg, 'overlay detect', 'Playwright');

    for (const fail of [pdfBu, pdfPw, overlayBu]) {
      expect(fail).toContain('data-success="FAIL"');
      expect(fail).toContain('pk-fail');
      expect(fail).not.toMatch(/font-weight="700"/);
    }
    expect(pdfBu).toContain('1 / 94 / 5');
    expect(pdfPw).toContain('1 / 0 / 2');
    expect(overlayBu).toContain('1 / 35139 / 21');
    expect(overlayPw).toContain('data-success="PASS"');
    expect(overlayPw).not.toContain('pk-fail');
  });

  it('matches the checked-in scoreboard SVG', () => {
    const committed = readFileSync(new URL(`../${PK_324_SCOREBOARD_FILE}`, import.meta.url), 'utf8');
    expect(committed).toBe(renderPk324ScoreboardSvg());
  });
});
