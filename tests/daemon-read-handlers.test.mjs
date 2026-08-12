import { describe, expect, it, vi } from 'vitest';

import {
  createDaemonReadHandlers,
} from '../skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs';

describe('daemon extraction read handlers', () => {
  function fixture() {
    const capabilities = {
      cascade: vi.fn(async args => `cascade:${args.join('|')}`),
      checkpoint: vi.fn(async args => `checkpoint:${args.join('|')}`),
      controls: vi.fn(async args => `controls:${args.join('|')}`),
      components: vi.fn(async args => `components:${args.join('|')}`),
      console: vi.fn(async args => `console:${args.join('|')}`),
      cookies: vi.fn(async args => `cookies:${args.join('|')}`),
      'export-playwright': vi.fn(async args => `export-playwright:${args.join('|')}`),
      frame: vi.fn(async args => `frame:${args.join('|')}`),
      html: vi.fn(async args => `html:${args.join('|')}`),
      net: vi.fn(async args => `net:${args.join('|')}`),
      overlay: vi.fn(async args => `overlay:${args.join('|')}`),
      'record-actions': vi.fn(async args => `record-actions:${args.join('|')}`),
      record: vi.fn(async args => `record:${args.join('|')}`),
      status: vi.fn(async args => `status:${args.join('|')}`),
      styles: vi.fn(async args => `styles:${args.join('|')}`),
      summary: vi.fn(async args => `summary:${args.join('|')}`),
      snap: vi.fn(async args => `snap:${args.join('|')}`),
      text: vi.fn(async args => `text:${args.join('|')}`),
      table: vi.fn(async selector => `table:${selector ?? ''}`),
      wait: vi.fn(async args => `wait:${args.join('|')}`),
      waitfor: vi.fn(async args => `waitfor:${args.join('|')}`),
    };
    return { capabilities, handlers: createDaemonReadHandlers(capabilities) };
  }

  it('constructs the exact immutable accepted read cohorts', () => {
    const { handlers } = fixture();
    expect(Object.keys(handlers)).toEqual([
      'cascade', 'checkpoint', 'components', 'console', 'controls', 'cookies', 'export-playwright', 'frame', 'html', 'net', 'overlay',
      'record', 'record-actions', 'snap', 'status', 'styles', 'summary', 'table', 'text',
      'wait', 'waitfor',
    ]);
    expect(Object.isFrozen(handlers)).toBe(true);
    expect(Object.values(handlers).every(Object.isFrozen)).toBe(true);
  });

  it('preserves ordered argv, output, and table selector mapping exactly', async () => {
    const { capabilities, handlers } = fixture();
    const html = await handlers.html({ args: ['--root', 'main', 'main'] });
    const text = await handlers.text({ args: ['--selector', 'body', '--exclude', 'body'] });
    const table = await handlers.table({ args: [] });
    const net = await handlers.net({ args: ['ignored-by-legacy'] });
    const status = await handlers.status({ args: ['--format', 'json'] });
    const summary = await handlers.summary({ args: ['--format', 'json'] });
    const snap = await handlers.snap({ args: ['--full'] });
    const controls = await handlers.controls({ args: ['--filter', 'button', '--format', 'json'] });
    const frame = await handlers.frame({ args: ['--format', 'json'] });
    const overlay = await handlers.overlay({ args: ['--format', 'json'] });
    const styles = await handlers.styles({ args: ['#auth-panel'] });
    const components = await handlers.components({ args: ['#auth-panel'] });
    const consoleOutput = await handlers.console({ args: ['--clear', '--format', 'json'] });
    const record = await handlers.record({ args: ['500', '--action', 'click', '#refresh-account'] });
    const recordActions = await handlers['record-actions']({ args: ['--format', 'json'] });
    const exportPlaywright = await handlers['export-playwright']({ args: ['--test-name', 'fixture'] });
    const cascade = await handlers.cascade({ args: ['#auth-panel', 'color', '--format', 'json'] });
    const checkpoint = await handlers.checkpoint({ args: ['--format', 'json'] });
    const cookies = await handlers.cookies({ args: ['legacy-ignored'] });
    const wait = await handlers.wait({ args: ['25'] });
    const waitfor = await handlers.waitfor({ args: ['--text', 'Ready', '500'] });
    expect(html.value).toBe('html:--root|main|main');
    expect(text.value).toBe('text:--selector|body|--exclude|body');
    expect(table.value).toBe('table:');
    expect(net.value).toBe('net:ignored-by-legacy');
    expect(status.value).toBe('status:--format|json');
    expect(summary.value).toBe('summary:--format|json');
    expect(snap.value).toBe('snap:--full');
    expect(controls.value).toBe('controls:--filter|button|--format|json');
    expect(frame.value).toBe('frame:--format|json');
    expect(overlay.value).toBe('overlay:--format|json');
    expect(styles.value).toBe('styles:#auth-panel');
    expect(components.value).toBe('components:#auth-panel');
    expect(consoleOutput.value).toBe('console:--clear|--format|json');
    expect(record.value).toBe('record:500|--action|click|#refresh-account');
    expect(recordActions.value).toBe('record-actions:--format|json');
    expect(exportPlaywright.value).toBe('export-playwright:--test-name|fixture');
    expect(cascade.value).toBe('cascade:#auth-panel|color|--format|json');
    expect(checkpoint.value).toBe('checkpoint:--format|json');
    expect(cookies.value).toBe('cookies:legacy-ignored');
    expect(wait.value).toBe('wait:25');
    expect(waitfor.value).toBe('waitfor:--text|Ready|500');
    expect(capabilities.html).toHaveBeenCalledWith(['--root', 'main', 'main']);
    expect(capabilities.text).toHaveBeenCalledWith(['--selector', 'body', '--exclude', 'body']);
    expect(capabilities.table).toHaveBeenCalledWith(undefined);
    expect(capabilities.net).toHaveBeenCalledWith(['ignored-by-legacy']);
    expect(capabilities.status).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities.summary).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities.snap).toHaveBeenCalledWith(['--full']);
    expect(capabilities.controls).toHaveBeenCalledWith(['--filter', 'button', '--format', 'json']);
    expect(capabilities.frame).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities.overlay).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities.styles).toHaveBeenCalledWith(['#auth-panel']);
    expect(capabilities.components).toHaveBeenCalledWith(['#auth-panel']);
    expect(capabilities.console).toHaveBeenCalledWith(['--clear', '--format', 'json']);
    expect(capabilities.record).toHaveBeenCalledWith(['500', '--action', 'click', '#refresh-account']);
    expect(capabilities['record-actions']).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities['export-playwright']).toHaveBeenCalledWith(['--test-name', 'fixture']);
    expect(capabilities.cascade).toHaveBeenCalledWith(['#auth-panel', 'color', '--format', 'json']);
    expect(capabilities.checkpoint).toHaveBeenCalledWith(['--format', 'json']);
    expect(capabilities.cookies).toHaveBeenCalledWith(['legacy-ignored']);
    expect(capabilities.wait).toHaveBeenCalledWith(['25']);
    expect(capabilities.waitfor).toHaveBeenCalledWith(['--text', 'Ready', '500']);
  });

  it('preserves thrown identity and never invokes another capability', async () => {
    const { capabilities, handlers } = fixture();
    const sentinel = new Error('text sentinel');
    capabilities.text.mockRejectedValueOnce(sentinel);
    await expect(handlers.text({ args: ['main'] })).rejects.toBe(sentinel);
    expect(capabilities.html).not.toHaveBeenCalled();
    expect(capabilities.table).not.toHaveBeenCalled();
  });

  it('rejects missing, extra, accessor, symbol, prototype, and non-function capabilities before reads', () => {
    const valid = {
      cascade: vi.fn(), checkpoint: vi.fn(), components: vi.fn(), console: vi.fn(), controls: vi.fn(), cookies: vi.fn(), 'export-playwright': vi.fn(), frame: vi.fn(), html: vi.fn(),
      net: vi.fn(), overlay: vi.fn(), record: vi.fn(), 'record-actions': vi.fn(), snap: vi.fn(), status: vi.fn(),
      styles: vi.fn(), summary: vi.fn(), text: vi.fn(), table: vi.fn(), wait: vi.fn(), waitfor: vi.fn(),
    };
    expect(() => createDaemonReadHandlers({ ...valid, net: undefined })).toThrow(/function/);
    expect(() => createDaemonReadHandlers({ ...valid, planted: vi.fn() })).toThrow(/exactly/);
    expect(() => createDaemonReadHandlers(Object.create(valid))).toThrow(/plain data object/);
    expect(() => createDaemonReadHandlers({ ...valid, html: true })).toThrow(/function/);
    const read = vi.fn(() => valid.text);
    const accessor = { ...valid };
    delete accessor.text;
    Object.defineProperty(accessor, 'text', { enumerable: true, get: read });
    expect(() => createDaemonReadHandlers(accessor)).toThrow(/data property/);
    expect(read).not.toHaveBeenCalled();
    expect(() => createDaemonReadHandlers({ ...valid, [Symbol('x')]: vi.fn() })).toThrow(/symbol/);
  });
});
