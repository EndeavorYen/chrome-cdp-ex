import { spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectBrowserPath } from '../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVE = join(REPO, '.cursor/skills/verify-chrome-cdp-ex/helpers/drive-once.sh');

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

describe('drive-once.sh user path', () => {
  const browser = browserPath();

  async function driveOnce(extraEnv = {}) {
    const evidence = mkdtempSync(join(tmpdir(), 'cdp-verify-drive-'));
    const cdpPort = await freePort();
    const httpPort = await freePort();
    const env = {
      ...process.env,
      CHROME_BIN: browser,
      CDP_VERIFY_PORT: String(cdpPort),
      CDP_VERIFY_HTTP_PORT: String(httpPort),
      ...extraEnv,
    };
    if (!Object.prototype.hasOwnProperty.call(extraEnv, 'CDP_VERIFY_NO_ONCLICK')) {
      delete env.CDP_VERIFY_NO_ONCLICK;
    }
    const result = spawnSync('bash', [DRIVE, REPO, evidence], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 120000,
    });
    return { evidence, result };
  }

  it.skipIf(!browser || process.platform === 'win32')('passing run exits 0', async () => {
    const { evidence, result } = await driveOnce();
    try {
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 120000);

  it.skipIf(!browser || process.platform === 'win32')('CDP_VERIFY_NO_ONCLICK=1 exits non-zero and the transcript contains click-no-change', async () => {
    const { evidence, result } = await driveOnce({ CDP_VERIFY_NO_ONCLICK: '1' });
    try {
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).not.toBe(0);
      expect(result.status, output).not.toBe(null);
      const transcript = readFileSync(join(evidence, 'transcript.txt'), 'utf8');
      expect(transcript, output).toContain('click-no-change');
    } finally {
      rmSync(evidence, { recursive: true, force: true });
    }
  }, 120000);
});
