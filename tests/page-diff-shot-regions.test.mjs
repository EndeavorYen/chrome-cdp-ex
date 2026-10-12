import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #661: the diff-shot compare receipt gave a changed-pixel ratio and three PNG paths, so an agent had
// to open the image (or dump computed styles) to learn what changed. It now groups changed pixels
// into regions and names the element that holds each one.

// Builds the per-cell arrays the page script fills: `pixels` is a list of [x, y] changed pixels.
function cellsFor(pixels, { width, height, cell = 16 }) {
  const gridW = Math.ceil(width / cell);
  const gridH = Math.ceil(height / cell);
  const cells = {
    count: new Uint32Array(gridW * gridH),
    minX: new Int32Array(gridW * gridH).fill(width),
    minY: new Int32Array(gridW * gridH).fill(height),
    maxX: new Int32Array(gridW * gridH).fill(-1),
    maxY: new Int32Array(gridW * gridH).fill(-1),
  };
  for (const [x, y] of pixels) {
    const index = Math.floor(y / cell) * gridW + Math.floor(x / cell);
    cells.count[index]++;
    cells.minX[index] = Math.min(cells.minX[index], x);
    cells.minY[index] = Math.min(cells.minY[index], y);
    cells.maxX[index] = Math.max(cells.maxX[index], x);
    cells.maxY[index] = Math.max(cells.maxY[index], y);
  }
  return { cells, gridW, gridH };
}

const rect = (x0, y0, x1, y1) => {
  const pixels = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pixels.push([x, y]);
  return pixels;
};

// The page script's clustering function, run as the page runs it.
const diffShotRegions = (...args) => runInNewContext(`${T.diffShotRegionsSource()}; diffShotRegions`)(...args);

describe('#661 diff-shot groups changed pixels into regions', () => {
  it('returns one box per separate blob, exact to the changed pixels, largest first', () => {
    const { cells, gridW, gridH } = cellsFor([...rect(10, 10, 49, 29), ...rect(200, 100, 299, 179)], { width: 400, height: 300 });
    const regions = diffShotRegions(cells, gridW, gridH, 2).map(({ cells: _cells, ...region }) => region);
    expect(regions).toEqual([
      { x: 200, y: 100, width: 100, height: 80, changedPixels: 8000 },
      { x: 10, y: 10, width: 40, height: 20, changedPixels: 800 },
    ]);
  });

  it('joins blobs in touching cells, diagonals included', () => {
    const { cells, gridW, gridH } = cellsFor([...rect(0, 0, 15, 15), ...rect(16, 16, 31, 31)], { width: 64, height: 64 });
    const regions = diffShotRegions(cells, gridW, gridH, 2);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ x: 0, y: 0, width: 32, height: 32, changedPixels: 512 });
    expect(regions[0].cells.sort((a, b) => a - b)).toEqual([0, 5]);
  });

  it('ignores a cell with a single stray pixel', () => {
    const { cells, gridW, gridH } = cellsFor([[5, 5], ...rect(40, 40, 47, 47)], { width: 64, height: 64 });
    expect(diffShotRegions(cells, gridW, gridH, 2).map(region => region.changedPixels)).toEqual([64]);
  });
});

describe('#661 diff-shot region labels are page text', () => {
  const label = (text, labelCut = false) => T.diffShotReceiptRegion({ x: 0, element: { selector: '<DIV>', label: text, labelCut } }).element.label;

  it('redacts a secret before the label is cut to 40 characters', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(label(`Session ${jwt}`)).toBe('Session <redacted>');
    expect(label('api_key: sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c')).toBe('api_key: <redacted>');
  });

  it('cuts a long label, and marks one the page already cut', () => {
    expect(label('Quarterly revenue by region and product line for the fiscal year')).toBe('Quarterly revenue by region and product…');
    expect(label('Revenue', true)).toBe('Revenue…');
    expect(T.diffShotReceiptRegion({ x: 0, element: null }).element).toBeNull();
  });

  it('redacts the label of the named ancestor too', () => {
    const element = { selector: '<DIV.n>', label: '1,388', labelCut: false, within: { selector: '<SECTION.card>', label: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', labelCut: false } };
    expect(T.diffShotReceiptRegion({ x: 0, element }).element).toEqual({
      selector: '<DIV.n>', label: '1,388', within: { selector: '<SECTION.card>', label: 'token=<redacted>' },
    });
  });
});

describe('#661 diff-shot receipts', () => {
  const compare = extra => ({
    schema: 'chrome-cdp-ex.diff-shot.v1',
    targetId: 'EF3792B90843D7C5FFE7B2D9F80D554E',
    baselineCaptured: false,
    baselinePath: '/tmp/base.png',
    currentPath: '/tmp/current.png',
    diffPath: '/tmp/diff.png',
    width: 1252,
    height: 799,
    changedPixels: 76660,
    totalPixels: 1000348,
    changedRatio: 0.0766,
    thresholdRatio: 0,
    exceedsThreshold: true,
    advancedBaseline: true,
    fallback: false,
    ...extra,
  });

  it('names each changed region with its element, box and pixel count, after the ratio', () => {
    const out = T.formatDiffShotResult(compare({
      regionCount: 3,
      regions: [
        { x: 156, y: 184, width: 462, height: 150, changedPixels: 68108, element: { selector: '<SECTION#w-revenue>', label: 'Revenue' }, contained: true },
        { x: 156, y: 135, width: 145, height: 35, changedPixels: 4731, element: { selector: '<BUTTON#apply-theme>', label: 'Apply new theme' }, contained: true },
        { x: 156, y: 366, width: 462, height: 150, changedPixels: 3820, element: { selector: '<SECTION#w-churn>', label: 'Churn' }, contained: true },
      ],
    }));
    expect(out.split('\n').slice(0, 5)).toEqual([
      'Diff-shot: changed 76660/1000348 px (7.66%)',
      'Changed regions (3):',
      '  <SECTION#w-revenue> "Revenue" at 156,184 462×150 (68108 px)',
      '  <BUTTON#apply-theme> "Apply new theme" at 156,135 145×35 (4731 px)',
      '  <SECTION#w-churn> "Churn" at 156,366 462×150 (3820 px)',
    ]);
    expect(out).toContain('Diff image: /tmp/diff.png');
  });

  it('says how many regions were left out, and marks one no element holds', () => {
    const lines = T.formatDiffShotRegionLines(compare({
      regionCount: 9,
      regions: [
        { x: 0, y: 0, width: 1252, height: 799, changedPixels: 900000, element: { selector: '<HTML>', label: '' }, contained: false },
        { x: 21, y: 112, width: 226, height: 142, changedPixels: 2180, element: { selector: '<SECTION#c-orders>', label: 'Orders' }, contained: false },
      ],
    }));
    expect(lines).toEqual([
      'Changed regions (2 of 9):',
      '  around <HTML> at 0,0 1252×799 (900000 px)',
      '  around <SECTION#c-orders> "Orders" at 21,112 226×142 (2180 px)',
    ]);
  });

  it('shows an unnamed element in its nearest named ancestor', () => {
    const lines = T.formatDiffShotRegionLines(compare({
      regionCount: 2,
      regions: [
        { x: 64, y: 159, width: 52, height: 25, changedPixels: 728, element: { selector: '<DIV.n>', label: '1,388', within: { selector: '<SECTION#c-orders>', label: 'Orders' } }, contained: true },
        { x: 342, y: 133, width: 10, height: 10, changedPixels: 88, element: { selector: '<SPAN.dot>', label: '', within: { selector: '<SECTION#c-refunds>', label: 'Refunds' } }, contained: true },
      ],
    }));
    expect(lines.slice(1)).toEqual([
      '  <DIV.n> "1,388" in <SECTION#c-orders> "Orders" at 64,159 52×25 (728 px)',
      '  <SPAN.dot> in <SECTION#c-refunds> "Refunds" at 342,133 10×10 (88 px)',
    ]);
  });

  it('says so when nothing changed, or when every changed pixel is a stray one', () => {
    expect(T.formatDiffShotRegionLines(compare({ changedPixels: 0, regions: [], regionCount: 0 }))).toEqual(['Changed regions: none']);
    expect(T.formatDiffShotRegionLines(compare({ changedPixels: 37, regions: [], regionCount: 0 })))
      .toEqual(['Changed regions: none; each changed pixel is alone in its 16 px cell']);
  });

  it('points the baseline Next at the 8-character prefix and says what to do before it', () => {
    const out = T.formatDiffShotResult({ ...compare(), baselineCaptured: true, diffPath: null, changedPixels: 0, totalPixels: 0 });
    expect(out.split('\n').slice(1)).toEqual([
      'Make the change to compare, then run diff-shot again: it names the regions that changed.',
      'Next: cdp diff-shot EF3792B9',
    ]);
  });
});
