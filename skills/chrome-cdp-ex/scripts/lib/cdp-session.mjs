// High-level helpers over one attached CDP session. `transport` comes from lib/ws-transport.mjs.
// Page-side actions only: they keep working when the tab is hidden (a covered window drops Input.* events).
import { writeFileSync } from 'node:fs';

import { downloadViaPage } from './page-download.mjs';

export function pointerExpression(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not found' };
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'disabled' };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, reason: 'zero size' };
    const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
    return { ok: true, tag: el.tagName, expanded: el.getAttribute('aria-expanded'), state: el.getAttribute('data-state') };
  })()`;
}

export class CdpSession {
  constructor(transport, sessionId) {
    this.transport = transport;
    this.sessionId = sessionId;
    this.networkEnabling = null;
  }

  // timeoutMs undefined keeps the transport default (30 s).
  send(method, params = {}, timeoutMs) {
    return this.transport.send(method, params, this.sessionId, timeoutMs);
  }

  async ev(expression, { timeoutMs } = {}) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page evaluation failed');
    }
    return res.result?.value;
  }

  async waitFor(expression, { timeoutMs = 10000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const timedOut = () => new Error(`timeout after ${timeoutMs} ms waiting for ${expression}`);
    for (;;) {
      // Each evaluate gets only the time left (at most the transport's 30 s), so one hung evaluate cannot
      // push the wait past its deadline.
      const remaining = Math.max(1, Math.min(deadline - Date.now(), 30000));
      let value;
      try {
        value = await this.ev(expression, { timeoutMs: remaining });
      } catch (error) {
        if (Date.now() + intervalMs >= deadline) throw timedOut(); // the bounded evaluate ran out the clock
        throw error;
      }
      if (value) return;
      if (Date.now() + intervalMs > deadline) throw timedOut();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  async pointer(selector) {
    const result = await this.ev(pointerExpression(selector));
    if (!result?.ok) throw new Error(`pointer ${selector}: ${result?.reason || 'failed'}`);
    return result;
  }

  async upload(selector, files) {
    const found = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    const objectId = found.result?.objectId;
    if (!objectId) throw new Error(`upload: no element matches ${selector}`);
    await this.send('DOM.setFileInputFiles', { objectId, files });
  }

  download(url, outFile, options = {}) {
    return downloadViaPage({ evaluate: (expression) => this.ev(expression), url, outFile, ...options });
  }

  // One shared Network.enable per session; a failure is not cached, so the next caller retries.
  ensureNetwork() {
    if (!this.networkEnabling) {
      this.networkEnabling = (async () => this.send('Network.enable'))().catch((error) => {
        this.networkEnabling = null;
        throw error;
      });
    }
    return this.networkEnabling;
  }

  waitResponse(urlPattern, { timeoutMs = 60000 } = {}) {
    // A copy without g/y so .test() keeps no lastIndex state between events or calls.
    const re = urlPattern instanceof RegExp ? new RegExp(urlPattern.source, urlPattern.flags.replace(/[gy]/g, '')) : null;
    const matches = re ? (u) => re.test(u) : (u) => u.includes(String(urlPattern));
    let off = () => {};
    let timer = null;
    let rejectOuter;
    const promise = new Promise((resolve, reject) => {
      rejectOuter = reject;
      off = this.transport.on('Network.responseReceived', (params, sessionId) => {
        const url = params?.response?.url;
        if (sessionId !== this.sessionId || typeof url !== 'string' || !matches(url)) return;
        clearTimeout(timer);
        off();
        resolve({ url, status: params.response.status, mimeType: params.response.mimeType, requestId: params.requestId });
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`timeout after ${timeoutMs} ms waiting for a response matching ${urlPattern}`));
      }, timeoutMs);
    });
    // Side branch marks the promise handled: a caller that never awaits (cleanup path) causes no
    // unhandledRejection, while one that does await still sees the rejection.
    promise.catch(() => {});
    // Enable after subscribing so no event between the two can be lost.
    this.ensureNetwork().catch((error) => { clearTimeout(timer); off(); rejectOuter(error); });
    return {
      promise,
      cancel: () => { clearTimeout(timer); off(); rejectOuter(new Error('waitResponse cancelled')); },
    };
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }
}
