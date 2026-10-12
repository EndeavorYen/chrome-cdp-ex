import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// parseTextArgs / textPageScript / textStr — fallback chain + --auto
// =========================================================================

describe('parseTextArgs', () => {
  const { parseTextArgs } = T;

  it('parses a single CSS selector', () => {
    expect(parseTextArgs(['main']).selectors).toEqual(['main']);
  });

  it('parses comma fallback selectors into an ordered chain', () => {
    expect(parseTextArgs(['main, [role=main], #app .main']).selectors)
      .toEqual(['main', '[role=main]', '#app .main']);
  });

  it('parses --auto', () => {
    const opts = parseTextArgs(['--auto']);
    expect(opts.auto).toBe(true);
    expect(opts.selectors).toEqual([]);
  });

  it('parses --auto with --exclude', () => {
    const opts = parseTextArgs(['--auto', '--exclude', 'nav,.sidebar']);
    expect(opts.auto).toBe(true);
    expect(opts.exclude).toBe('nav,.sidebar');
  });

  it('parses --root auto/default scope', () => {
    expect(parseTextArgs(['--root', 'auto']).root).toBe('auto');
    expect(parseTextArgs(['--root', '#root', 'header']).selectors).toEqual(['header']);
  });
});

describe('textPageScript', () => {
  const { textPageScript } = T;

  it('embeds the selector chain into the script', () => {
    const script = textPageScript({ selectors: ['main', '[role=main]'] });
    expect(script).toContain('"main"');
    expect(script).toContain('"[role=main]"');
  });

  it('strips nav/aside/footer when auto=true', () => {
    const script = textPageScript({ selectors: [], auto: true });
    expect(script).toContain('nav');
    expect(script).toContain('aside');
    expect(script).toContain('footer');
  });

  it('embeds extra exclude selectors when provided', () => {
    const script = textPageScript({ selectors: [], auto: true, exclude: '.sidebar,.banner' });
    expect(script).toContain('.sidebar');
    expect(script).toContain('.banner');
  });

  it('uses app-root candidates and header fallback selectors', () => {
    const script = textPageScript({ selectors: ['header'], root: 'auto' });
    expect(script).toContain("['#root', '[data-reactroot]', 'main', 'body']");
    expect(script).toContain("'[role=\"banner\"]'");
    expect(script).toContain("'h1'");
  });
});

describe('textStr', () => {
  const { textStr } = T;

  it('returns extracted text from the first matching selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, sel: 'main', text: 'Hello' }) } }),
    });
    const out = await textStr(cdp, 'sid1', ['main, [role=main]']);
    expect(out).toBe('Hello');
  });

  it('throws an actionable error when no selector matches', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: false, tried: ['main', '[role=main]'] }) } }),
    });
    await expect(textStr(cdp, 'sid1', ['main, [role=main]']))
      .rejects.toThrow(/Tried: main, \[role=main\]/);
  });

  it('accepts legacy single-string call form', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, sel: 'body', text: 'X' }) } }),
    });
    expect(await textStr(cdp, 'sid1', 'main')).toBe('X');
  });
});
