import { describe, it, expect } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// Perceive diff baseline
// =========================================================================

describe('Perceive diff baseline', () => {
  it('formats a diff from an explicit baseline output', () => {
    const previous = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
    ].join('\n');
    const current = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
      '  [alert] Saved',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('Page: Example');
    expect(diff).toContain('+++ Added (1):');
    expect(diff).toContain('+   [alert] Saved');
  });

  it('#295 viewport @ref rect chrome is not a perceive identity change', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "LICENSE" [clickable] (24,180 160×22) @1 a[href="LICENSE"]',
    ].join('\n');
    const current = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 80/2400 (3%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "LICENSE" [clickable] (24,100 160×22) @1 a[href="LICENSE"]',
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).not.toMatch(/--- Removed/);
    expect(diff).not.toMatch(/\(24,180/);
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] tokenizer.json  @3  (24,156 160×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/tokenizer\.json/);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);
  });

  it('#297 fold-tag-only [navigation] Main is not a Removed+Added pair', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px',
      '    [link] LICENSE  @1  (24,180 160×22)',
    ].join('\n');
    const current = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 80/2400 (3%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px  ↑above fold',
      '    [link] LICENSE  @1  (24,100 160×22)',
    ].join('\n');
    expect(T.stripPerceiveIdentityChrome('  [navigation] Main  603×28px  ↑above fold'))
      .toBe(T.stripPerceiveIdentityChrome('  [navigation] Main  603×28px'));
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).not.toMatch(/--- Removed/);
    expect(diff).not.toMatch(/↑above fold/);
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
  });

  it('#297 Visible-control cap-swap summarizes membership and still prints a new file', () => {
    const chrome = [
      'Hugging Face', 'Models', 'Datasets', 'Spaces', 'Posts', 'search', 'docs', 'pricing',
    ];
    const content = [
      'MiniMaxAI', 'MiniMax-Music3', 'Copy', 'Like', 'LICENSE', 'README.md', 'config.json', 'Files',
    ];
    const header = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      ...chrome.map((label, i) => `  a role=link "${label}" [clickable] (8,${12 + i * 28} 80×22) a[href="#${label}"]`),
    ].join('\n');
    const currentHeader = header.map(line => line.replace('Scroll: 0/2400 (0%)', 'Scroll: 80/2400 (3%)'));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px  ↑above fold',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      ...content.map((label, i) => `  a role=link "${label}" [clickable] (8,${40 + i * 28} 80×22) a[href="#${label}"]`),
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(diff).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(diff).toContain('- Hugging Face');
    expect(diff).toContain('+ MiniMaxAI');
    expect(diff).not.toMatch(/--- Removed \(9\)/);
    expect(diff).not.toMatch(/a role=link "Hugging Face"/);
    expect(diff).not.toMatch(/\[navigation\] Main/);
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] tokenizer.json  @3  (24,156 160×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/tokenizer\.json/);
    expect(changed).toMatch(/Visible-control cap swap: 8 left, 8 entered/);
    expect(changed).not.toMatch(/a role=link "Hugging Face"/);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);

    const model = T.buildPerceiveDiffModel(previous, current, { mode: 'since-action' });
    expect(model.summary.changed).toBe(true);
    expect(model.summary.kind).toBe('visible-control-cap-swap');
    expect(model.summary.headline).toBe('Visible-control cap swap: 8 left, 8 entered');
    expect(model.removed).toEqual(expect.arrayContaining(['Hugging Face']));
    expect(model.added).toEqual(expect.arrayContaining(['MiniMaxAI']));
    expect(model.removed.length).toBeLessThanOrEqual(4);
  });

  it('#299 unlabeled Visible-control cap-swap samples prefer named labels and stay changed', () => {
    // Live collector always sets label to ariaLabel || title || text || role ||
    // tagName, so dumps are `img "img"` / `a role=link "link"`, not `img [clickable]`.
    const unnamedImg = T.formatVisibleControlLine({ tag: 'img', label: 'img', clickable: true });
    const unnamedDiv = T.formatVisibleControlLine({ tag: 'div', label: 'div', clickable: true });
    const unnamedLink = T.formatVisibleControlLine({ tag: 'a', role: 'link', label: 'link', clickable: true });
    const namedHf = T.formatVisibleControlLine({ tag: 'a', role: 'link', label: 'Hugging Face', clickable: true });
    expect(unnamedImg).toBe('img "img" [clickable]');
    expect(unnamedDiv).toBe('div "div" [clickable]');
    expect(unnamedLink).toBe('a role=link "link" [clickable]');
    expect(T.visibleControlNameFromLine(unnamedImg)).toEqual({ name: 'img', named: false });
    expect(T.visibleControlNameFromLine(unnamedDiv)).toEqual({ name: 'div', named: false });
    expect(T.visibleControlNameFromLine(`  ${unnamedLink} (8,68 24×24) a[href="/"]`))
      .toEqual({ name: 'link', named: false });
    expect(T.visibleControlNameFromLine(namedHf)).toEqual({ name: 'Hugging Face', named: true });
    const liveLine = (control) => `  ${T.formatVisibleControlLine({
      clickable: true,
      rect: { x: 8, y: control.y, w: 24, h: 24 },
      hints: { id: '', classes: [] },
      ...control,
    })}`;
    const header = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '',
      '[Visible controls]',
      liveLine({ tag: 'img', label: 'img', selector: 'img.logo', y: 12 }),
      liveLine({ tag: 'div', label: 'div', selector: 'div.nav-icon', y: 40 }),
      liveLine({ tag: 'a', role: 'link', label: 'link', selector: 'a[href="/"]', y: 68 }),
      liveLine({ tag: 'a', role: 'link', label: 'Hugging Face', selector: 'a[href="#hf"]', y: 100 }),
      liveLine({ tag: 'a', role: 'link', label: 'Models', selector: 'a[href="#models"]', y: 128 }),
      liveLine({ tag: 'a', role: 'link', label: 'Datasets', selector: 'a[href="#datasets"]', y: 156 }),
      liveLine({ tag: 'a', role: 'link', label: 'search', selector: 'a[href="#search"]', y: 184 }),
    ].join('\n');
    const currentHeader = header.map(line => line.replace('Scroll: 0/2400 (0%)', 'Scroll: 80/2400 (3%)'));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '  [navigation] Main  603×28px  ↑above fold',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '',
      '[Visible controls]',
      liveLine({ tag: 'img', label: 'img', selector: 'img.hero', y: 12 }),
      liveLine({ tag: 'div', label: 'div', selector: 'div.body-icon', y: 40 }),
      liveLine({ tag: 'a', role: 'link', label: 'link', selector: 'a[href="/model"]', y: 68 }),
      liveLine({ tag: 'a', role: 'link', label: 'MiniMaxAI', selector: 'a[href="#mm"]', y: 100 }),
      liveLine({ tag: 'a', role: 'link', label: 'Text-to-Audio', selector: 'a[href="#tta"]', y: 128 }),
      liveLine({ tag: 'a', role: 'link', label: 'Diffusers', selector: 'a[href="#diff"]', y: 156 }),
      liveLine({ tag: 'a', role: 'link', label: 'Like', selector: 'a[href="#like"]', y: 184 }),
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(diff).toMatch(/Visible-control cap swap: 7 left, 7 entered/);
    const removedSamples = [...diff.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...diff.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples[0]).toBe('Hugging Face');
    expect(addedSamples[0]).toBe('MiniMaxAI');
    expect(diff).toContain('- Hugging Face');
    expect(diff).toContain('+ MiniMaxAI');
    expect(diff).toContain('+ Text-to-Audio');
    expect(removedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(addedSamples).not.toEqual(expect.arrayContaining(['img', 'div', 'link', 'a']));
    expect(diff).not.toMatch(/^[-+] (?:img|div|link|a)\b/m);
    expect(diff).not.toMatch(/img\.logo|div\.nav-icon|img\.hero|div\.body-icon/);
    expect(diff).not.toMatch(/--- Removed/);
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).not.toMatch(/no changes detected/i);

    const model = T.buildPerceiveDiffModel(previous, current, { mode: 'since-action' });
    expect(model.summary.changed).toBe(true);
    expect(model.summary.kind).toBe('visible-control-cap-swap');
    expect(model.summary.headline).toBe('Visible-control cap swap: 7 left, 7 entered');
    expect(model.removed[0]).toBe('Hugging Face');
    expect(model.added[0]).toBe('MiniMaxAI');
    expect(model.removed).toEqual(expect.arrayContaining(['Hugging Face']));
    expect(model.added).toEqual(expect.arrayContaining(['MiniMaxAI']));
    expect(model.removed.some(label => /^(?:img|div|link|a)$/i.test(String(label)))).toBe(false);
    expect(model.added.some(label => /^(?:img|div|link|a)$/i.test(String(label)))).toBe(false);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('changed');
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
  });

  it('#301 leftover-ax-scroll changed receipt drops generic Recovery hint and stays changed', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 160/2400 (7%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "Text-to-Audio" [clickable] (8,100 80×24) a[href="#tta"]',
      '  a role=link "Diffusers" [clickable] (8,128 80×24) a[href="#diff"]',
    ].join('\n');
    const current = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 240/2400 (10%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "MiniMax-Music3" [clickable] (8,100 80×24) a[href="#mm"]',
      '  a role=link "Go to file" [clickable] (8,128 80×24) a[href="#file"]',
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).toMatch(/Visible-control cap swap:/);
    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 240)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(receipt).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 240). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).not.toMatch(/^Outcome:/m);

    const genericChanged = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [StaticText] Saved', console: [], network: [], navigation: null },
    });
    expect(genericChanged.outcome.status).toBe('changed');
    expect(genericChanged.receipt.recoveryHint).toBe('Continue from the observed action evidence.');
    expect(T.formatActionResultOutput(genericChanged, { dispatchText: 'Clicked Save' }))
      .toBe('Clicked Save. Next: cdp perceive ABC123 --since-action');
  });

  it('#303 leftover-ax-scroll +++ Added does not reprint signed-commit / time GMT selector chrome', () => {
    const signed = T.formatVisibleControlLine({
      tag: 'span',
      label: 'This commit is signed and the signature is verified',
      title: 'This commit is signed and the signature is verified',
      selector: 'span[title="This commit is signed and the signature is verified"]',
      hints: { classes: ['mx-2', 'text-green-500', 'dark:text-green-600'] },
    });
    const timeGmt = T.formatVisibleControlLine({
      tag: 'time',
      label: 'Fri, 14 Aug 2026 10:51:40 GMT',
      title: 'Fri, 14 Aug 2026 10:51:40 GMT',
      selector: 'time[title="Fri, 14 Aug 2026 10:51:40 GMT"]',
      hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
    });
    expect(signed).toBe(
      'span "This commit is signed and the signature is verified" span[title="This commit is signed and the signature is verified"] .mx-2.text-green-500.dark:text-green-600',
    );
    expect(timeGmt).toBe(
      'time "Fri, 14 Aug 2026 10:51:40 GMT" time[title="Fri, 14 Aug 2026 10:51:40 GMT"] .ml-auto.hidden.flex-none',
    );
    expect(T.stripPerceiveIdentityChrome(`  ${signed}`).trim())
      .toBe('span "This commit is signed and the signature is verified"');
    expect(T.stripPerceiveIdentityChrome(`  ${timeGmt}`).trim())
      .toBe('time "Fri, 14 Aug 2026 10:51:40 GMT"');
    expect(T.isPerceiveDecorativeTitleChrome(`  ${signed}`)).toBe(true);
    expect(T.isPerceiveDecorativeTitleChrome(`  ${timeGmt}`)).toBe(true);
    expect(T.isPerceiveDecorativeTitleChrome('    [link] Update README.md  @3  (24,156 160×22)')).toBe(false);
    expect(T.isPerceiveDecorativeTitleChrome('  a role=link "assets" [clickable] (8,184 80×22) a[href="#assets"]')).toBe(false);

    const header = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "main" [clickable] (8,72 80×22) a[href="#main"]',
      '  a role=link "MiniMax-Music3" [clickable] (8,100 80×22) a[href="#mm"]',
      '  a role=link "Go to file" [clickable] (8,128 80×22) a[href="#file"]',
      '  a role=link "4 contributors" [clickable] (8,156 80×22) a[href="#contrib"]',
    ].join('\n');
    const currentHeader = header.map(line => line.replace('Scroll: 0/2400 (0%)', 'Scroll: 80/2400 (3%)'));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      `  ${signed}`,
      `  ${timeGmt}`,
      '  a role=link "ryanlee-dev" [clickable] (8,100 80×22) a[href="#ryan"]',
      '  a role=link "Update README.md" [clickable] (8,128 80×22) a[href="#readme"]',
      '  a role=link "fbdf52f" [clickable] (8,156 80×22) a[href="#sha"]',
      '  a role=link "assets" [clickable] (8,184 80×22) a[href="#assets"]',
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(diff).toContain('- main');
    expect(diff).toContain('- MiniMax-Music3');
    expect(diff).toContain('+ ryanlee-dev');
    expect(diff).toContain('+ Update README.md');
    expect(diff).toContain('+ fbdf52f');
    expect(diff).toContain('+ assets');
    expect(diff).not.toMatch(/\+\+\+ Added/);
    expect(diff).not.toMatch(/span\[title=/);
    expect(diff).not.toMatch(/time\[title=/);
    expect(diff).not.toMatch(/This commit is signed/);
    expect(diff).not.toMatch(/10:51:40 GMT/);
    expect(diff).not.toMatch(/\.mx-2\.text-green-500/);
    expect(diff).not.toMatch(/\.ml-auto\.hidden/);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] config.json  @3  (24,156 160×22)\n    [link] assets  @4  (24,184 160×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/config\.json/);
    expect(changed).toMatch(/\[link\] assets/);
    expect(changed).toMatch(/Visible-control cap swap:/);
    expect(changed).not.toMatch(/span\[title=/);
    expect(changed).not.toMatch(/This commit is signed/);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);

    const titleOnly = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "main" [clickable] (8,72 80×22) a[href="#main"]',
      '  a role=link "MiniMax-Music3" [clickable] (8,100 80×22) a[href="#mm"]',
      '  a role=link "Go to file" [clickable] (8,128 80×22) a[href="#file"]',
      '  a role=link "4 contributors" [clickable] (8,156 80×22) a[href="#contrib"]',
      `  ${signed}`,
      `  ${timeGmt}`,
    ].join('\n');
    const noChange = T.formatPerceiveDiffOutput(previous, titleOnly, { mode: 'since-action' });
    expect(noChange).toMatch(/no changes detected in AX tree/i);
    expect(noChange).not.toMatch(/\+\+\+ Added/);
    expect(noChange).not.toMatch(/span\[title=/);
    expect(T.actionDomDiffShowsChange(noChange)).toBe(false);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 80)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap:/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/span\[title=/);
    expect(text).not.toMatch(/This commit is signed/);
    expect(receipt).not.toMatch(/\+\+\+ Added/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
  });

  it('#305 leftover-ax-scroll cap-swap samples skip relative-time / GMT and stay changed', () => {
    // Live leftover-ax-scroll named samples after overlay 3577e604. HF file-row
    // `<a>…<time title="Thu, 13 Aug 2026 15:18:27 GMT">2 days ago</time></a>`:
    // collector label for <a> is inner text; <time> label is title (title wins).
    const relativeTime = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: '2 days ago',
      clickable: true,
      rect: { x: 720, y: 184, w: 72, h: 16 },
      selector: 'a.truncate',
      hints: { classes: ['truncate'] },
    });
    const timeGmt = T.formatVisibleControlLine({
      tag: 'time',
      label: 'Thu, 13 Aug 2026 15:18:27 GMT',
      title: 'Thu, 13 Aug 2026 15:18:27 GMT',
      clickable: true,
      rect: { x: 800, y: 184, w: 72, h: 16 },
      selector: 'time[title="Thu, 13 Aug 2026 15:18:27 GMT"]',
      hints: { classes: ['ml-auto', 'hidden', 'flex-none'] },
    });
    expect(relativeTime).toBe('a role=link "2 days ago" [clickable] (720,184 72×16) a.truncate .truncate');
    expect(timeGmt).toBe(
      'time "Thu, 13 Aug 2026 15:18:27 GMT" [clickable] (800,184 72×16) time[title="Thu, 13 Aug 2026 15:18:27 GMT"] .ml-auto.hidden.flex-none',
    );
    expect(T.visibleControlNameFromLine(`  ${relativeTime}`))
      .toEqual({ name: '2 days ago', named: false });
    expect(T.visibleControlNameFromLine(`  ${timeGmt}`))
      .toEqual({ name: 'Thu, 13 Aug 2026 15:18:27 GMT', named: false });
    expect(T.isVisibleControlTimestampName('2 days ago')).toBe(true);
    expect(T.isVisibleControlTimestampName('Thu, 13 Aug 2026 15:18:27 GMT')).toBe(true);
    expect(T.visibleControlNameFromLine('  a role=link "main" [clickable] (8,72 80×22) a[href="#main"]'))
      .toEqual({ name: 'main', named: true });
    expect(T.visibleControlNameFromLine('  a role=link "condition_encoder" [clickable] (8,100 80×22) a[href="#enc"]'))
      .toEqual({ name: 'condition_encoder', named: true });
    expect(T.isPerceiveDecorativeTitleChrome(`  ${relativeTime}`)).toBe(false);
    expect(T.isPerceiveDecorativeTitleChrome(`  ${timeGmt}`)).toBe(false);

    const header = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 320/2400 (13%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "ryanlee-dev" [clickable] (8,100 80×22) a[href="#ryan"]',
      '  a role=link "Update README.md" [clickable] (8,128 80×22) a[href="#readme"]',
      '  a role=link "fbdf52f" [clickable] (8,156 80×22) a[href="#sha"]',
      '  a role=link "assets" [clickable] (8,184 80×22) a[href="#assets"]',
    ].join('\n');
    const currentHeader = header.map(line => line.replace('Scroll: 320/2400 (13%)', 'Scroll: 400/2400 (17%)'));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "condition_encoder" [clickable] (8,100 80×22) a[href="#enc"]',
      '  a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (8,128 80×22) a[href="#commit"]',
      `  ${relativeTime}`,
      `  ${timeGmt}`,
      '  a role=link "config.json" [clickable] (8,212 80×22) a[href="#config"]',
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(diff).toContain('- ryanlee-dev');
    expect(diff).toContain('- Update README.md');
    expect(diff).toContain('- fbdf52f');
    expect(diff).toContain('- assets');
    expect(diff).toContain('+ condition_encoder');
    expect(diff).toContain('+ Add diffusers weights (modular pipeline) (#2)');
    expect(diff).toContain('+ config.json');
    const addedSamples = [...diff.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(addedSamples).toEqual([
      'condition_encoder',
      'Add diffusers weights (modular pipeline) (#2)',
      'config.json',
    ]);
    expect(diff).not.toMatch(/^\+ 2 days ago$/m);
    expect(diff).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(diff).not.toMatch(/\+\+\+ Added/);
    expect(diff).not.toMatch(/span\[title=/);
    expect(diff).not.toMatch(/time\[title=/);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] config.json  @3  (24,156 160×22)\n    [heading] Files and versions  @4  (24,184 200×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/\[link\] config\.json/);
    expect(changed).toMatch(/\[heading\] Files and versions/);
    expect(changed).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(changed).not.toMatch(/^\+ 2 days ago$/m);
    expect(changed).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);

    const model = T.buildPerceiveDiffModel(previous, current, { mode: 'since-action' });
    expect(model.summary.changed).toBe(true);
    expect(model.summary.kind).toBe('visible-control-cap-swap');
    expect(model.summary.headline).toBe('Visible-control cap swap: 4 left, 5 entered');
    expect(model.added).toEqual([
      'condition_encoder',
      'Add diffusers weights (modular pipeline) (#2)',
      'config.json',
    ]);
    expect(model.added).not.toEqual(expect.arrayContaining([
      '2 days ago',
      'Thu, 13 Aug 2026 15:18:27 GMT',
    ]));

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 400)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(text).toMatch(/\+ config\.json/);
    expect(text).not.toMatch(/^\+ 2 days ago$/m);
    expect(text).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(text).not.toMatch(/span\[title=/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 400). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^\+ 2 days ago$/m);
    expect(receipt).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);
  });

  it('#307 leftover-ax-scroll cap-swap samples skip a shared commit title on both sides', () => {
    // Live leftover-ax-scroll named samples after overlay f9fa4971. HF file-row
    // commit links share the title `Add diffusers weights (modular pipeline) (#2)`
    // but keep distinct hrefs, so identity-chrome strip still treats them as
    // left AND entered membership. The 4-sample picker must not spend a named
    // slot on both sides; unique file names fill the cap.
    const commitLeft = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'Add diffusers weights (modular pipeline) (#2)',
      clickable: true,
      rect: { x: 8, y: 128, w: 280, h: 22 },
      selector: 'a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]',
    });
    const commitEntered = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'Add diffusers weights (modular pipeline) (#2)',
      clickable: true,
      rect: { x: 8, y: 128, w: 280, h: 22 },
      selector: 'a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]',
    });
    expect(commitLeft).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (8,128 280×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]',
    );
    expect(commitEntered).toBe(
      'a role=link "Add diffusers weights (modular pipeline) (#2)" [clickable] (8,128 280×22) a[href="/MiniMaxAI/MiniMax-Music3/commit/entered"]',
    );
    expect(T.visibleControlNameFromLine(`  ${commitLeft}`))
      .toEqual({ name: 'Add diffusers weights (modular pipeline) (#2)', named: true });
    expect(T.visibleControlNameFromLine(`  ${commitEntered}`))
      .toEqual({ name: 'Add diffusers weights (modular pipeline) (#2)', named: true });
    expect(T.visibleControlNameFromLine('  a role=link "main" [clickable] (8,72 80×22) a[href="#main"]'))
      .toEqual({ name: 'main', named: true });
    expect(T.visibleControlNameFromLine('  a role=link "condition_encoder" [clickable] (8,100 80×22) a[href="#enc"]'))
      .toEqual({ name: 'condition_encoder', named: true });
    expect(T.visibleControlNameFromLine('  a role=link "tokenizer.json" [clickable] (8,184 80×22) a[href="#tok"]'))
      .toEqual({ name: 'tokenizer.json', named: true });
    expect(T.uniqueVisibleControlCapSwapSamples(
      ['condition_encoder', 'Add diffusers weights (modular pipeline) (#2)', 'figures', 'tokenizer.json'],
      ['language_model', 'Add diffusers weights (modular pipeline) (#2)', 'qwen_7B', 'speech_tokenizer'],
    )).toEqual({
      removedSamples: ['condition_encoder', 'figures', 'tokenizer.json'],
      addedSamples: ['language_model', 'qwen_7B', 'speech_tokenizer'],
    });

    const header = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 400/2400 (17%) | Focused: none',
      'Interactive: 12 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "condition_encoder" [clickable] (8,100 80×22) a[href="#enc"]',
      `  ${commitLeft}`,
      '  a role=link "figures" [clickable] (8,156 80×22) a[href="#figures"]',
      '  a role=link "tokenizer.json" [clickable] (8,184 80×22) a[href="#tok"]',
    ].join('\n');
    const currentHeader = header.map(line => line.replace('Scroll: 400/2400 (17%)', 'Scroll: 480/2400 (20%)'));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      '  a role=link "language_model" [clickable] (8,100 80×22) a[href="#lm"]',
      `  ${commitEntered}`,
      '  a role=link "qwen_7B" [clickable] (8,156 80×22) a[href="#qwen"]',
      '  a role=link "speech_tokenizer" [clickable] (8,184 80×22) a[href="#speech"]',
    ].join('\n');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(diff).toContain('- condition_encoder');
    expect(diff).toContain('- figures');
    expect(diff).toContain('- tokenizer.json');
    expect(diff).toContain('+ language_model');
    expect(diff).toContain('+ qwen_7B');
    expect(diff).toContain('+ speech_tokenizer');
    const removedSamples = [...diff.matchAll(/^- (.+)$/gm)].map(match => match[1]);
    const addedSamples = [...diff.matchAll(/^\+ (.+)$/gm)].map(match => match[1]);
    expect(removedSamples).toEqual([
      'condition_encoder',
      'figures',
      'tokenizer.json',
    ]);
    expect(addedSamples).toEqual([
      'language_model',
      'qwen_7B',
      'speech_tokenizer',
    ]);
    expect(diff).toMatch(/ {2}\.\.\. and 1 more left/);
    expect(diff).toMatch(/ {2}\.\.\. and 1 more entered/);
    expect(diff).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(diff).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(diff).not.toMatch(/\+\+\+ Added/);
    expect(diff).not.toMatch(/span\[title=/);
    expect(diff).not.toMatch(/time\[title=/);
    expect(diff).not.toMatch(/^\+ 2 days ago$/m);
    expect(diff).not.toMatch(/^\+ Thu, 13 Aug 2026 15:18:27 GMT$/m);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] config.json  @3  (24,156 160×22)\n    [heading] Files and versions  @4  (24,184 200×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/\[link\] config\.json/);
    expect(changed).toMatch(/\[heading\] Files and versions/);
    expect(changed).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(changed).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(changed).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);

    const model = T.buildPerceiveDiffModel(previous, current, { mode: 'since-action' });
    expect(model.summary.changed).toBe(true);
    expect(model.summary.kind).toBe('visible-control-cap-swap');
    expect(model.summary.headline).toBe('Visible-control cap swap: 4 left, 4 entered');
    expect(model.removed).toEqual([
      'condition_encoder',
      'figures',
      'tokenizer.json',
    ]);
    expect(model.added).toEqual([
      'language_model',
      'qwen_7B',
      'speech_tokenizer',
    ]);
    expect(model.removed).not.toEqual(expect.arrayContaining([
      'Add diffusers weights (modular pipeline) (#2)',
    ]));
    expect(model.added).not.toEqual(expect.arrayContaining([
      'Add diffusers weights (modular pipeline) (#2)',
    ]));

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 480)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/Outcome: changed/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 4 entered/);
    expect(text).toMatch(/- tokenizer\.json/);
    expect(text).toMatch(/\+ speech_tokenizer/);
    expect(text).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(text).not.toMatch(/span\[title=/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 480). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^- Add diffusers weights \(modular pipeline\) \(#2\)$/m);
    expect(receipt).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);
  });

  it('#309 leftover-ax-scroll changed receipt drops Interactive/Coords census and Outcome tautology', () => {
    // Live leftover-ax-scroll ActionResult after overlay cd661234. Cap-swap is
    // already honest changed / named / unique. The leftover chrome is the
    // unchanged Interactive census + clickxy Coords tutorial, plus Outcome /
    // Receipt / Verdict reprinting "Observed page change after action." Next
    // is already perceive -C -d 8, not clickxy.
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const languageModel = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'language_model',
      clickable: true,
      rect: { x: 8, y: 100, w: 160, h: 22 },
      selector: 'a[href="#lm"]',
    });
    const commitLeft = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'Add diffusers weights (modular pipeline) (#2)',
      clickable: true,
      rect: { x: 8, y: 128, w: 280, h: 22 },
      selector: 'a[href="/MiniMaxAI/MiniMax-Music3/commit/left"]',
    });
    const imgLeft = T.formatVisibleControlLine({
      tag: 'img',
      label: 'img',
      clickable: true,
      rect: { x: 8, y: 156, w: 24, h: 24 },
      selector: 'img.logo',
    });
    const divLeft = T.formatVisibleControlLine({
      tag: 'div',
      label: 'div',
      clickable: true,
      rect: { x: 8, y: 184, w: 24, h: 24 },
      selector: 'div.nav-icon',
    });
    const qwen = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'qwen_7B',
      clickable: true,
      rect: { x: 8, y: 100, w: 160, h: 22 },
      selector: 'a[href="#qwen"]',
    });
    const upload = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'Add files using upload-large-folder tool',
      clickable: true,
      rect: { x: 8, y: 128, w: 280, h: 22 },
      selector: 'a[href="#upload"]',
    });
    const rvq = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'rvq_depth_decoder',
      clickable: true,
      rect: { x: 8, y: 156, w: 160, h: 22 },
      selector: 'a[href="#rvq"]',
    });
    const linkEntered = T.formatVisibleControlLine({
      tag: 'a',
      role: 'link',
      label: 'link',
      clickable: true,
      rect: { x: 8, y: 184, w: 24, h: 24 },
      selector: 'a[href="/model"]',
    });
    const buttonEntered = T.formatVisibleControlLine({
      tag: 'button',
      role: 'button',
      label: 'button',
      clickable: true,
      rect: { x: 8, y: 212, w: 24, h: 24 },
      selector: 'button.icon',
    });
    expect(languageModel).toContain('"language_model"');
    expect(commitLeft).toContain('"Add diffusers weights (modular pipeline) (#2)"');
    expect(qwen).toContain('"qwen_7B"');
    expect(upload).toContain('"Add files using upload-large-folder tool"');
    expect(rvq).toContain('"rvq_depth_decoder"');

    const header = [
      'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×632 | Scroll: 467/547 (85%) | Focused: none',
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const previous = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
      '    [link] README.md  @2  (24,208 160×22)',
      '',
      '[Visible controls]',
      `  ${languageModel}`,
      `  ${commitLeft}`,
      `  ${imgLeft}`,
      `  ${divLeft}`,
    ].join('\n');
    const currentHeader = header.map(line => line.replace(
      'Scroll: 467/547 (85%)',
      'Scroll: 547/547 (100%)',
    ));
    const current = [
      ...currentHeader,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
      '',
      '[Visible controls]',
      `  ${qwen}`,
      `  ${upload}`,
      `  ${rvq}`,
      `  ${linkEntered}`,
      `  ${buttonEntered}`,
    ].join('\n');
    expect(previous).toContain(LIVE_INTERACTIVE);
    expect(previous).toContain(LIVE_COORDS);
    expect(current).toContain(LIVE_INTERACTIVE);
    expect(current).toContain('Scroll: 547/547 (100%)');

    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(diff).toContain('- language_model');
    expect(diff).toContain('- Add diffusers weights (modular pipeline) (#2)');
    expect(diff).toContain('+ qwen_7B');
    expect(diff).toContain('+ Add files using upload-large-folder tool');
    expect(diff).toContain('+ rvq_depth_decoder');
    expect(diff).toMatch(/ {2}\.\.\. and 2 more left/);
    expect(diff).toMatch(/ {2}\.\.\. and 2 more entered/);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);
    expect(diff).toMatch(/^Console: clean$/m);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_INTERACTIVE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toMatch(/^Console: clean$/m);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(diff).not.toMatch(/\+\+\+ Added/);
    expect(diff).not.toMatch(/span\[title=/);
    expect(diff).not.toMatch(/time\[title=/);
    expect(diff).not.toMatch(/^\+ 2 days ago$/m);
    expect(diff).not.toMatch(/^\+ Add diffusers weights \(modular pipeline\) \(#2\)$/m);

    const addedFile = current.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] config.json  @3  (24,156 160×22)\n    [heading] Files and versions  @4  (24,184 200×22)',
    );
    const changed = T.formatPerceiveDiffOutput(previous, addedFile, { mode: 'since-action' });
    expect(changed).toMatch(/\[link\] config\.json/);
    expect(changed).toMatch(/\[heading\] Files and versions/);
    expect(changed).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(T.actionDomDiffShowsChange(changed)).toBe(true);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('changed');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(text).toMatch(/^Outcome: changed$/m);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).not.toMatch(/Observed page change after action/);
    expect(text).not.toMatch(/^Receipt: changed$/m);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).toMatch(/Page: MiniMaxAI\/MiniMax-Music3 at main/);
    expect(text).toMatch(/Viewport: 1042×632 \| Scroll: 547\/547 \(100%\)/);
    expect(text).toMatch(/Visible-control cap swap: 4 left, 5 entered/);
    expect(text).toContain('- language_model');
    expect(text).toContain('+ qwen_7B');
    expect(text).toContain('+ Add files using upload-large-folder tool');
    expect(text).toContain('+ rvq_depth_decoder');
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/\+\+\+ Added/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 547). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/^Receipt:/m);
    expect(receipt).not.toMatch(/^Verdict:/m);
    expect(receipt).not.toMatch(/Observed page change after action/);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/use clickxy with these values/);

    const genericChanged = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '+   [StaticText] Saved', console: [], network: [], navigation: null },
    });
    expect(genericChanged.outcome.status).toBe('changed');
    const clickOut = T.formatActionResultOutput(genericChanged, { dispatchText: 'Clicked Save' });
    expect(clickOut).toBe('Clicked Save. Next: cdp perceive ABC123 --since-action');
    expect(clickOut).not.toMatch(/^Outcome:/m);
    expect(clickOut).not.toMatch(/^Receipt:/m);
    expect(clickOut).not.toMatch(/^Verdict:/m);
  });

  it('#311 leftover-ax-scroll no-change receipt drops tautological Recovery hint when Next is already perceive', () => {
    // Live leftover-ax-scroll ActionResult after overlay 0546edbe (Fixes #309).
    // Bob 9224: leftover perceive 561F7DA8 -C -d 8 then scroll down 80 on HF
    // Music3 already at scrollY 547/547 (100%). Position stayed (0, 547) —
    // honest no-change, not a hidden cap-swap. Interactive / Console / Coords
    // already gone from the action receipt. Next is already perceive -C -d 8.
    // The leftover chrome is Recovery hint restating that Next command.
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const header = [
      'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×632 | Scroll: 547/547 (100%) | Focused: none',
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const dump = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
    ].join('\n');
    expect(dump).toContain(LIVE_INTERACTIVE);
    expect(dump).toContain(LIVE_COORDS);
    expect(dump).toContain('Scroll: 547/547 (100%)');

    const diff = T.formatPerceiveDiffOutput(dump, dump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_INTERACTIVE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toMatch(/no changes detected in AX tree/i);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 826 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(/Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities/);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 826ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(/Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities/);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/use clickxy with these values/);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(558);

    const genericNoChange = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(genericNoChange.outcome.status).toBe('no-change');
    expect(genericNoChange.receipt.recoveryHint).toMatch(/no visible AX tree change/i);
    expect(T.formatActionText(genericNoChange)).toMatch(/^Recovery hint:/m);
    expect(T.formatActionText(genericNoChange)).toMatch(/^Outcome: no-change — /m);
  });

  it('#313 leftover-ax-scroll no-change receipt drops settle-shape Outcome reason when Next is already perceive', () => {
    // Live leftover-ax-scroll ActionResult after overlay b302e9f9 (Fixes #311).
    // Bob 9224: leftover perceive 561F7DA8 -C -d 8 then scroll down 80 on HF
    // Music3 already at scrollY 547/547 (100%). Position stayed (0, 547) —
    // honest no-change, not a hidden cap-swap. Recovery hint is gone. Next is
    // already perceive -C -d 8. The leftover chrome is the settle-shape
    // Outcome reason essay. Body already says (no changes detected in AX tree).
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const header = [
      'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×632 | Scroll: 547/547 (100%) | Focused: none',
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const dump = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
    ].join('\n');
    expect(dump).toContain(LIVE_INTERACTIVE);
    expect(dump).toContain(LIVE_COORDS);
    expect(dump).toContain('Scroll: 547/547 (100%)');

    const diff = T.formatPerceiveDiffOutput(dump, dump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_INTERACTIVE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toMatch(/no changes detected in AX tree/i);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1527 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1527ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/use clickxy with these values/);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(476);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);

    const genericNoChange = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(genericNoChange.outcome.status).toBe('no-change');
    expect(genericNoChange.receipt.recoveryHint).toMatch(/no visible AX tree change/i);
    expect(T.formatActionText(genericNoChange)).toMatch(/^Recovery hint:/m);
    expect(T.formatActionText(genericNoChange)).toMatch(/^Outcome: no-change — /m);

    const leftoverCardsNoChange = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '2E94F948ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'cards-window-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(leftoverCardsNoChange.outcome.status).toBe('no-change');
    expect(T.formatActionText(leftoverCardsNoChange)).toMatch(
      /^Outcome: no-change — Settle shape was leftover feed --cards; virtualized window did not replace cards\.$/m,
    );

    const leftoverPdfNoChange = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'CFD023D2ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'pdf-viewer-no-change',
        resolvedBy: 'selector-or-ref',
        label: 'body',
      },
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 40 },
      effects: { domDiff: '(no changes detected in AX tree)', console: [], network: [], navigation: null },
    });
    expect(leftoverPdfNoChange.outcome.status).toBe('no-change');
    expect(T.formatActionText(leftoverPdfNoChange)).toMatch(
      /^Outcome: no-change — Settle shape was pdf-viewer\.v1/m,
    );
  });

  it('#316 leftover-ax-scroll no-change receipt drops reprinted Page/Viewport header when Next is already perceive', () => {
    // Live leftover-ax-scroll ActionResult after overlay b2fa6af8 (Fixes #313).
    // Bob 9224: leftover perceive 561F7DA8 -C -d 8 then scroll down 80 on HF
    // Music3 already at scrollY 547/547 (100%). Position stayed (0, 547) —
    // honest no-change, not a hidden cap-swap. Settle-shape Outcome suffix
    // is gone. Recovery hint is gone. Next is already perceive -C -d 8.
    // The leftover chrome is the reprinted Page / Viewport identity header.
    // Position already states scroll identity. Next perceive re-establishes
    // page identity. Do not drop Page/Viewport from leftover-ax-scroll
    // changed or from the leftover perceive dump itself.
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const LIVE_PAGE = 'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main';
    const LIVE_VIEWPORT = 'Viewport: 1042×632 | Scroll: 547/547 (100%) | Focused: none';
    const header = [
      LIVE_PAGE,
      LIVE_VIEWPORT,
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const dump = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
    ].join('\n');
    expect(dump).toContain(LIVE_PAGE);
    expect(dump).toContain(LIVE_VIEWPORT);
    expect(dump).toContain(LIVE_INTERACTIVE);
    expect(dump).toContain(LIVE_COORDS);
    expect(dump).toContain('Scroll: 547/547 (100%)');
    expect(dump).toContain('Focused: none');

    const diff = T.formatPerceiveDiffOutput(dump, dump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).toContain(LIVE_PAGE);
    expect(diff).toContain(LIVE_VIEWPORT);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toContain(LIVE_PAGE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toContain(LIVE_VIEWPORT);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_INTERACTIVE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toContain(LIVE_PAGE);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toContain(LIVE_VIEWPORT);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toMatch(/Focused:/);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).toMatch(/no changes detected in AX tree/i);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1061 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1061ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(/\(no changes detected in AX tree\)/);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(381);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);

    const addedFileDump = dump.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] tokenizer.json  @3  (24,156 160×22)',
    );
    const changedDiff = T.formatPerceiveDiffOutput(dump, addedFileDump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(changedDiff)).toBe(true);
    expect(changedDiff).toMatch(/tokenizer\.json/);
    const changed = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: changedDiff, console: [], network: [], navigation: null },
    });
    const changedText = T.formatActionText(changed);
    expect(changed.outcome.status).toBe('changed');
    expect(changed.receipt.recoveryHint).toBeNull();
    expect(changedText).toMatch(/^Outcome: changed$/m);
    expect(changedText).not.toMatch(/^Outcome: no-change$/m);
    expect(changedText).toMatch(/^Page:/m);
    expect(changedText).toMatch(/^Viewport:/m);
    expect(changedText).toMatch(/tokenizer\.json/);
    expect(changedText).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(changedText).not.toMatch(/^Recovery hint:/m);

    const leftoverCardsWithHeader = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '2E94F948ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'cards-window-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: [
          'Page: X feed — https://x.com/home',
          'Viewport: 1042×632 | Scroll: 80/800 (10%) | Focused: none',
          'chrome-cdp-ex.cards.v1  2 cards  virtualized',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverCardsWithHeader.outcome.status).toBe('no-change');
    const cardsText = T.formatActionText(leftoverCardsWithHeader);
    expect(cardsText).toMatch(/^Page: X feed/m);
    expect(cardsText).toMatch(/^Viewport: 1042×632/m);
    expect(cardsText).toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(cardsText).toMatch(/Next: cdp perceive 2E94F948 --cards/);

    const leftoverPdfWithHeader = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'CFD023D2ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'pdf-viewer-no-change',
        resolvedBy: 'selector-or-ref',
        label: 'body',
      },
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: paper.pdf — https://example.com/paper.pdf',
          'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
          'chrome-cdp-ex.pdf-viewer.v1',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverPdfWithHeader.outcome.status).toBe('no-change');
    const pdfText = T.formatActionText(leftoverPdfWithHeader);
    expect(pdfText).toMatch(/^Page: paper\.pdf/m);
    expect(pdfText).toMatch(/^Viewport: 1042×632/m);
    expect(pdfText).toMatch(/chrome-cdp-ex\.pdf-viewer\.v1/);

    const genericNoChangeWithHeader = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: Example — https://example.com',
          'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(genericNoChangeWithHeader.outcome.status).toBe('no-change');
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Page: Example/m);
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Viewport: 1280×720/m);
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Outcome: no-change — /m);
  });

  it('#318 leftover-ax-scroll no-change receipt drops tautological AX body when Next is already perceive', () => {
    // Live leftover-ax-scroll ActionResult after overlay a972d528 (Fixes #316).
    // Bob 9224: leftover perceive 561F7DA8 -C -d 8 then scroll down 80 on HF
    // Music3 already at scrollY 547/547 (100%). Position stayed (0, 547) —
    // honest no-change, not a hidden cap-swap. Page / Viewport header is
    // gone. Settle-shape Outcome suffix is gone. Recovery hint is gone.
    // Next is already perceive -C -d 8. The leftover chrome is the
    // tautological AX body. Outcome already states no-change. Do not drop
    // the AX body from leftover-ax-scroll changed or from the leftover
    // perceive dump itself. Do not eat settle 1178ms with a new path.
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const LIVE_PAGE = 'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main';
    const LIVE_VIEWPORT = 'Viewport: 1042×632 | Scroll: 547/547 (100%) | Focused: none';
    const LIVE_AX_BODY = '(no changes detected in AX tree)';
    const header = [
      LIVE_PAGE,
      LIVE_VIEWPORT,
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const dump = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
    ].join('\n');
    expect(dump).toContain(LIVE_PAGE);
    expect(dump).toContain(LIVE_VIEWPORT);
    expect(dump).toContain(LIVE_INTERACTIVE);
    expect(dump).toContain(LIVE_COORDS);
    expect(dump).toContain('Scroll: 547/547 (100%)');
    expect(dump).toContain('Focused: none');

    const diff = T.formatPerceiveDiffOutput(dump, dump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).toContain(LIVE_PAGE);
    expect(diff).toContain(LIVE_VIEWPORT);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toContain(LIVE_PAGE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toContain(LIVE_VIEWPORT);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_INTERACTIVE);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).not.toContain(LIVE_COORDS);
    expect(T.stripLeftoverAxScrollCensusChrome(diff)).toMatch(/no changes detected in AX tree/i);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toContain(LIVE_PAGE);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toContain(LIVE_VIEWPORT);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).not.toMatch(/Focused:/);
    expect(T.stripLeftoverAxScrollNoChangeIdentityChrome(diff)).toMatch(/no changes detected in AX tree/i);
    expect(T.stripLeftoverAxScrollNoChangeAxBodyChrome(diff)).not.toMatch(/no changes detected in AX tree/i);
    expect(T.stripLeftoverAxScrollNoChangeAxBodyChrome(diff)).toContain(LIVE_PAGE);
    expect(T.stripLeftoverAxScrollNoChangeAxBodyChrome(
      T.stripLeftoverAxScrollNoChangeIdentityChrome(diff),
    )).not.toMatch(/no changes detected in AX tree/i);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1178 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 1178ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(LIVE_AX_BODY);
    expect(text).not.toMatch(/no changes detected in AX tree/i);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(LIVE_AX_BODY);
    expect(receipt).not.toMatch(/no changes detected in AX tree/i);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(218);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);

    const addedFileDump = dump.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] tokenizer.json  @3  (24,156 160×22)',
    );
    const changedDiff = T.formatPerceiveDiffOutput(dump, addedFileDump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(changedDiff)).toBe(true);
    expect(changedDiff).toMatch(/tokenizer\.json/);
    const changed = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: changedDiff, console: [], network: [], navigation: null },
    });
    const changedText = T.formatActionText(changed);
    expect(changed.outcome.status).toBe('changed');
    expect(changed.receipt.recoveryHint).toBeNull();
    expect(changedText).toMatch(/^Outcome: changed$/m);
    expect(changedText).not.toMatch(/^Outcome: no-change$/m);
    expect(changedText).toMatch(/^Page:/m);
    expect(changedText).toMatch(/^Viewport:/m);
    expect(changedText).toMatch(/tokenizer\.json/);
    expect(changedText).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(changedText).not.toMatch(/^Recovery hint:/m);

    const leftoverCardsWithHeader = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '2E94F948ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'cards-window-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: [
          'Page: X feed — https://x.com/home',
          'Viewport: 1042×632 | Scroll: 80/800 (10%) | Focused: none',
          'chrome-cdp-ex.cards.v1  2 cards  virtualized',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverCardsWithHeader.outcome.status).toBe('no-change');
    const cardsText = T.formatActionText(leftoverCardsWithHeader);
    expect(cardsText).toMatch(/^Page: X feed/m);
    expect(cardsText).toMatch(/^Viewport: 1042×632/m);
    expect(cardsText).toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(cardsText).toMatch(/\(no changes detected in AX tree\)/);
    expect(cardsText).toMatch(/Next: cdp perceive 2E94F948 --cards/);

    const leftoverPdfWithHeader = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'CFD023D2ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'pdf-viewer-no-change',
        resolvedBy: 'selector-or-ref',
        label: 'body',
      },
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: paper.pdf — https://example.com/paper.pdf',
          'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
          'chrome-cdp-ex.pdf-viewer.v1',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverPdfWithHeader.outcome.status).toBe('no-change');
    const pdfText = T.formatActionText(leftoverPdfWithHeader);
    expect(pdfText).toMatch(/^Page: paper\.pdf/m);
    expect(pdfText).toMatch(/^Viewport: 1042×632/m);
    expect(pdfText).toMatch(/chrome-cdp-ex\.pdf-viewer\.v1/);
    expect(pdfText).toMatch(/\(no changes detected in AX tree\)/);

    const genericNoChangeWithHeader = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: Example — https://example.com',
          'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(genericNoChangeWithHeader.outcome.status).toBe('no-change');
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Page: Example/m);
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Viewport: 1280×720/m);
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/\(no changes detected in AX tree\)/);
    expect(T.formatActionText(genericNoChangeWithHeader)).toMatch(/^Outcome: no-change — /m);
  });

  it('#320 leftover-ax-scroll no-change receipt drops tautological dispatched/Target when Next is already perceive', () => {
    // Live leftover-ax-scroll ActionResult after overlay 496c6a44 (Fixes #318).
    // Bob 9224: leftover perceive 561F7DA8 -C -d 8 then scroll down 80 on HF
    // Music3 already at scrollY 547/547 (100%). Position stayed (0, 547) —
    // honest no-change, not a hidden cap-swap. AX body is gone. Page /
    // Viewport header is gone. Settle-shape Outcome suffix is gone.
    // Recovery hint is gone. Next is already perceive -C -d 8. Live
    // leftover scroll receipt 180 chars. The leftover chrome is
    // "scroll: dispatched via scroll" + "Target: down". Scrolled by /
    // Position already states the action. Do not drop dispatched/Target
    // from leftover-ax-scroll changed. Do not eat settle 763ms with a
    // new path.
    const LIVE_INTERACTIVE = 'Interactive: 113 a, 1 input[text], 21 button, 9 div, 2 input[search], 1 iframe';
    const LIVE_COORDS = 'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)';
    const LIVE_RECOVERY_HINT = 'AX identities unchanged; re-run perceive -C -d 8 instead of report.';
    const LIVE_SETTLE_SHAPE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
    const LIVE_PAGE = 'Page: MiniMaxAI/MiniMax-Music3 at main — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main';
    const LIVE_VIEWPORT = 'Viewport: 1042×632 | Scroll: 547/547 (100%) | Focused: none';
    const LIVE_AX_BODY = '(no changes detected in AX tree)';
    const header = [
      LIVE_PAGE,
      LIVE_VIEWPORT,
      LIVE_INTERACTIVE,
      'Console: clean',
      LIVE_COORDS,
      '',
    ];
    const dump = [
      ...header,
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,100 160×22)',
      '    [link] README.md  @2  (24,128 160×22)',
    ].join('\n');
    expect(dump).toContain(LIVE_PAGE);
    expect(dump).toContain(LIVE_VIEWPORT);
    expect(dump).toContain(LIVE_INTERACTIVE);
    expect(dump).toContain(LIVE_COORDS);
    expect(dump).toContain('Scroll: 547/547 (100%)');
    expect(dump).toContain('Focused: none');

    const diff = T.formatPerceiveDiffOutput(dump, dump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    expect(diff).toMatch(/no changes detected in AX tree/i);
    expect(diff).toContain(LIVE_PAGE);
    expect(diff).toContain(LIVE_VIEWPORT);
    expect(diff).toContain(LIVE_INTERACTIVE);
    expect(diff).toContain(LIVE_COORDS);

    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 763 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    const receipt = T.formatActionResultOutput(result, {
      dispatchText: 'Scrolled by (0, 80). Position: (0, 547)',
    });
    expect(result.outcome.status).toBe('no-change');
    expect(result.verdict.status).toBe('continue');
    expect(result.receipt.recoveryHint).toBeNull();
    expect(result.recommendation.recoveryHint).toBeNull();
    expect(result.nextHint).toBeNull();
    expect(text).not.toMatch(/dispatched via scroll/);
    expect(text).not.toMatch(/^Target: down$/m);
    expect(text).toMatch(/^Outcome: no-change$/m);
    expect(text).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(text).toMatch(/^Verdict: continue$/m);
    expect(text).toMatch(/^Settle: ok in 763ms$/m);
    expect(text).not.toMatch(LIVE_RECOVERY_HINT);
    expect(text).not.toMatch(/^Recovery hint:/m);
    expect(text).not.toMatch(/Recovery hint: Continue from the observed action evidence/);
    expect(text).not.toMatch(/^Interactive:/m);
    expect(text).not.toMatch(/^Console: clean$/m);
    expect(text).not.toMatch(/^Coords: /m);
    expect(text).not.toMatch(/use clickxy with these values/);
    expect(text).not.toMatch(/^Page:/m);
    expect(text).not.toMatch(/^Viewport:/m);
    expect(text).not.toMatch(/Focused:/);
    expect(text).not.toMatch(LIVE_AX_BODY);
    expect(text).not.toMatch(/no changes detected in AX tree/i);
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/cdp report 561F7DA8 --format json/);
    expect(receipt).toBe('Scrolled by (0, 80). Position: (0, 547). Next: cdp perceive 561F7DA8 -C -d 8');
    expect(receipt).toMatch(/Scrolled by \(0, 80\)\. Position: \(0, 547\)/);
    expect(receipt).not.toMatch(/dispatched via scroll/);
    expect(receipt).not.toMatch(/^Target: down$/m);
    expect(receipt).not.toMatch(/^Outcome:/m);
    expect(receipt).not.toMatch(LIVE_SETTLE_SHAPE_REASON);
    expect(receipt).not.toMatch(LIVE_RECOVERY_HINT);
    expect(receipt).not.toMatch(/^Recovery hint:/m);
    expect(receipt).not.toMatch(/^Interactive:/m);
    expect(receipt).not.toMatch(/^Page:/m);
    expect(receipt).not.toMatch(/^Viewport:/m);
    expect(receipt).not.toMatch(/Focused:/);
    expect(receipt).not.toMatch(LIVE_AX_BODY);
    expect(receipt).not.toMatch(/no changes detected in AX tree/i);
    expect(receipt).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(receipt).not.toMatch(/^Settle:/m);
    expect(receipt.length).toBeLessThan(180);
    expect(T.HOVER_MOUSE_ACK_TIMEOUT_MS).toBe(250);

    const addedFileDump = dump.replace(
      '    [link] README.md  @2  (24,128 160×22)',
      '    [link] README.md  @2  (24,128 160×22)\n    [link] tokenizer.json  @3  (24,156 160×22)',
    );
    const changedDiff = T.formatPerceiveDiffOutput(dump, addedFileDump, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(changedDiff)).toBe(true);
    expect(changedDiff).toMatch(/tokenizer\.json/);
    const changed = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 1481 },
      effects: { domDiff: changedDiff, console: [], network: [], navigation: null },
    });
    const changedText = T.formatActionText(changed);
    expect(changed.outcome.status).toBe('changed');
    expect(changed.receipt.recoveryHint).toBeNull();
    expect(changedText).toMatch(/^scroll: dispatched via scroll$/m);
    expect(changedText).toMatch(/^Target: down$/m);
    expect(changedText).toMatch(/^Outcome: changed$/m);
    expect(changedText).not.toMatch(/^Outcome: no-change$/m);
    expect(changedText).toMatch(/^Page:/m);
    expect(changedText).toMatch(/^Viewport:/m);
    expect(changedText).toMatch(/tokenizer\.json/);
    expect(changedText).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(changedText).not.toMatch(/^Recovery hint:/m);

    const leftoverCardsWithHeader = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '2E94F948ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'cards-window-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: {
        domDiff: [
          'Page: X feed — https://x.com/home',
          'Viewport: 1042×632 | Scroll: 80/800 (10%) | Focused: none',
          'chrome-cdp-ex.cards.v1  2 cards  virtualized',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverCardsWithHeader.outcome.status).toBe('no-change');
    const cardsText = T.formatActionText(leftoverCardsWithHeader);
    expect(cardsText).toMatch(/^scroll: dispatched via scroll$/m);
    expect(cardsText).toMatch(/^Target: down$/m);
    expect(cardsText).toMatch(/^Page: X feed/m);
    expect(cardsText).toMatch(/^Viewport: 1042×632/m);
    expect(cardsText).toMatch(/chrome-cdp-ex\.cards\.v1/);
    expect(cardsText).toMatch(/\(no changes detected in AX tree\)/);
    expect(cardsText).toMatch(/Next: cdp perceive 2E94F948 --cards/);

    const leftoverPdfWithHeader = T.createActionResult({
      action: 'click',
      target: {
        targetId: 'CFD023D2ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'pdf-viewer-no-change',
        resolvedBy: 'selector-or-ref',
        label: 'body',
      },
      dispatch: { ok: true, method: 'jsclick' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: paper.pdf — https://example.com/paper.pdf',
          'Viewport: 1042×632 | Scroll: 0/0 (0%) | Focused: none',
          'chrome-cdp-ex.pdf-viewer.v1',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(leftoverPdfWithHeader.outcome.status).toBe('no-change');
    const pdfText = T.formatActionText(leftoverPdfWithHeader);
    expect(pdfText).toMatch(/^click: dispatched via jsclick$/m);
    expect(pdfText).toMatch(/^Target: body$/m);
    expect(pdfText).toMatch(/^Page: paper\.pdf/m);
    expect(pdfText).toMatch(/^Viewport: 1042×632/m);
    expect(pdfText).toMatch(/chrome-cdp-ex\.pdf-viewer\.v1/);
    expect(pdfText).toMatch(/\(no changes detected in AX tree\)/);

    const genericNoChangeWithHeader = T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 40 },
      effects: {
        domDiff: [
          'Page: Example — https://example.com',
          'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
          '(no changes detected in AX tree)',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
    });
    expect(genericNoChangeWithHeader.outcome.status).toBe('no-change');
    const genericText = T.formatActionText(genericNoChangeWithHeader);
    expect(genericText).toMatch(/^click: dispatched via click$/m);
    expect(genericText).toMatch(/^Target: Save$/m);
    expect(genericText).toMatch(/^Page: Example/m);
    expect(genericText).toMatch(/^Viewport: 1280×720/m);
    expect(genericText).toMatch(/\(no changes detected in AX tree\)/);
    expect(genericText).toMatch(/^Outcome: no-change — /m);
  });

  it('#299 leftover-ax-scroll no-change receipt has Next -C -d 8 without Hint --since-action', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3/tree/main',
      'Viewport: 1042×900 | Scroll: 0/2400 (0%) | Focused: none',
      'Interactive: 3 a',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[RootWebArea] MiniMax-Music3',
      '    [link] LICENSE  @1  (24,180 160×22)',
    ].join('\n');
    const current = previous.replace('Scroll: 0/2400 (0%)', 'Scroll: 80/2400 (3%)')
      .replace('(24,180 160×22)', '(24,100 160×22)');
    const diff = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });
    expect(T.actionDomDiffShowsChange(diff)).toBe(false);
    const result = T.createActionResult({
      action: 'scroll',
      target: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        expectedOutcome: 'leftover-ax-scroll-no-change',
        resolvedBy: 'scroll',
        label: 'down',
      },
      dispatch: { ok: true, method: 'scroll' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: diff, console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    const text = T.formatActionText(result);
    expect(result.outcome.status).toBe('no-change');
    expect(result.nextHint).toBeNull();
    expect(text).toMatch(/Next: cdp perceive 561F7DA8 -C -d 8/);
    expect(text).not.toMatch(/Hint: Use perceive --since-action/);
    expect(text).not.toMatch(/perceive --since-action/);
  });

  it('builds a JSON diff model from an explicit baseline output', () => {
    const previous = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
    ].join('\n');
    const current = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
      '  [alert] Saved',
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: 'ABC12345',
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode: 'since-action',
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 0, coordinateSpace: 'viewport-css-px' },
      summary: {
        changed: true,
        removed: 0,
        added: 1,
        textRemoved: 0,
        textAdded: 0,
      },
      added: ['  [alert] Saved'],
      removed: [],
      textAddedSamples: [],
      recommendation: {
        source: 'perceive-diff',
        mode: 'since-action',
        commands: [
          'cdp report ABC12345 --format json',
          'cdp record-actions ABC12345 --format json',
        ],
      },
      nextSteps: [
        'cdp report ABC12345 --format json',
        'cdp record-actions ABC12345 --format json',
      ],
    });
  });

  it('builds a JSON diff model for text-only changes with compact samples', () => {
    const previous = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
    ].join('\n');
    const current = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  [StaticText] hmr panel ready',
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'diff',
      targetPrefix: 'ABC12345',
    });

    expect(model.summary).toMatchObject({
      changed: true,
      added: 0,
      removed: 0,
      textAdded: 1,
      textRemoved: 0,
    });
    expect(model.textAddedSamples).toEqual(['  [StaticText] hmr panel ready']);
    expect(model.nextSteps).toEqual(['cdp report ABC12345 --format json']);
  });

  it('summarizes typeahead reroots in since-action diffs instead of listing every node (#162)', () => {
    const previous = [
      'Page: Models — https://huggingface.co/models',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: [textbox] Search  @1',
      'Interactive: 1 textbox',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Models',
      '  [textbox] Search = ""  @1',
      '  [heading] Trending',
      ...Array.from({ length: 80 }, (_, i) => `  [link] old-model-${i}  @${i + 2}`),
    ].join('\n');
    const current = [
      'Page: Models — https://huggingface.co/models',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: [textbox] Search  @1',
      'Interactive: 1 textbox, 1 listbox',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Models',
      '  [textbox] Search = "MiniMax-H3-Turbo"  @1',
      '  [listbox] Suggestions',
      '    [link] larryvrh/MiniMax-H3-Turbo-Lora  @2',
      '    [link] lightx2v/Minimax-h3-Turbo  @3',
      ...Array.from({ length: 120 }, (_, i) => `    [link] filler-suggestion-${i}  @${i + 4}`),
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: 'ABC12345',
    });
    const text = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });

    expect(model.summary.headline).toBe('textbox value set; 122 suggestion links');
    expect(model.summary.kind).toBe('typeahead');
    expect(model.added[0]).toBe('larryvrh/MiniMax-H3-Turbo-Lora');
    expect(model.added[1]).toBe('lightx2v/Minimax-h3-Turbo');
    expect(model.added.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(model)).not.toContain('filler-suggestion-40');
    expect(text).toContain('textbox value set; 122 suggestion links');
    expect(text).toContain('larryvrh/MiniMax-H3-Turbo-Lora');
    expect(text).not.toContain('filler-suggestion-40');
  });

  it('summarizes Focused: <input> plus a 10/10 suggestion delta as a typeahead one-liner (#162)', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: <input>',
      'Interactive: 1 textbox, 9 link',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] MiniMax-Music3',
      '  [textbox] Search = ""  @55',
      ...Array.from({ length: 9 }, (_, i) => `  [link] old-suggestion-${i}  @${i + 56}`),
    ].join('\n');
    const current = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: <input>',
      'Interactive: 1 textbox, 9 link',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] MiniMax-Music3',
      '  [textbox] Search = "MiniMax-Music"  @55',
      '  [link] MiniMaxAI/MiniMax-Music3  @56',
      '  [link] MiniMaxAI/MiniMax-Music  @57',
      '  [link] MiniMaxAI/MiniMax-M2  @58',
      '  [link] MiniMaxAI/MiniMax-Text-01  @59',
      '  [link] MiniMaxAI/MiniMax-VL-01  @60',
      '  [link] Tencent-Hunyuan/HunyuanVideo  @61',
      '  [link] THUDM/CogVideoX-5b  @62',
      '  [link] stabilityai/stable-audio-open-1.0  @63',
      '  [link] facebook/musicgen-large  @64',
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: '6914C171',
    });
    const text = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });

    expect(model.summary.removed).toBe(10);
    expect(model.summary.added).toBe(10);
    expect(model.summary.kind).toBe('typeahead');
    expect(model.summary.headline).toBe('textbox value set; 9 suggestion links');
    expect(text).toContain('textbox value set; 9 suggestion links');
    expect(text).toContain('MiniMaxAI/MiniMax-Music3');
    expect(text).not.toMatch(/Removed \(10\)/);
    expect(text).not.toMatch(/Added \(10\)/);
  });

  it('summarizes perceive -i then fill typeahead as a one-liner, not a 96/195 reroot (#162)', () => {
    const previous = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: [textbox] Search  @1',
      'Interactive: 1 textbox, 95 link',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] MiniMax-Music3',
      '  [textbox] Search = ""  @1',
      ...Array.from({ length: 95 }, (_, i) => `  [link] chrome-link-${i}  @${i + 2}`),
    ].join('\n');
    const current = [
      'Page: MiniMax-Music3 — https://huggingface.co/MiniMaxAI/MiniMax-Music3',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: [textbox] Search  @1',
      'Interactive: 1 textbox, 194 link',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] MiniMax-Music3',
      '  [heading] MiniMax-Music3',
      '  [textbox] Search = "MiniMax"  @1',
      '  [link] MiniMaxAI/MiniMax-Music3  @2',
      '  [link] MiniMaxAI/MiniMax-Text-01  @3',
      ...Array.from({ length: 192 }, (_, i) => `  [link] other-${i}  @${i + 4}`),
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: '6914C171',
    });
    const text = T.formatPerceiveDiffOutput(previous, current, { mode: 'since-action' });

    expect(model.summary.kind).toBe('typeahead');
    expect(model.summary.headline).toMatch(/^textbox value set; \d+ suggestion links$/);
    expect(text).toContain('textbox value set;');
    expect(text).toContain('suggestion links');
    expect(text).toContain('MiniMaxAI/MiniMax-Music3');
    expect(text).not.toMatch(/Removed \(96\)/);
    expect(text).not.toMatch(/Added \(195\)/);
  });

  it('reuses the -i snapshot shape for --since-action when the user did not pass -C/-d (#162)', () => {
    const lastAction = {
      baselineOutput: '[textbox] Search = ""',
      baselineOpts: T.perceiveSnapshotOpts({ interactive: true, maxDepth: Infinity }),
    };
    const popts = T.resolveSinceActionPerceiveOpts(
      T.parsePerceiveArgs(['--since-action']),
      lastAction,
      ['--since-action'],
    );
    expect(popts).toMatchObject({
      sinceAction: true,
      interactive: true,
      keepTypeahead: true,
      diffBaseline: lastAction.baselineOutput,
    });
    expect(T.perceiveArgsIncludeSnapshotShape(['--since-action'])).toBe(false);
    expect(T.perceiveArgsIncludeSnapshotShape(['--since-action', '-i'])).toBe(true);
  });

  it('does not summarize a huge same-URL click diff as typeahead (#162)', () => {
    const previous = [
      'Page: Models — https://huggingface.co/models',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 40 link',
      'Console: clean',
      'Coords: top-level viewport CSS px',
      '',
      '[WebArea] Models',
      ...Array.from({ length: 40 }, (_, i) => `  [link] old-model-${i}  @${i + 1}`),
    ].join('\n');
    const current = [
      'Page: Models — https://huggingface.co/models',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 40 link',
      'Console: clean',
      'Coords: top-level viewport CSS px',
      '',
      '[WebArea] Models',
      ...Array.from({ length: 40 }, (_, i) => `  [link] new-model-${i}  @${i + 1}`),
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: 'ABC12345',
    });
    expect(model.summary?.kind).not.toBe('typeahead');
    expect(JSON.stringify(model)).toContain('new-model-0');
  });

  it('keeps high-signal StaticText additions in action diffs', () => {
    const previous = [
      'Page: Checkout — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Checkout',
    ].join('\n');
    const current = [
      'Page: Checkout — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Checkout',
      '  [StaticText] Payment failed: card number is required',
      '  [StaticText] diagnostic noise',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('+++ Added (1):');
    expect(diff).toContain('+   [StaticText] Payment failed: card number is required');
    expect(diff).toContain('~~~ Text nodes updated (1 added)');
    expect(diff).not.toContain('diagnostic noise');
  });

  it('includes compact samples for low-signal StaticText additions', () => {
    const previous = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  ... 10 earlier text node(s) omitted (--last 20)',
    ].join('\n');
    const current = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  [StaticText] hmr panel ready',
      '  ... 11 earlier text node(s) omitted (--last 20)',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('~~~ Text nodes updated (1 added)');
    expect(diff).toContain('+   [StaticText] hmr panel ready');
  });
});

