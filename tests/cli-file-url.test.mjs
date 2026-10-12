// #587: file: stays refused. The error is a usage mistake with a local http workaround,
// not an unknown browser failure.
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const SERVER = 'python -m http.server --protocol HTTP/1.1 --bind 127.0.0.1 8000';
const PAGE = 'file:///C:/x/page.html';

function refusal(url) {
  try {
    T.validateUrl(url);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${url} to be refused`);
}

function navTarget(url) {
  return { targetId: 'ABCD1234FFFFFFFF', input: url, resolvedBy: 'url', label: url };
}

describe('file: URL refusal', () => {
  it('refuses file: on purpose and names the file to open over http', () => {
    const err = refusal(PAGE);
    expect(err.message).toMatch(/file: URLs are refused on purpose/);
    expect(err.message).toMatch(/Only http\/https URLs allowed, got: file:/);
    expect(err.message).toMatch(/in the file's folder/);
    expect(err.message).toContain(SERVER);
    expect(err.message).toContain('http://127.0.0.1:8000/page.html');
    expect(refusal('file:///etc/passwd').message).toContain('http://127.0.0.1:8000/passwd');
    expect(refusal('file:///C:/x/my%20page.html').message).toContain('http://127.0.0.1:8000/my%20page.html');
    expect(refusal('file:///C:/x/').message).toContain('http://127.0.0.1:8000/<filename>');
    expect(refusal('file:///C:/x/').message).not.toContain('http://127.0.0.1:8000/x');
  });

  it('classifies open of a file: URL as usage, not run-doctor', () => {
    const text = T.formatCliError(refusal(PAGE), { cmd: 'open' });
    expect(text).toMatch(/file: URLs are refused on purpose/);
    expect(text).toMatch(/Kind: usage/);
    expect(text).not.toMatch(/Kind: unknown/);
    expect(text).not.toMatch(/run-doctor/);
    expect(text).not.toMatch(/Next: cdp doctor/);
    expect(text).toMatch(new RegExp(`^Next: ${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const model = JSON.parse(T.formatCliError(refusal(PAGE), { cmd: 'open', format: 'json' }));
    expect(model.recovery).toMatchObject({ kind: 'usage', run: SERVER });
    expect(model.error.message).toMatch(/file: URLs are refused on purpose/);
    expect(model.error.message).toContain('http://127.0.0.1:8000/page.html');
  });

  it('classifies nav to a file: URL as usage with the same server, not perceive', async () => {
    const err = refusal(PAGE);
    const target = navTarget(PAGE);
    expect(T.classifyActionFailure(err, { action: 'nav', target })).toMatchObject({
      kind: 'usage',
      nextCommand: SERVER,
    });
    const actionText = T.formatActionFailure(err, { action: 'nav', target });
    expect(actionText).toMatch(/file: URLs are refused on purpose/);
    expect(actionText).toMatch(/^Kind: usage$/m);
    expect(actionText).not.toMatch(/Kind: unknown/);
    expect(actionText).toMatch(new RegExp(`^Next: ${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(actionText).not.toMatch(/cdp perceive/);

    const thrown = await T.runActionWithFeedback({
      action: 'nav',
      target,
      dispatch: async () => { throw err; },
      feedbackPolicy: 'state-change',
      observe: async () => '',
    }).catch(error => error);
    const visible = T.formatCliError(thrown, { cmd: 'nav', targetPrefix: 'ABCD1234' });
    expect(visible).toMatch(/file: URLs are refused on purpose/);
    expect(visible).toMatch(/http:\/\/127\.0\.0\.1:8000\/page\.html/);
    expect(visible).toMatch(/Kind: usage/);
    expect(visible).not.toMatch(/Kind: unknown/);
    expect(visible).toMatch(new RegExp(`^Next: ${SERVER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(visible).not.toMatch(/cdp perceive/);
    expect(visible).not.toMatch(/cdp status/);
  });

  it('still refuses other non-http schemes without the file workaround', () => {
    for (const url of ['ftp://example.com/a', 'data:text/html,<h1>hi</h1>']) {
      const err = refusal(url);
      expect(err.message).toMatch(/Only http/);
      expect(err.message).not.toMatch(/refused on purpose/);
      expect(T.buildCliErrorRecovery(err.message, { cmd: 'open' }).kind).toBe('unknown');
      expect(T.classifyActionFailure(err, { action: 'nav', target: navTarget(url) }).kind).toBe('unknown');
    }
  });

  it('nav refuses a file: URL before talking to the page', async () => {
    await expect(T.navStr({}, 'sid1', PAGE)).rejects.toThrow(/file: URLs are refused on purpose/);
    await expect(T.navStr({}, 'sid1', PAGE)).rejects.toThrow(/Only http/);
  });
});
