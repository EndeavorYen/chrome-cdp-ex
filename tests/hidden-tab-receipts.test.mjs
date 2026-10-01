import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET = { targetId: 'ABC123', input: '#send' };
const NO_EVENTS = 'click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (51, 110) for #send. The mouse path failed closed. Try jsclick or click --js.';
const HIDDEN = ' The tab\'s document.visibilityState is hidden (window covered or minimised): Input.* events are dropped while hidden, so retrying the mouse path will not help.';

describe('hidden-tab receipts (#402)', () => {
  describe('classifyActionFailure', () => {
    it('reports visibility hidden and dispatched:false for no-input-events on a hidden tab', () => {
      const failure = classifyActionFailure(new Error(NO_EVENTS + HIDDEN), { action: 'click', target: TARGET });
      expect(failure).toMatchObject({
        kind: 'no-input-events',
        visibility: 'hidden',
        dispatched: false,
        nextCommand: 'cdp jsclick ABC123 "#send"',
      });
      expect(failure.hints.join(' ')).toMatch(/hidden/);
      expect(failure.hints.join(' ')).toMatch(/Input\.\* events are dropped/);
    });

    it('keeps no-input-events on a visible or unknown tab but never claims hidden', () => {
      const failure = classifyActionFailure(new Error(NO_EVENTS), { action: 'click', target: TARGET });
      expect(failure).toMatchObject({ kind: 'no-input-events', dispatched: false, nextCommand: 'cdp jsclick ABC123 "#send"' });
      expect(failure.visibility).not.toBe('hidden');
    });

    it('marks a timeout as dispatched:unknown and warns against blind resends', () => {
      const failure = classifyActionFailure(new Error('Timeout: Input.dispatchKeyEvent'), { action: 'press', target: TARGET });
      expect(failure).toMatchObject({ kind: 'timeout', dispatched: 'unknown' });
      expect(failure.hints.join(' ')).toMatch(/non-idempotent/);
      expect(failure.hints.join(' ')).toMatch(/--since-action/);
    });
  });

  describe('dispatchClick on a hidden tab', () => {
    function fakeCdp(visibility) {
      const calls = [];
      return {
        calls,
        send(method, params = {}) {
          calls.push({ method, params });
          if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
          if (method === 'Runtime.evaluate' && String(params.expression).includes('visibilityState')) {
            return Promise.resolve({ result: { type: 'string', value: visibility } });
          }
          // Probe cannot be installed: dispatchClick fails closed with the no-page-events error.
          return Promise.resolve({ result: { type: 'string', value: '' } });
        },
      };
    }

    it('names the hidden tab in the error and exposes err.visibility', async () => {
      const err = await T.dispatchClick(fakeCdp('hidden'), 'sid', 51, 110, { selector: '#send' }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/received no mousedown\/click events/);
      expect(err.message).toMatch(/visibilityState is hidden/);
      expect(err.message).toMatch(/jsclick/);
      expect(err.visibility).toBe('hidden');
    });

    it('does not mention hidden when the tab is visible', async () => {
      const err = await T.dispatchClick(fakeCdp('visible'), 'sid', 51, 110, { selector: '#send' }).catch((e) => e);
      expect(err.message).toMatch(/received no mousedown\/click events/);
      expect(err.message).not.toMatch(/visibilityState is hidden/);
      expect(err.visibility).toBe('visible');
    });

    it('falls back to unknown when the visibility probe itself fails', async () => {
      const cdp = {
        send(method, params = {}) {
          if (method === 'Input.dispatchMouseEvent') return Promise.resolve({});
          if (method === 'Runtime.evaluate' && String(params.expression).includes('visibilityState')) {
            return Promise.reject(new Error('Timeout: Runtime.evaluate'));
          }
          return Promise.resolve({ result: { type: 'string', value: '' } });
        },
      };
      const err = await T.dispatchClick(cdp, 'sid', 51, 110, { selector: '#send' }).catch((e) => e);
      expect(err.message).toMatch(/received no mousedown\/click events/);
      expect(err.visibility).toBe('unknown');
    });
  });
});
