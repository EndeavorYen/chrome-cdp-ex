import { describe, it, expect } from 'vitest';

import { runtimeSource } from './runtime-source.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { normalizeTargetCommandArgs, formatCliError, formatDaemonCommandError, formatOpenReadyMessage, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure, formatOpenNextPerceiveCommand, formatOpenAttachWaitMessage, shouldAnnounceOpenAttachWait, KEY_MAP, ENRICHED_ROLES, INTERACTIVE_ROLES, helpStr } = T;

// =========================================================================
// COMMANDS registry
// =========================================================================

describe('COMMANDS registry', () => {
  it('exports command metadata with unique names', () => {
    const names = T.COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('generates target command requirements from registry metadata', () => {
    const fromRegistry = new Set(
      T.COMMANDS
        .filter(c => c.needsTarget)
        .flatMap(c => [c.name, ...(c.aliases || [])])
    );
    expect(fromRegistry).toEqual(T.NEEDS_TARGET);
  });

  it('marks mutating commands with a feedback policy or explicit none policy', () => {
    const mutating = T.COMMANDS.filter(c => c.mutates);
    expect(mutating.map(c => c.name).sort()).toEqual([
      'back', 'broadcast', 'click', 'clickxy', 'closetab', 'cookiedel', 'cookieset',
      'clock', 'dismiss-modal', 'drag', 'emulate', 'fill', 'forward', 'inject', 'jsclick', 'nav',
      'open', 'press', 'reload', 'replay', 'restore', 'responsive-audit', 'scroll', 'select', 'spawn-debug-browser',
      'stop', 'mock', 'qa', 'throttle', 'type', 'upload', 'verify-click', 'viewport',
    ].sort());
    for (const command of mutating) {
      expect(command.feedbackPolicy).toMatch(/^(none|settle-diff|full-perceive|state-change|report-only)$/);
    }
  });

  it('treats mutating commands as unsafe for parallel batch execution', () => {
    const missing = T.COMMANDS
      .filter(command => command.mutates)
      .flatMap(command => [command.name, ...(command.aliases || [])])
      .filter(name => !['viewport', 'resize'].includes(name) && !T.isBatchParallelUnsafeCommand(name));

    expect(missing).toEqual([]);
    expect(T.isBatchParallelUnsafeCommand('viewport', ['800x600'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('perceive')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('snap')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('snapshot')).toBe(false);
  });

  it('uses catalog authorization and kind to reject parallel side effects hidden by legacy mutates', () => {
    for (const name of [
      'hover', 'loadall',
      'shot', 'screenshot', 'diff-shot', 'diffshot', 'fullshot',
      'checkpoint', 'components', 'report', 'batch', 'flow', 'repeat',
      'not-a-command',
    ]) {
      expect(T.isBatchParallelUnsafeCommand(name), name).toBe(true);
    }
    expect(T.isBatchParallelUnsafeCommand('cookies')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('eval')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('status')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('frame')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('frames')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('console')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('console', ['--clear'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('netlog')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('netlog', ['--clear'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('dialog')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('dialog', ['accept'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('viewport')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('viewport', ['800x600'])).toBe(true);
  });

  it('keeps read-only extraction commands safe for parallel batch execution', () => {
    for (const name of [
      'controls', 'html', 'text', 'styles', 'summary', 'net', 'network', 'wait', 'waitfor',
      'list', 'current', 'status', 'overlay', 'perceive', 'eval', 'cascade', 'cookies',
    ]) {
      expect(T.isBatchParallelUnsafeCommand(name), name).toBe(false);
    }
    expect(T.isBatchParallelUnsafeCommand('table', ['#grid'])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('table', [
      '--continue', 'ct1.0123456789abcdef0123456789abcdef.0', '--format', 'json',
    ])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('table', [
      '#grid', '--collect', '--scroll-container', '.viewport',
    ])).toBe(true);
    expect(() => T.isBatchParallelUnsafeCommand('table', ['--collect'])).toThrow(/scroll-container/);
  });

  it('registers record-actions as a target command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'record-actions',
      aliases: ['recordactions'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers report as a target command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'report',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers doctor as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'doctor',
      aliases: ['ready'],
      needsTarget: false,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers help as a targetless command with text output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'help',
      aliases: [],
      needsTarget: false,
      mutates: false,
      outputFormats: ['text'],
    }));
  });

  it('registers list as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'list',
      aliases: ['tabs', 'ls'],
      needsTarget: false,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers open as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'open',
      aliases: [],
      needsTarget: false,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers replay as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'replay',
      aliases: [],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers batch structured JSON handoff as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'batch',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers flow structured JSON handoff as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'flow',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers export-playwright as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'export-playwright',
      aliases: ['export-pw'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers diff-shot as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'diff-shot',
      aliases: ['diffshot'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers cascade structured JSON handoff as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'cascade',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers throttle as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'throttle',
      aliases: ['network-throttle'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers mock as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'mock',
      aliases: ['network-mock'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers clock as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'clock',
      aliases: ['time-travel'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers checkpoint and restore commands', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'checkpoint',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'restore',
      aliases: [],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers frame listing as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'frame',
      aliases: ['frames'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers overlay detector as a read-only target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'overlay',
      aliases: ['overlays'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });
});

describe('helpStr', () => {
  it('returns the CLI usage with the golden path commands', () => {
    const out = helpStr();

    expect(out).toContain('Usage: cdp <command> [args]');
    expect(out).toContain('doctor / ready');
    expect(out).toContain('list|tabs|ls [--unsafe-full] [--format json]');
    expect(out).toContain('perceive <target>');
    expect(out).toContain('--perceive');
    expect(out).toMatch(/open\s+\[url\].*--perceive/s);
    expect(out).not.toContain('report <target>');
    expect(out).not.toMatch(/\bjsclick\s+</);
    expect(out).not.toMatch(/\beval64\s+</);
  });

  it('documents text --auto and perceive -x/--exclude', () => {
    const out = helpStr();
    expect(out).toMatch(/text <target>.*--auto|--auto:.*main content/s);
    expect(out).toContain('--auto');
    expect(out).toMatch(/-x <sel> \/ --exclude/);
  });
});

// =========================================================================
// Output formats
// =========================================================================

describe('parseFormatArgs', () => {
  it('defaults to text format', () => {
    expect(T.parseFormatArgs(['--runtime'])).toEqual({
      format: 'text',
      args: ['--runtime'],
    });
  });

  it('parses --format json and removes the option from command args', () => {
    expect(T.parseFormatArgs(['--runtime', '--format', 'json'])).toEqual({
      format: 'json',
      args: ['--runtime'],
    });
  });

  it('rejects unknown formats', () => {
    expect(() => T.parseFormatArgs(['--format', 'xml'], ['text', 'json'])).toThrow(/format must be text or json/);
  });

  it('serializes JSON models with indentation', () => {
    expect(T.formatJson({ schema: 'x', ok: true })).toBe('{\n  "schema": "x",\n  "ok": true\n}');
  });

  it('preserves trailing --format json when joining fill and type text args', () => {
    expect(normalizeTargetCommandArgs('fill', ['#cmd', 'look', 'merchant', '--format', 'json'])).toEqual([
      '#cmd',
      'look merchant',
      '--format',
      'json',
    ]);
    expect(normalizeTargetCommandArgs('fill', ['--react', '#cmd', 'look', 'merchant', '--format', 'json'])).toEqual([
      '--react',
      '#cmd',
      'look merchant',
      '--format',
      'json',
    ]);
    expect(normalizeTargetCommandArgs('type', ['hello', 'world', '--format', 'json'])).toEqual([
      'hello world',
      '--format',
      'json',
    ]);
  });

  it('preserves trailing --compact when joining fill and type text args', () => {
    expect(normalizeTargetCommandArgs('fill', ['#cmd', 'look', 'merchant', '--format', 'json', '--compact'])).toEqual([
      '#cmd',
      'look merchant',
      '--format',
      'json',
      '--compact',
    ]);
    expect(normalizeTargetCommandArgs('fill', ['--react', '#cmd', 'look', 'merchant', '--format', 'json', '--compact'])).toEqual([
      '--react',
      '#cmd',
      'look merchant',
      '--format',
      'json',
      '--compact',
    ]);
    expect(normalizeTargetCommandArgs('type', ['hello', 'world', '--format', 'json', '--compact'])).toEqual([
      'hello world',
      '--format',
      'json',
      '--compact',
    ]);
  });

  it('preserves trailing --full when joining fill text args', () => {
    expect(normalizeTargetCommandArgs('fill', ['#cmd', 'look', 'merchant', '--format', 'json', '--full'])).toEqual([
      '#cmd',
      'look merchant',
      '--format',
      'json',
      '--full',
    ]);
  });
});

// =========================================================================
// KEY_MAP
// =========================================================================

describe('KEY_MAP', () => {
  const expectedKeys = ['enter', 'tab', 'escape', 'backspace', 'delete', 'space',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

  it('should contain all documented keys', () => {
    for (const k of expectedKeys) {
      expect(KEY_MAP).toHaveProperty(k);
    }
  });

  it('should have correct structure for each entry', () => {
    for (const entry of Object.values(KEY_MAP)) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('code');
      expect(entry).toHaveProperty('keyCode');
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.code).toBe('string');
      expect(typeof entry.keyCode).toBe('number');
    }
  });

  it('should map enter to keyCode 13', () => {
    expect(KEY_MAP.enter.keyCode).toBe(13);
  });

  it('should map escape to keyCode 27', () => {
    expect(KEY_MAP.escape.keyCode).toBe(27);
  });
});

// =========================================================================
// ENRICHED_ROLES / INTERACTIVE_ROLES
// =========================================================================

describe('Role constants', () => {
  it('should include all landmark roles in ENRICHED_ROLES', () => {
    for (const r of ['banner', 'navigation', 'main', 'contentinfo', 'complementary']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include semantic structural roles in ENRICHED_ROLES', () => {
    for (const r of ['heading', 'img', 'form', 'table', 'dialog', 'region', 'article', 'alert']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include core interactive roles in INTERACTIVE_ROLES', () => {
    for (const r of ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'tab']) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(true);
    }
  });

  it('should have no overlap between ENRICHED and INTERACTIVE', () => {
    for (const r of ENRICHED_ROLES) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(false);
    }
    for (const r of INTERACTIVE_ROLES) {
      expect(ENRICHED_ROLES.has(r)).toBe(false);
    }
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

describe('formatCliError', () => {
  it('adds an executable doctor next step when CDP is unreachable', () => {
    const out = formatCliError(new Error('Cannot reach CDP on 127.0.0.1:9222 — is the app running with --remote-debugging-port=9222?'));

    expect(out).toContain('Error: Cannot reach CDP on 127.0.0.1:9222');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: browser-cdp');
    expect(out).toContain('Strategy: enable-existing-debugging');
    expect(out).toContain('Run: cdp doctor');
    expect(out).toMatch(/do not invent a new --user-data-dir/i);
    expect(out).toContain('Next: cdp doctor');
  });

  it('turns target resolution failures into list/open guidance', () => {
    const out = formatCliError(new Error('No target matching prefix "abc". Run "cdp list".'));

    expect(out).toContain('Error: No target matching prefix "abc". Run "cdp list".');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: target-resolution');
    expect(out).toContain('Strategy: rediscover-target');
    expect(out).toContain('Run: cdp list');
    expect(out).toContain('If the list is empty, open a page.');
    expect(out).not.toContain('# if empty');
    expect(out).toContain('Then: cdp open https://example.com');
    expect(out).toContain('Next: cdp list');
    expect(out).toContain('cdp open https://example.com');
  });

  it('turns ambiguous prefixes into a longer-prefix next step', () => {
    const out = formatCliError(new Error('Ambiguous prefix "AABB" — matches 2 targets. Use more characters.'));

    expect(out).toContain('Error: Ambiguous prefix "AABB"');
    expect(out).toContain('Next: cdp list');
    expect(out).toContain('Copy a longer target prefix');
  });

  it('turns daemon disconnects into a restartable perceive command', () => {
    const out = formatCliError(
      new Error('Connection closed before response. The daemon for this tab may have crashed or exited.'),
      { targetPrefix: 'AABBCCDD' }
    );

    expect(out).toContain('Error: Connection closed before response');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: daemon-disconnect');
    expect(out).toContain('Strategy: restart-tab-daemon');
    expect(out).toContain('Run: cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('Next: cdp perceive AABBCCDD -C -d 8');
  });

  it('classifies closed tab failures separately from daemon disconnects', () => {
    const out = formatCliError(
      new Error('Protocol error: Target closed'),
      { cmd: 'status', targetPrefix: 'AABBCCDD' }
    );

    expect(out).toContain('Kind: target-closed');
    expect(out).toContain('Strategy: rediscover-target');
    expect(out).toContain('Run: cdp list');
    expect(out).toContain('Then: cdp open https://example.com');
    expect(out).toContain('Next: cdp list');
    expect(out).not.toContain('Kind: daemon-disconnect');
  });

  it('turns EMFILE errors into fd-limit recovery commands', () => {
    const out = formatCliError(
      new Error('EMFILE: too many open files, open "/tmp/cdp.sock"'),
      { platform: 'darwin' }
    );

    expect(out).toContain('Error: EMFILE: too many open files');
    expect(out).toContain('Kind: fd-limit');
    expect(out).toContain('Strategy: raise-open-files-limit');
    expect(out).toContain('Run: ulimit -n 4096');
    expect(out).toContain('Then: sudo launchctl limit maxfiles 65536 200000');
    expect(out).toContain('Next: ulimit -n 4096');
  });

  it('preserves already-classified action failures', () => {
    const out = formatCliError('Kind: overlay\nNext: cdp dismiss-modal AABBCCDD');

    // #637: the lines pass through. Kind stays on its own line; Next is only the command.
    expect(out).toBe('Kind: overlay\nNext: cdp dismiss-modal AABBCCDD');
  });

  it('builds a structured JSON handoff for top-level CLI errors', () => {
    const model = T.buildCliErrorModel(new Error('target ID required. Run "cdp list" first.'), { cmd: 'perceive' });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'perceive',
      error: {
        message: 'target ID required. Run "cdp list" first.',
      },
      recovery: {
        kind: 'target-resolution',
        strategy: 'rediscover-target',
        run: 'cdp list',
        then: 'cdp open https://example.com',
      },
      nextSteps: [
        'cdp list',
        'cdp open https://example.com',
      ],
    });
  });

  it('formats top-level CLI errors as parseable JSON when requested', () => {
    const out = formatCliError(
      new Error('Connection closed before response. The daemon for this tab may have crashed or exited.'),
      { cmd: 'perceive', targetPrefix: 'AABBCCDD', format: 'json' }
    );
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.cli-error.v1');
    expect(parsed.recovery.kind).toBe('daemon-disconnect');
    expect(parsed.recovery.run).toBe('cdp perceive AABBCCDD -C -d 8');
    expect(parsed.nextSteps).toEqual(['cdp perceive AABBCCDD -C -d 8']);
    expect(out).not.toContain('Recovery:');
  });

  it('formats closed tab CLI errors as structured JSON recovery', () => {
    const out = formatCliError(
      new Error('Inspector.detached: target closed'),
      { cmd: 'status', targetPrefix: 'AABBCCDD', format: 'json' }
    );
    const parsed = JSON.parse(out);

    expect(parsed.recovery.kind).toBe('target-closed');
    expect(parsed.recovery.strategy).toBe('rediscover-target');
    expect(parsed.recovery.run).toBe('cdp list');
    expect(parsed.recovery.then).toBe('cdp open https://example.com');
    expect(parsed.nextSteps).toEqual(['cdp list', 'cdp open https://example.com']);
  });

  it('formats EMFILE CLI errors as structured fd-limit JSON when requested', () => {
    const out = formatCliError(
      new Error('too many open files'),
      { format: 'json', platform: 'darwin' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      recovery: {
        kind: 'fd-limit',
        strategy: 'raise-open-files-limit',
        run: 'ulimit -n 4096',
        then: 'sudo launchctl limit maxfiles 65536 200000',
        commands: [
          {
            scope: 'current-shell',
            command: 'ulimit -n 4096',
          },
          {
            scope: 'macos-login-session',
            command: 'sudo launchctl limit maxfiles 65536 200000',
            requiresAdmin: true,
          },
        ],
      },
      nextSteps: [
        'ulimit -n 4096',
        'sudo launchctl limit maxfiles 65536 200000',
      ],
    });
  });

  it('classifies missing action arguments as usage recovery instead of target status', () => {
    const out = formatCliError(new Error('selector required'), {
      cmd: 'fill',
      targetPrefix: 'AABBCCDD',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'fill',
      targetPrefix: 'AABBCCDD',
      recovery: {
        kind: 'usage',
        strategy: 'provide-required-argument',
        run: 'cdp fill AABBCCDD <selector|@ref> <text>',
      },
      nextSteps: ['cdp fill AABBCCDD <selector|@ref> <text>'],
    });
  });

  it('classifies missing nav URLs as a concrete navigation recovery', () => {
    const out = formatCliError(new Error('URL required'), {
      cmd: 'nav',
      targetPrefix: 'AABBCCDD',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.recovery.kind).toBe('navigation');
    expect(parsed.recovery.strategy).toBe('provide-url');
    expect(parsed.recovery.run).toBe('cdp nav AABBCCDD https://example.com');
    expect(parsed.nextSteps).toEqual(['cdp nav AABBCCDD https://example.com']);
  });
});

describe('formatDaemonCommandError', () => {
  it('preserves a halted flow model as the top-level JSON failure handoff', () => {
    const flow = {
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      counts: { steps: 2, ok: 0, failed: 1, skipped: 1 },
      failedStep: { index: 1, cmd: 'click', error: 'Element not found: #missing' },
      nextSteps: ['cdp perceive ABC123 -C -d 8'],
    };
    const parsed = JSON.parse(formatDaemonCommandError(JSON.stringify(flow), {
      cmd: 'flow', targetPrefix: 'ABC123', format: 'json',
    }));

    expect(parsed).toEqual(flow);
  });

  it('keeps ordinary JSON command errors on the cli-error schema', () => {
    const parsed = JSON.parse(formatDaemonCommandError('Element not found: #missing', {
      cmd: 'click', targetPrefix: 'ABC123', format: 'json',
    }));

    expect(parsed).toMatchObject({ schema: 'chrome-cdp-ex.cli-error.v1', ok: false, command: 'click' });
  });
});

describe('open onboarding guidance', () => {
  it('defaults open attach timeout to fail-fast and skips auto-perceive', () => {
    expect(T.DEFAULT_OPEN_ATTACH_TIMEOUT_MS).toBe(5000);
    expect(T.parseOpenArgs(['https://example.com'], {})).toEqual({
      url: 'https://example.com',
      format: 'text',
      attachTimeoutMs: 5000,
      readyTimeoutMs: 5000,
      readySelector: null,
      reuseUrl: false,
      perceive: false,
      background: true,
      backgroundExplicit: false,
    });
  });

  it('parses --perceive as opt-in auto-perceive without changing fail-fast attach', () => {
    expect(T.parseOpenArgs(['https://example.com', '--perceive'], {})).toEqual({
      url: 'https://example.com',
      format: 'text',
      attachTimeoutMs: 5000,
      readyTimeoutMs: 5000,
      readySelector: null,
      reuseUrl: false,
      perceive: true,
      background: true,
      backgroundExplicit: false,
    });
  });

  it('parses bounded attach waiting for JSON/open automation', () => {
    expect(T.parseOpenArgs(['https://example.com', '--attach-timeout-ms', '0', '--format', 'json'], {})).toEqual({
      url: 'https://example.com',
      format: 'json',
      attachTimeoutMs: 0,
      readyTimeoutMs: 0,
      readySelector: null,
      reuseUrl: false,
      perceive: false,
      background: true,
      backgroundExplicit: false,
    });
    expect(T.parseOpenArgs(['--attach-timeout-ms=1200', '--ready-timeout-ms', '2500', '--ready-selector', '#app'], {})).toEqual({
      url: 'about:blank',
      format: 'text',
      attachTimeoutMs: 1200,
      readyTimeoutMs: 2500,
      readySelector: '#app',
      reuseUrl: false,
      perceive: false,
      background: true,
      backgroundExplicit: false,
    });
    expect(() => T.parseOpenArgs(['https://example.com', '--attach-timeout-ms', 'nope'])).toThrow('open: --attach-timeout-ms must be a non-negative integer');
    expect(() => T.parseOpenArgs(['https://example.com', '--ready-timeout-ms', 'nope'])).toThrow('open: --ready-timeout-ms must be a non-negative integer');
    expect(() => T.parseOpenArgs(['https://example.com', '--ready-selector'])).toThrow('open: --ready-selector requires a CSS selector');
  });

  it('builds page-side navigation for open onboarding', () => {
    const script = T.openNavigationScript('https://example.com/path?x="quoted"');

    expect(script).toContain('location.assign("https://example.com/path?x=\\"quoted\\"")');
    expect(script).toContain('return JSON.stringify');
    expect(script).toContain('location.assign');
  });

  it('checks open readiness through a disposable direct CDP session', async () => {
    const calls = [];
    let closed = false;
    const client = {
      async connect(url) { calls.push(['connect', url]); },
      async send(method, params, sessionId) {
        calls.push([method, params, sessionId]);
        if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: JSON.stringify({
                href: 'https://example.com/app',
                readyState: 'complete',
                selectorFound: true,
              }),
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      },
      close() { closed = true; },
    };

    const ready = await T.waitForOpenReady('AABBCCDDEEFF', {
      timeoutMs: 1000,
      url: 'https://example.com/app',
      selector: '#app',
      createCdp: () => client,
      getWsUrlFn: async () => 'ws://example.test/devtools/browser/1',
    });

    expect(ready).toMatchObject({
      attempted: true,
      ok: true,
      href: 'https://example.com/app',
      readyState: 'complete',
      selector: '#app',
      selectorFound: true,
    });
    expect(calls.map(call => call[0])).toEqual([
      'connect',
      'Target.attachToTarget',
      'Runtime.evaluate',
    ]);
    expect(calls[2][1].expression).toContain('document.querySelector("#app")');
    expect(calls[2][2]).toBe('session-1');
    expect(closed).toBe(true);
  });

  it('formats a compact next perceive command after open without auto-perceive', () => {
    expect(formatOpenNextPerceiveCommand('AABBCCDDEEFF')).toBe('Next: cdp text AABBCCDD --auto');
  });

  it('formats the allow-debugging wait banner only as an explicit helper', () => {
    expect(formatOpenAttachWaitMessage(5000)).toBe(
      'Waiting for "Allow debugging?" approval in Chrome... (up to 5s)'
    );
    expect(formatOpenAttachWaitMessage(60000)).toContain('1m');
  });

  it('does not announce the allow-debugging banner on the first daemon-boot miss', () => {
    expect(shouldAnnounceOpenAttachWait({ failedConnects: 1, elapsedMs: 300 })).toBe(false);
    expect(shouldAnnounceOpenAttachWait({ failedConnects: 2, elapsedMs: 900 })).toBe(false);
    expect(shouldAnnounceOpenAttachWait({ failedConnects: 3, elapsedMs: 1500 })).toBe(true);
    expect(shouldAnnounceOpenAttachWait({ failedConnects: 2, elapsedMs: 1000 })).toBe(true);
  });

  it('formats a ready continuation after open auto-perceives the page', () => {
    const out = formatOpenReadyMessage('AABBCCDDEEFF', 'https://example.com');

    expect(out).toContain('Tab ready');
    expect(out).toContain('Target: AABBCCDD');
    expect(out).toContain('Next: cdp click AABBCCDD @ref');
    expect(out).toContain('Then: cdp perceive AABBCCDD --since-action');
    expect(out).toContain('Report: cdp report AABBCCDD');
  });

  it('builds a JSON model for a ready opened tab', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'https://example.com',
      attached: true,
      autoPerceive: { attempted: true, ok: true },
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.open.v1',
      targetId: 'AABBCCDDEEFF',
      targetPrefix: 'AABBCCDD',
      url: 'https://example.com',
      attached: true,
      approval: 'approved',
      autoPerceive: { attempted: true, ok: true },
      nextSteps: [
        'cdp click AABBCCDD @ref',
        'cdp perceive AABBCCDD --since-action',
        'cdp report AABBCCDD',
      ],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'act',
      targetPrefix: 'AABBCCDD',
      run: 'cdp click AABBCCDD @ref',
      after: 'cdp perceive AABBCCDD --since-action',
      report: 'cdp report AABBCCDD',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.commands).toEqual([
      'cdp click AABBCCDD @ref',
      'cdp perceive AABBCCDD --since-action',
      'cdp report AABBCCDD',
    ]);
    expect(model.nextSteps).toEqual(model.recommendation.commands);
  });

  it('recommends perceive when open JSON skipped auto-perceive output', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'about:blank',
      attached: true,
      autoPerceive: { attempted: false, ok: false, reason: 'json-output' },
    });

    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'read-page',
      targetPrefix: 'AABBCCDD',
      run: 'cdp text AABBCCDD --auto',
      after: 'cdp perceive AABBCCDD --cards',
    });
  });

  it('formats a timeout recovery when browser permission is not approved yet', () => {
    const out = formatOpenTimeoutMessage('AABBCCDDEEFF');

    expect(out).toContain('Timeout waiting for debugging approval');
    expect(out).toContain('Target: AABBCCDD');
    expect(out).toContain('Next: cdp text AABBCCDD --auto');
    expect(out).toContain('click Allow');
  });

  it('builds a JSON model for an opened tab that still needs approval', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'about:blank',
      attached: false,
      autoPerceive: { attempted: false, ok: false, reason: 'not-attached' },
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.open.v1',
      targetPrefix: 'AABBCCDD',
      url: 'about:blank',
      attached: false,
      approval: 'pending',
      autoPerceive: { attempted: false, ok: false, reason: 'not-attached' },
      nextSteps: [
        'cdp perceive AABBCCDD -C -d 8',
      ],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'browser-permission',
      targetPrefix: 'AABBCCDD',
      run: 'cdp perceive AABBCCDD -C -d 8',
      ask: 'Click Allow if Chrome asks.',
      requiresUserAction: true,
      consentRequired: false,
    });
  });

  it('formats auto-perceive failure with actionable recovery', () => {
    const out = formatOpenAutoPerceiveFailure(
      new Error('Connection closed before response. The daemon for this tab may have crashed.'),
      'AABBCCDDEEFF'
    );

    expect(out).toContain('Auto-perceive failed');
    expect(out).toContain('Next: cdp perceive AABBCCDD -C -d 8');
  });
});

// =========================================================================
// spawn-debug-browser arg parsing + plan
// =========================================================================

describe('spawn-debug-browser topic help (#398)', () => {
  const { parseSpawnDebugBrowserArgs, helpTopicStr, SPAWN_DEBUG_BROWSER_FLAGS } = T;
  const source = runtimeSource();
  const parserBody = source.slice(
    source.indexOf('function parseSpawnDebugBrowserArgs'),
    source.indexOf('async function listSpawnedDebugTargets'),
  );
  const parserFlags = [...new Set([...parserBody.matchAll(/['"](-{1,2}[a-z][a-z-]*)=?['"]/g)].map(m => m[1]))];

  it('finds the flags the parser accepts (guards this test itself)', () => {
    expect(parserFlags).toEqual(expect.arrayContaining(['--port', '--daily-profile', '--profile-dir', '--exe']));
  });

  it('lists every flag the parser accepts in `help spawn-debug-browser`', () => {
    const help = helpTopicStr('spawn-debug-browser');
    for (const flag of [...parserFlags, '--format']) expect(help, flag).toContain(flag);
  });

  it('documents only flags the parser accepts', () => {
    const noValue = new Set(['--daily-profile', '--headless', '--no-sandbox', '--disable-gpu', '--allow-occlusion', '--background']);
    for (const entry of SPAWN_DEBUG_BROWSER_FLAGS) {
      for (const flag of entry.flags) {
        if (flag === '--help' || flag === '-h' || flag === '--format') continue;
        const args = noValue.has(flag) ? [flag] : [flag, entry.arg === 'N' ? '1' : 'x'];
        expect(parseSpawnDebugBrowserArgs(args, { TMPDIR: '/tmp' }).helpRequested, flag).toBeUndefined();
      }
    }
  });

  it('says what happens when the port is occupied and what to set afterwards', () => {
    const help = helpTopicStr('spawn-debug-browser');
    expect(help).toMatch(/already in use/i);
    expect(help).toContain('--port N');
    expect(help).toContain('CDP_PORT=N');
    expect(help).toContain('CDP_DEBUG_BROWSER');
  });

  it('keeps `help spawn-debug-browser` and the `spawn` alias identical', () => {
    expect(helpTopicStr('spawn')).toBe(helpTopicStr('spawn-debug-browser'));
  });

  it('leaves other topic help unchanged', () => {
    const stop = helpTopicStr('stop');
    expect(stop).not.toContain('CDP_DEBUG_BROWSER');
    expect(stop.trimEnd().split('\n')).toHaveLength(3);
  });
});
