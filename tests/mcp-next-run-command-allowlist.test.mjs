import { describe, expect, it } from 'vitest';

import { MCP_RUN_COMMAND_ALLOWLIST } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { nextEmittedCommands } from '../scripts/lib/next-emitted-commands.mjs';
import {
  nextCommandsMissingFromAllowlist,
} from '../scripts/check-next-run-command.mjs';

const COMMANDS = [
  { name: 'click', aliases: ['tap'] },
  { name: 'eval', aliases: [] },
  { name: 'help', aliases: [] },
  { name: 'nav', aliases: ['navigate'] },
  { name: 'replay', aliases: [] },
];

function source(name, text) {
  return { name, text };
}

describe('Next commands are derived from source', () => {
  it('reads a literal Next command and ignores a comment', () => {
    const emitted = nextEmittedCommands({
      commands: COMMANDS,
      sources: [source('sample.mjs', `
        // Next: cdp replay T
        export function format() {
          return 'Next: cdp click T "#save"';
        }
      `)],
    });
    expect(emitted).toEqual(['click']);
  });

  it('expands suggestCommands to catalog names and commandUsageTemplate to the spellings it prints', () => {
    const emitted = nextEmittedCommands({
      commands: COMMANDS,
      sources: [source('sample.mjs', `
        function suggestCommands(input) {
          const exact = commandMeta(input);
          if (exact && exact.name !== input) return [exact.name];
          for (const command of COMMANDS) scored.push({ name: command.name });
          return scored.map(entry => entry.name);
        }
        function commandUsageTemplate(cmd = '', target = '<target>') {
          switch (cmd) {
            case 'nav':
            case 'navigate':
              return \`cdp nav \${target}\`;
            default:
              return \`cdp \${cmd || '<command>'} \${target}\`;
          }
        }
        function recover(message) {
          if (message.includes('unknown command')) {
            const suggestions = suggestCommands(message);
            if (suggestions.length) return { run: \`cdp \${suggestions[0]}\` };
          }
          if (message.includes('required')) return { run: commandUsageTemplate('click', 'T') };
        }
      `)],
    });
    // `navigate` is rewritten to `nav`. `tap` is not a case label, so the default prints it.
    expect(emitted).toEqual(['click', 'eval', 'help', 'nav', 'replay', 'tap']);
    expect(emitted).not.toContain('navigate');
  });

  it('expands an action Next to the actionFeedback commands', () => {
    const emitted = nextEmittedCommands({
      commands: COMMANDS,
      sources: [source('sample.mjs', `
        function classify(action = 'click') {
          const usage = \`cdp \${action || 'click'} T <selector>\`;
          return { nextCommand: usage };
        }
        async function run() {
          await actionFeedback('hover', () => {});
          await actionFeedback('fill', () => {});
        }
      `)],
    });
    expect(emitted).toEqual(['click', 'fill', 'hover']);
  });
});

describe('run_command accepts every Next-emitted command', () => {
  it('fails when the allowlist is missing a command the source can print', () => {
    expect(nextCommandsMissingFromAllowlist()).toEqual([]);
  });

  it('reports the command removed from an otherwise complete allowlist', () => {
    const missing = nextCommandsMissingFromAllowlist();
    expect(missing).toEqual([]);
    const withoutEval = MCP_RUN_COMMAND_ALLOWLIST.filter(name => name !== 'eval');
    expect(nextCommandsMissingFromAllowlist({ allowlist: withoutEval })).toEqual(['eval']);
  });
});
