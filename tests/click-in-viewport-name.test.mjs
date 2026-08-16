import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

const HF_HOME = 'https://huggingface.co/';
const HF_MODELS = 'https://huggingface.co/models';
const HF_SPACES = 'https://huggingface.co/spaces';
const HF_HOME_VIEWPORT = { width: 1042, height: 632 };
const HERO_NAME = 'Browse 2M+ models';
const APPS_NAME = 'Browse 1M+ applications';
const TARGET_ID = '54A7C685ABCDEF0123456789ABCDEF01';
const JSCLICK_SCROLL_INTO_VIEW = { block: 'center', inline: 'center' };

function leftoverGoldenPathDump() {
  return [
    `Page: Hugging Face — ${HF_HOME}`,
    `Viewport: ${HF_HOME_VIEWPORT.width}×${HF_HOME_VIEWPORT.height} | Scroll: 0/5295 (0%) | Focused: none`,
    'Interactive: 12 a',
    'Console: clean',
    '',
    '[RootWebArea] Hugging Face',
    '  [link] Models',
    `  [link] ${HERO_NAME} @2`,
    '(no changes detected in AX tree)',
  ].join('\n');
}

function makeLink({
  text,
  href,
  rect,
  tagName = 'A',
  pageState = null,
} = {}) {
  const el = {
    tagName,
    href,
    innerText: text,
    textContent: text,
    title: '',
    getAttribute(name) {
      if (name === 'href') return href;
      if (name === 'aria-label') return null;
      if (name === 'title') return this.title || null;
      return null;
    },
    getBoundingClientRect() {
      return {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.w,
        bottom: rect.y + rect.h,
      };
    },
    click() {
      el.clicked = true;
      if (typeof el.onClick === 'function') el.onClick();
    },
    clicked: false,
    scrollIntoView(opts) {
      el.scrolledIntoView = true;
      el.scrollIntoViewOpts = opts ? { ...opts } : {};
      if (!pageState) return;
      const next = Math.max(0, Math.round(
        pageState.scrollY + rect.y - pageState.innerHeight / 2 + rect.h / 2,
      ));
      pageState.scrollY = next;
    },
    scrolledIntoView: false,
    scrollIntoViewOpts: null,
  };
  return el;
}

function createHfHomePage({
  scrollY = 0,
  innerWidth = HF_HOME_VIEWPORT.width,
  innerHeight = HF_HOME_VIEWPORT.height,
  heroNavigates = true,
} = {}) {
  const state = {
    href: HF_HOME,
    scrollY,
    innerWidth,
    innerHeight,
  };
  const navModels = makeLink({
    text: 'Models',
    href: '/models',
    rect: { x: 80, y: 12, w: 64, h: 20 },
    pageState: state,
  });
  const hero = makeLink({
    text: HERO_NAME,
    href: '/models',
    rect: { x: 40, y: 220, w: 220, h: 28 },
    pageState: state,
  });
  const belowFoldHero = makeLink({
    text: HERO_NAME,
    href: '/models',
    rect: { x: 40, y: 1800, w: 220, h: 28 },
    pageState: state,
  });
  const apps = makeLink({
    text: APPS_NAME,
    href: '/spaces',
    rect: { x: 40, y: 1357, w: 240, h: 28 },
    pageState: state,
  });
  hero.onClick = () => {
    if (heroNavigates) state.href = HF_MODELS;
  };
  belowFoldHero.onClick = () => {
    if (heroNavigates) state.href = HF_MODELS;
  };
  navModels.onClick = () => {
    if (heroNavigates) state.href = HF_MODELS;
  };
  apps.onClick = () => {
    state.href = HF_SPACES;
  };
  const links = [navModels, hero, belowFoldHero, apps];
  const windowObj = {
    get innerWidth() { return state.innerWidth; },
    get innerHeight() { return state.innerHeight; },
    get scrollY() { return state.scrollY; },
    get scrollX() { return 0; },
    scrollTo(_x, y) { state.scrollY = Number(y) || 0; },
    scrollBy(_x, y) { state.scrollY += Number(y) || 0; },
    MouseEvent: class MouseEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init || {});
      }
    },
  };
  const location = {
    get href() { return state.href; },
    set href(value) { state.href = value; },
  };
  const documentObj = {
    querySelector(selector) {
      try {
        if (selector === 'a[href="/models"]') return navModels;
        if (selector === HERO_NAME) {
          const err = new Error('is not a valid selector');
          err.name = 'SyntaxError';
          throw err;
        }
        return null;
      } catch (error) {
        if (error && error.name === 'SyntaxError') throw error;
        const err = new Error('is not a valid selector');
        err.name = 'SyntaxError';
        throw err;
      }
    },
    querySelectorAll(selector) {
      if (selector === 'a, button, [role="link"], [role="button"]') return links;
      return [];
    },
  };
  return {
    state,
    hero,
    belowFoldHero,
    navModels,
    apps,
    links,
    window: windowObj,
    document: documentObj,
    location,
  };
}

function evaluateOnPage(page, expression) {
  return runInNewContext(expression, {
    window: page.window,
    document: page.document,
    location: page.location,
    Array,
    JSON,
    String,
    Math,
    Number,
  });
}

function hfHomeCdp(page) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const value = evaluateOnPage(page, String(params.expression || ''));
        return Promise.resolve({ result: { value } });
      }
      if (method === 'Input.dispatchMouseEvent') {
        return Promise.resolve({});
      }
      if (method === 'DOM.enable') return Promise.resolve({});
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
      if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 2 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'el-hero' } });
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('scrollIntoView')) {
          page.hero.scrollIntoView();
          if (fn.includes('this.click()')) page.hero.click();
          return Promise.resolve({
            result: { value: { tag: 'A', text: HERO_NAME } },
          });
        }
        return Promise.resolve({ result: { value: {} } });
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe('issue #327 click in-viewport named link', () => {
  it('treats the HF hero name as a named in-viewport query, not CSS or leftover @ref', () => {
    expect(T.isNamedClickQuery(HERO_NAME)).toBe(true);
    expect(T.isNamedClickQuery('Browse 2M+ models')).toBe(true);
    expect(T.isNamedClickQuery('a[href="/models"]')).toBe(false);
    expect(T.isNamedClickQuery('#hero')).toBe(false);
    expect(T.isNamedClickQuery('.cta')).toBe(false);
    expect(T.isNamedClickQuery('@2')).toBe(false);
    expect(T.isNamedClickQuery('@c1')).toBe(false);
    expect(T.clickFeedbackPolicy(HERO_NAME)).toBe('report-only');
    expect(T.clickFeedbackPolicy('@2')).toBe('settle-diff');
    expect(T.clickFeedbackPolicy('a[href="/models"]')).toBe('settle-diff');
    expect(T.clickFeedbackPolicy('--js', HERO_NAME)).toBe('report-only');
    expect(T.clickFeedbackPolicy(T.parseClickArgs(['--js', HERO_NAME]).selector)).toBe('report-only');
    expect(T.jsclickFeedbackPolicy(HERO_NAME)).toBe('report-only');
    expect(T.jsclickFeedbackPolicy('#hero')).toBe('settle-diff');
  });

  it('documents named in-viewport click on the existing click / jsclick commands', () => {
    const click = COMMAND_SURFACE.resolve('click');
    const jsclick = COMMAND_SURFACE.resolve('jsclick');
    expect(click.help.synopsis).toMatch(/name/);
    expect(jsclick.help.synopsis).toMatch(/name/);
    expect(click.feedbackPolicy).toBe('settle-diff');
    expect(jsclick.feedbackPolicy).toBe('settle-diff');
    expect(T.helpStr()).toMatch(/<sel\|@ref\|name>/);
    expect(T.helpStr()).toMatch(/scrollIntoView if off-screen/);
    expect(click.help.summary).toMatch(/accessible name/);
    expect(jsclick.help.summary).toMatch(/accessible name/);
    expect(T.helpTopicStr('click')).toMatch(/name/);
    expect(T.helpTopicStr('jsclick')).toMatch(/name/);
  });

  it('jsclicks the in-viewport HF hero by name without perceive, mouse, or scroll', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    const text = await T.jsClickStr(cdp, 'sid', HERO_NAME);
    expect(page.hero.clicked).toBe(true);
    expect(page.belowFoldHero.clicked).toBe(false);
    expect(page.navModels.clicked).toBe(false);
    expect(page.hero.scrolledIntoView).toBe(false);
    expect(page.state.scrollY).toBe(0);
    expect(page.state.href).toBe(HF_MODELS);
    expect(text).toMatch(/JS-clicked <A> "Browse 2M\+ models"/);
    expect(text).toMatch(/URL: https:\/\/huggingface\.co\/models/);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(cdp.calls.some(call => call.method === 'Runtime.callFunctionOn')).toBe(false);
    const expr = cdp.calls.find(call => call.method === 'Runtime.evaluate' && String(call.params.expression || '').includes('chrome-cdp-ex.named-in-viewport-click'))?.params.expression;
    expect(expr).toBeTruthy();
    expect(expr).not.toContain('scrollTo');
    expect(expr).not.toContain('scrollBy');
  });

  it('click without --js uses the jsclick path for a named in-viewport link', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    const text = await T.clickStr(cdp, 'sid', HERO_NAME);
    expect(page.hero.clicked).toBe(true);
    expect(page.state.href).toBe(HF_MODELS);
    expect(page.state.scrollY).toBe(0);
    expect(text).toMatch(/JS-clicked <A> "Browse 2M\+ models"/);
    expect(text).toMatch(/URL: https:\/\/huggingface\.co\/models/);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('prints a skinny report-only receipt without reprinting leftover AX', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    const dispatchText = await T.jsClickStr(cdp, 'sid', HERO_NAME);
    let observed = false;
    const leftover = leftoverGoldenPathDump();
    const text = await T.runActionWithFeedback({
      action: 'jsclick',
      target: T.namedClickActionTarget(HERO_NAME, { targetId: TARGET_ID }),
      dispatch: async () => dispatchText,
      dispatchMethod: 'jsclick',
      feedbackPolicy: T.jsclickFeedbackPolicy(HERO_NAME),
      observe: async () => {
        observed = true;
        return leftover;
      },
    });
    expect(observed).toBe(false);
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/huggingface\.co\/models/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text).not.toMatch(/Interactive: 12 a/);
    expect(text.length).toBeLessThan(2000);
    expect(page.state.scrollY).toBe(0);
  });

  it('fails closed when the named click does not land on the navigating href', async () => {
    const page = createHfHomePage({ heroNavigates: false });
    const cdp = hfHomeCdp(page);
    const err = await T.jsClickStr(cdp, 'sid', HERO_NAME).then(
      () => { throw new Error('expected named click to fail short of /models'); },
      (caught) => caught,
    );
    expect(err.message).toMatch(/did not navigate/i);
    expect(err.message).toMatch(/jsclick/i);
    expect(page.state.href).toBe(HF_HOME);
    expect(page.state.href).not.toBe(HF_MODELS);
    expect(page.hero.clicked).toBe(true);
  });

  it('scrolls a unique off-viewport named control into view then jsclicks it', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    const text = await T.jsClickStr(cdp, 'sid', APPS_NAME);
    expect(page.apps.clicked).toBe(true);
    expect(page.apps.scrolledIntoView).toBe(true);
    expect(page.apps.scrollIntoViewOpts).toEqual(JSCLICK_SCROLL_INTO_VIEW);
    expect(page.hero.clicked).toBe(false);
    expect(page.hero.scrolledIntoView).toBe(false);
    expect(page.state.scrollY).toBeGreaterThan(0);
    expect(page.state.href).toBe(HF_SPACES);
    expect(text).toMatch(/JS-clicked <A> "Browse 1M\+ applications"/);
    expect(text).toMatch(/URL: https:\/\/huggingface\.co\/spaces/);
    expect(text).toMatch(/Scroll: 0 → \d+/);
    expect(text.length).toBeLessThan(400);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    const expr = cdp.calls.find(call => call.method === 'Runtime.evaluate' && String(call.params.expression || '').includes('chrome-cdp-ex.named-in-viewport-click'))?.params.expression;
    expect(expr).toContain('scrollIntoView');
    expect(expr).toContain("block: 'center'");
  });

  it('named click from scrollY 0 lands on /spaces without a prior scroll command', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    expect(page.state.scrollY).toBe(0);
    const text = await T.clickStr(cdp, 'sid', APPS_NAME);
    expect(page.apps.scrolledIntoView).toBe(true);
    expect(page.apps.clicked).toBe(true);
    expect(page.state.href).toBe(HF_SPACES);
    expect(page.state.scrollY).toBeGreaterThan(0);
    expect(text).toMatch(/Scroll: 0 → \d+/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('keeps the off-screen named-click receipt skinny and report-only', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    const dispatchText = await T.clickStr(cdp, 'sid', APPS_NAME);
    let observed = false;
    const text = await T.runActionWithFeedback({
      action: 'click',
      target: T.namedClickActionTarget(APPS_NAME, { targetId: TARGET_ID }),
      dispatch: async () => dispatchText,
      dispatchMethod: 'jsclick',
      feedbackPolicy: T.clickFeedbackPolicy(APPS_NAME),
      observe: async () => {
        observed = true;
        return leftoverGoldenPathDump();
      },
    });
    expect(observed).toBe(false);
    expect(text).toContain(dispatchText);
    expect(text).toMatch(/huggingface\.co\/spaces/);
    expect(text).toMatch(/Scroll: 0 → \d+/);
    expect(text).not.toMatch(/RootWebArea/);
    expect(text).not.toMatch(/no changes detected in AX tree/);
    expect(text.length).toBeLessThan(800);
  });

  it('still fails closed when the named control does not exist', async () => {
    const page = createHfHomePage();
    const cdp = hfHomeCdp(page);
    await expect(T.jsClickStr(cdp, 'sid', 'Browse 9M+ unicorns')).rejects.toThrow(/Named control not found/i);
    expect(page.apps.clicked).toBe(false);
    expect(page.apps.scrolledIntoView).toBe(false);
    expect(page.state.scrollY).toBe(0);
    expect(page.state.href).toBe(HF_HOME);
  });

  it('n=3 off-screen named click stays one step, skinny chars, and lands on /spaces', async () => {
    for (let n = 1; n <= 3; n += 1) {
      const page = createHfHomePage();
      const cdp = hfHomeCdp(page);
      const dispatchText = await T.clickStr(cdp, 'sid', APPS_NAME);
      const text = await T.runActionWithFeedback({
        action: 'click',
        target: T.namedClickActionTarget(APPS_NAME, { targetId: TARGET_ID }),
        dispatch: async () => dispatchText,
        dispatchMethod: 'jsclick',
        feedbackPolicy: T.clickFeedbackPolicy(APPS_NAME),
        observe: async () => leftoverGoldenPathDump(),
      });
      expect(page.state.href).toBe(HF_SPACES);
      expect(page.apps.scrolledIntoView).toBe(true);
      expect(page.state.scrollY).toBeGreaterThan(0);
      expect(text.length).toBeLessThan(800);
      expect(text).toMatch(/Scroll: 0 → \d+/);
      expect(text).not.toMatch(/RootWebArea/);
      expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    }
  });

  it('keeps leftover @ref click on settle-diff and the mouse path', () => {
    expect(T.clickFeedbackPolicy('@2')).toBe('settle-diff');
    expect(T.isNamedClickQuery('@2')).toBe(false);
    const leftover = leftoverGoldenPathDump();
    expect(leftover).toMatch(/RootWebArea/);
    expect(T.clickFeedbackPolicy('@2')).not.toBe('report-only');
  });

  it('exports Playwright getByRole for named clicks and keeps locator for CSS', () => {
    expect(T.playwrightStepFromCommand({
      action: 'jsclick',
      command: ['jsclick', HERO_NAME],
      replayable: true,
    }).lines[0]).toBe(`await page.getByRole('link', { name: ${JSON.stringify(HERO_NAME)} }).click();`);
    expect(T.playwrightStepFromCommand({
      action: 'click',
      command: ['click', HERO_NAME],
      replayable: true,
    }).lines[0]).toBe(`await page.getByRole('link', { name: ${JSON.stringify(HERO_NAME)} }).click();`);
    expect(T.playwrightStepFromCommand({
      action: 'click',
      command: ['click', 'a[href="/models"]'],
      replayable: true,
    }).lines[0]).toBe('await page.locator("a[href=\\"/models\\"]").click();');
  });

  it('n=3 named path stays one step, hundreds-to-low-thousands of agent-facing chars, and lands on /models', async () => {
    const walls = [];
    for (let n = 1; n <= 3; n += 1) {
      const page = createHfHomePage();
      const cdp = hfHomeCdp(page);
      const started = Date.now();
      const dispatchText = await T.clickStr(cdp, 'sid', HERO_NAME);
      const text = await T.runActionWithFeedback({
        action: 'click',
        target: T.namedClickActionTarget(HERO_NAME, { targetId: TARGET_ID }),
        dispatch: async () => dispatchText,
        dispatchMethod: 'jsclick',
        feedbackPolicy: T.clickFeedbackPolicy(HERO_NAME),
        observe: async () => leftoverGoldenPathDump(),
      });
      walls.push(Date.now() - started);
      expect(page.state.href).toBe(HF_MODELS);
      expect(page.state.scrollY).toBe(0);
      expect(text.length).toBeLessThan(2000);
      expect(text).not.toMatch(/RootWebArea/);
      expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    }
    expect(walls).toHaveLength(3);
  });
});
