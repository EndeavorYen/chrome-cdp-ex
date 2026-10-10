import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP = join(REPO, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const NO_CHANGE = '(no changes detected in AX tree)';
const TARGET_ID = '9E3238F5CEA88A787E777B3A5E650842';

function axState(name, value, type = 'tristate') {
  return { name, value: { type, value } };
}

function buttonElement(attrs) {
  return {
    tagName: 'BUTTON',
    id: 't',
    type: 'button',
    hasAttribute(name) { return Object.hasOwn(attrs, name); },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
  };
}

function cdpReading(el) {
  return {
    send(method, params = {}) {
      if (method !== 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
      const document = {
        querySelector(selector) { return selector === '#t' ? el : null; },
      };
      try {
        const value = runInContext(String(params.expression || ''), createContext({ document }));
        return Promise.resolve({ result: { value } });
      } catch (error) {
        return Promise.resolve({
          exceptionDetails: { text: error.message, exception: { description: error.message } },
        });
      }
    },
  };
}

async function readControl(el) {
  return T.snapshotFormControlState(cdpReading(el), 'sid', '#t', new Map(), {});
}

function clickFeedback({ dispatchText, domDiff = NO_CHANGE, target = {}, format = 'text' }) {
  return T.runActionWithFeedback({
    action: 'click',
    target: {
      targetId: TARGET_ID,
      input: '#t',
      resolvedBy: 'selector',
      label: '#t',
      ...target,
    },
    dispatch: async () => dispatchText,
    feedbackPolicy: 'settle-diff',
    observe: async () => domDiff,
    format,
  });
}

describe('a clicked control\'s own aria state is a reaction (#664)', () => {
  it('prints pressed and expanded from the accessibility properties Chrome sends', () => {
    const pressedOff = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Details' },
      properties: [axState('pressed', 'false')],
    }, 0);
    const pressedOn = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Details' },
      properties: [axState('pressed', 'true')],
    }, 0);
    const expandedOn = T.formatAxNode({
      role: { value: 'button' },
      name: { value: 'Section' },
      properties: [axState('expanded', true, 'booleanOrUndefined')],
    }, 0);
    expect(pressedOff).toBe('[button] Details pressed=false');
    expect(pressedOn).toBe('[button] Details pressed=true');
    expect(expandedOn).toBe('[button] Section expanded=true');
    const diff = T.formatPerceiveDiffOutput(`Page: toggle\n\n${pressedOff}\n`, `Page: toggle\n\n${pressedOn}\n`);
    expect(T.actionDomDiffShowsChange(diff)).toBe(true);
    expect(diff).not.toMatch(/no changes detected/i);
  });

  it('keeps a pressed token out of the accessible name', () => {
    const [note] = T.refAnnotationsFromTreeLines(['[button] Details pressed=false  @1  (8,8 57×21)']);
    expect(note.name).toBe('Details');
    expect(note.ref).toBe('@1');
  });

  it('names an aria-pressed flip on the one-line receipt', async () => {
    const text = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Details"',
      target: {
        controlStateChanged: true,
        controlStateDiff: 'aria-pressed false → true',
      },
    });
    expect(text).toMatch(/^Clicked <BUTTON> "Details": aria-pressed false → true\. Next: /);
    expect(text).not.toMatch(/Kind:/);
    expect(text).not.toMatch(/Outcome: no-change/);
  });

  it('reads aria-pressed, aria-expanded, aria-checked, and aria-selected off the control', async () => {
    const attrs = {
      'aria-pressed': 'false',
      'aria-expanded': 'false',
      'aria-checked': 'false',
      'aria-selected': 'false',
    };
    const el = buttonElement(attrs);
    const before = await readControl(el);
    expect(before.aria).toEqual(attrs);
    attrs['aria-pressed'] = 'true';
    attrs['aria-expanded'] = 'true';
    attrs['aria-checked'] = 'mixed';
    attrs['aria-selected'] = 'true';
    const after = await readControl(el);
    expect(T.formControlStateChanged(before, after)).toBe(true);
    expect(T.formatFormControlStateDiff(before, after)).toBe(
      'aria-pressed false → true; aria-expanded false → true; aria-checked false → mixed; aria-selected false → true',
    );
    const result = T.createActionResult({
      action: 'click',
      target: {
        targetId: TARGET_ID,
        input: '#t',
        resolvedBy: 'selector',
        label: '#t',
        controlStateChanged: T.formControlStateChanged(before, after),
        controlStateDiff: T.formatFormControlStateDiff(before, after),
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 20 },
      effects: { domDiff: NO_CHANGE, console: [], network: [], navigation: null },
    });
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true });
    expect(result.verdict).toMatchObject({ status: 'continue', canContinue: true });
  });

  it('records an unchanged aria-pressed value and does not call it a reaction', async () => {
    const el = buttonElement({ 'aria-pressed': 'false' });
    const before = await readControl(el);
    const after = await readControl(el);
    expect(before.aria['aria-pressed']).toBe('false');
    expect(after.aria['aria-pressed']).toBe('false');
    expect(T.formControlStateChanged(before, after)).toBe(false);
    expect(T.formatFormControlStateDiff(before, after)).toBe('');
  });

  it('still fails closed when the formatted tree and the control state are unchanged', async () => {
    const err = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Save"',
    }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Kind: click-no-change/);
    expect(err.message).toMatch(/Outcome: no-change/);
  });
});

function browserPath() {
  const fromEnv = process.env.CDP_SMOKE_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ['chrome', 'edge', 'brave']) {
    const found = detectBrowserPath(name);
    if (found && existsSync(found)) return found;
  }
  return '';
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

const FIXTURE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>aria-toggle</title>
<button id="on" type="button" aria-pressed="false">Details</button>
<button id="off" type="button" aria-pressed="true">Hide</button>
<button id="ex" type="button" aria-expanded="false">Section</button>
<button id="ck" type="button" role="checkbox" aria-checked="false">Agree</button>
<button id="sel" type="button" role="tab" aria-selected="false">Tab</button>
<button id="still" type="button" aria-pressed="false">Stay</button>
<button id="noop" type="button">Save</button>
<script>
  function flip(name) {
    return (event) => {
      const button = event.currentTarget;
      button.setAttribute(name, String(button.getAttribute(name) !== 'true'));
    };
  }
  document.getElementById('on').addEventListener('click', flip('aria-pressed'));
  document.getElementById('off').addEventListener('click', flip('aria-pressed'));
  document.getElementById('ex').addEventListener('click', flip('aria-expanded'));
  document.getElementById('ck').addEventListener('click', flip('aria-checked'));
  document.getElementById('sel').addEventListener('click', flip('aria-selected'));
</script>`;

describe('headless click of an aria toggle (#664)', () => {
  const browser = browserPath();
  let chrome;
  let server;
  let prefix = '';
  let env;
  let profile = '';

  function run(args) {
    return spawnSync(process.execPath, [CDP, ...args], {
      cwd: REPO, env, encoding: 'utf8', timeout: 45000,
    });
  }

  beforeAll(async () => {
    if (!browser) throw new Error('a supported browser is required for this regression');
    const port = await freePort();
    profile = mkdtempSync(join(tmpdir(), 'aria-toggle-664-'));
    const runtime = join(profile, 'runtime');
    mkdirSync(runtime, { recursive: true });
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const url = `http://127.0.0.1:${server.address().port}/toggle.html`;
    const sandboxOff = /^(1|true|yes|on)$/i.test(process.env.CDP_SMOKE_NO_SANDBOX || '') || Boolean(process.env.CI);
    chrome = spawn(browser, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(sandboxOff ? ['--no-sandbox'] : []),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    env = {
      ...process.env,
      CDP_PORT: String(port),
      ...(process.platform === 'win32' ? { LOCALAPPDATA: runtime } : { XDG_RUNTIME_DIR: runtime }),
    };
    let version;
    for (let attempt = 0; attempt < 50 && !version; attempt += 1) {
      if (chrome.exitCode != null) break;
      try {
        version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json());
      } catch {
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
    }
    if (!version?.webSocketDebuggerUrl) throw new Error('browser did not open a CDP endpoint');
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen);
      socket.addEventListener('error', () => rejectOpen(new Error('cdp websocket failed')));
    });
    let seq = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) pending.get(message.id)(message);
    });
    const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
      const id = ++seq;
      pending.set(id, message => {
        pending.delete(id);
        if (message.error) rejectSend(new Error(message.error.message || 'cdp error'));
        else resolveSend(message.result || {});
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send('Target.createTarget', { url });
    socket.close();
    const deadline = Date.now() + 15000;
    let listed = null;
    while (Date.now() < deadline && !prefix) {
      listed = run(['list']);
      if (listed.status === 0) {
        prefix = listed.stdout.split('\n').find(line => line.includes('toggle.html'))?.trim().split(/\s+/)[0] || '';
      }
      if (!prefix) await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    if (!prefix) {
      throw new Error(`list did not show the fixture\nstatus=${listed?.status} signal=${listed?.signal || ''}\n${listed?.stdout || ''}\n${listed?.stderr || ''}`);
    }
  }, 60_000);

  afterAll(async () => {
    try { run(['stop', '--all']); } catch { /* the browser may already be gone */ }
    try { chrome?.kill('SIGTERM'); } catch { /* already exited */ }
    if (server) await new Promise(resolveClose => server.close(resolveClose));
    if (profile) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* profile may still be closing */ }
    }
  });

  async function attribute(id, name) {
    const result = run(['eval', prefix, `document.getElementById(${JSON.stringify(id)}).getAttribute(${JSON.stringify(name)})`]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function expectReaction(selector, phrase) {
    const click = run(['click', prefix, selector]);
    const output = `${click.stdout}\n${click.stderr}`;
    expect(click.status, output).toBe(0);
    expect(click.stdout, output).toContain(phrase);
    expect(output).not.toMatch(/Kind:\s*click-no-change/);
    expect(output).not.toMatch(/Outcome:\s*no-change/);
  }

  it('counts aria-pressed false → true and shows pressed on the tree', async () => {
    expectReaction('#on', 'aria-pressed false → true');
    expect(await attribute('on', 'aria-pressed')).toBe('true');
    const tree = run(['perceive', prefix, '-C', '-d', '4']);
    expect(tree.status, tree.stderr).toBe(0);
    expect(tree.stdout).toMatch(/\[button\] Details pressed=true/);
  }, 45_000);

  it('counts aria-pressed true → false', async () => {
    expectReaction('#off', 'aria-pressed true → false');
    expect(await attribute('off', 'aria-pressed')).toBe('false');
  }, 45_000);

  it('counts aria-expanded false → true', async () => {
    expectReaction('#ex', 'aria-expanded false → true');
    expect(await attribute('ex', 'aria-expanded')).toBe('true');
    const tree = run(['perceive', prefix, '-C', '-d', '4']);
    expect(tree.status, tree.stderr).toBe(0);
    expect(tree.stdout).toMatch(/\[button\] Section expanded=true/);
  }, 45_000);

  it('names aria-checked and aria-selected on the receipt', async () => {
    expectReaction('#ck', 'aria-checked false → true');
    expect(await attribute('ck', 'aria-checked')).toBe('true');
    expectReaction('#sel', 'aria-selected false → true');
    expect(await attribute('sel', 'aria-selected')).toBe('true');
  }, 45_000);

  it('still fails closed when the click changes nothing', async () => {
    const stay = run(['click', prefix, '#still']);
    const stayOutput = `${stay.stdout}\n${stay.stderr}`;
    expect(stay.status, stayOutput).toBe(1);
    expect(stayOutput).toMatch(/Kind:\s*click-no-change/);
    expect(stayOutput).toMatch(/Outcome:\s*no-change/);
    expect(await attribute('still', 'aria-pressed')).toBe('false');
    const stayTree = run(['perceive', prefix, '-C', '-d', '4']);
    expect(stayTree.status, stayTree.stderr).toBe(0);
    expect(stayTree.stdout).toMatch(/\[button\] Stay pressed=false/);

    const noop = run(['click', prefix, '#noop']);
    const noopOutput = `${noop.stdout}\n${noop.stderr}`;
    expect(noop.status, noopOutput).toBe(1);
    expect(noopOutput).toMatch(/Kind:\s*click-no-change/);
    expect(noopOutput).toMatch(/Outcome:\s*no-change/);
    expect(noopOutput).not.toMatch(/aria-pressed/);
  }, 45_000);
});
