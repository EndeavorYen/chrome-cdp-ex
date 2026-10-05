import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function cmdText(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('#557 Windows chrome-cdp.cmd', () => {
  it('T1 both launchers call node on the sibling chrome-cdp', () => {
    for (const relativePath of ['bin/chrome-cdp.cmd', 'skills/chrome-cdp-ex/bin/chrome-cdp.cmd']) {
      const text = cmdText(relativePath).replace(/\r\n/g, '\n');
      expect(text).toBe('@echo off\nnode "%~dp0chrome-cdp" %*\n');
    }
  });

  it('T2 SKILL.md tells Windows to run chrome-cdp.cmd', () => {
    const skill = readFileSync(resolve(root, 'skills/chrome-cdp-ex/SKILL.md'), 'utf8');
    expect(skill).toContain('On Windows, PowerShell does not run that extensionless file: use `bin/chrome-cdp.cmd`');
  });

  it.runIf(process.platform === 'win32')('T3 cmd /c help exits 0 and prints usage', () => {
    const cmd = resolve(root, 'skills/chrome-cdp-ex/bin/chrome-cdp.cmd');
    const res = spawnSync('cmd.exe', ['/c', cmd, 'help'], { encoding: 'utf8' });
    expect(res.status, res.stderr || res.error?.message).toBe(0);
    expect(res.stdout).toMatch(/cdp help/);
  });
});
