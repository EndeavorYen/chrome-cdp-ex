import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { extractPdfPageText } from '../skills/chrome-cdp-ex/scripts/lib/pdf-text.mjs';
import {
  PDF_PAGE1_LANDMARK as LANDMARK,
  PDF_PAGE1_SUBTITLE as SUBTITLE,
  PDF_TJ_TITLE as TJ_TITLE,
  assembleClassicPdf,
  pageObjects,
  paidPathPdfBytes,
} from './pdf-text-fixtures.mjs';

function twoPagePdf() {
  const page1 = `BT /F1 12 Tf 72 720 Td ${TJ_TITLE} ET`;
  const page2 = 'BT /F1 12 Tf 72 720 Td (This is page two leftover) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(page1, 'latin1')} >>\nstream\n${page1}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(page2, 'latin1')} >>\nstream\n${page2}\nendstream`,
  ];
  return assembleClassicPdf(objects);
}

function objStmPdf() {
  const content = `BT /F1 12 Tf 72 720 Td ${TJ_TITLE} ET`;
  const contentBytes = Buffer.from(content, 'latin1');
  const pageDict = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const header = `3 0 5 ${pageDict.length}\n`;
  return { objects: [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'null',
    `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
    'null',
    'placeholder-objstm',
  ], header, pageDict };
}

describe('extractPdfPageText', () => {
  it('reconstructs page-1 TJ kerning spaces for the paid-path landmark', () => {
    const pdf = assembleClassicPdf(pageObjects(`BT /F1 12 Tf 72 720 Td ${TJ_TITLE} ET`));
    const text = extractPdfPageText(pdf);
    expect(text).toContain(LANDMARK);
    expect(text).toContain(SUBTITLE);
  });

  it('inflates FlateDecode page contents before reading TJ operators', () => {
    const pdf = assembleClassicPdf(pageObjects(`BT /F1 12 Tf 72 720 Td ${TJ_TITLE} ET`, { filter: 'FlateDecode' }));
    expect(extractPdfPageText(pdf)).toContain(LANDMARK);
  });

  it('returns page 1 only, not later pages', () => {
    const text = extractPdfPageText(twoPagePdf());
    expect(text).toContain(LANDMARK);
    expect(text).not.toContain('page two leftover');
  });

  it('reads a Page dict stored in an ObjStm', () => {
    const { objects, header, pageDict } = objStmPdf();
    const fontDict = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    const stmBody = Buffer.concat([
      Buffer.from(header, 'latin1'),
      Buffer.from(pageDict, 'latin1'),
      Buffer.from(fontDict, 'latin1'),
    ]);
    const deflated = deflateSync(stmBody);
    objects[5] = `<< /Type /ObjStm /N 2 /First ${Buffer.byteLength(header, 'latin1')} /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n${deflated.toString('latin1')}\nendstream`;
    const pdf = assembleClassicPdf(objects);
    expect(extractPdfPageText(pdf)).toContain(LANDMARK);
  });

  it('does not treat /Title metadata as a substitute for page-1 text', () => {
    const objects = pageObjects('BT /F1 12 Tf 72 720 Td (Visible page body) Tj ET');
    objects.push(`<< /Title (${LANDMARK}) /Producer (test) >>`);
    const body = assembleClassicPdf(objects);
    // Rewrite trailer to point Info at obj 6 by appending is unnecessary;
    // Title lives in an extra object the page tree does not reference.
    const text = extractPdfPageText(body);
    expect(text).toContain('Visible page body');
    expect(text).not.toContain(LANDMARK);
  });

  it('returns empty string for non-PDF bytes', () => {
    expect(extractPdfPageText(Buffer.from('<html>not a pdf</html>'))).toBe('');
  });

  it('reads page-1 landmark from the paid-path arXiv PDF when bytes are on disk', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const paid = '/tmp/pdf-probe/paper.pdf';
    if (!existsSync(paid)) return;
    const text = extractPdfPageText(readFileSync(paid));
    expect(text).toContain(LANDMARK);
    expect(text).not.toContain('chrome-cdp-ex.pdf-viewer.v1');
  });
});

describe('PDF plugin docs (#283)', () => {
  it('documents text --auto page-1 PDF reads without changing leftover-press settle', () => {
    const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
    const commands = readFileSync(new URL('../skills/chrome-cdp-ex/references/commands.md', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
    for (const text of [skill, commands, reference]) {
      expect(text).toMatch(/text --auto/);
      expect(text).toMatch(/page-1/i);
      expect(text).toContain('pdf-viewer.v1');
      expect(text).toMatch(/leftover `pdf-viewer\.v1` dump is not an AX settle baseline/i);
    }
    expect(paidPathPdfBytes().subarray(0, 5).toString()).toBe('%PDF-');
  });
});
