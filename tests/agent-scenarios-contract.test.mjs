import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { deflateSync } from 'zlib';
import { describe, expect, it } from 'vitest';

import {
  SCENARIO_TYPES, assertSpec, commandLines, decodePng, prefixFromList, refAfter, refFor, transcriptText, userWordsFor, verdict,
} from '../scripts/lib/agent-scenario-harness.mjs';
import { validateScenarioRegistry } from '../scripts/lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const registry = JSON.parse(readFileSync(join(rootDir, 'validation/scenarios/registry.v1.json'), 'utf8'));
const scenarioFiles = readdirSync(join(rootDir, 'validation/scenarios')).filter(f => /^\d\d-.*\.mjs$/.test(f)).sort();

async function loadModules() {
  return Promise.all(registry.scenarios.map(entry => import(pathToFileURL(join(rootDir, entry.runner.entrypoint)).href)));
}

describe('agent scenario registry (validation/scenarios)', () => {
  it('is a validation-lab registry of live loopback scenarios, outside the default selection', () => {
    const valid = validateScenarioRegistry(registry, { rootDir });
    expect(valid.scenarios).toHaveLength(12);
    for (const entry of valid.scenarios) {
      expect(entry.risk).toMatchObject({ network: 'loopback', browser: 'disposable-local', mutation: 'task-created-files' });
      expect(entry.tags).toEqual(expect.arrayContaining(['live', 'agent-scenario']));
      expect(entry.tags).not.toContain('default');
      expect(entry.runner.args).toEqual(['--self-test']);
      expect(entry.expect).toEqual({ exitCodes: [0], stdoutIncludes: [`Scenario ${entry.id} OK:`] });
    }
  });

  it('lists every scenario file once, in file order', () => {
    expect(registry.scenarios.map(entry => entry.runner.entrypoint)).toEqual(scenarioFiles.map(f => `validation/scenarios/${f}`));
  });

  it('pairs each entry with a module whose spec is complete and matches', async () => {
    const modules = await loadModules();
    modules.forEach((mod, index) => {
      const entry = registry.scenarios[index];
      const spec = assertSpec(mod.scenario);
      expect(spec.id).toBe(entry.id);
      expect(spec.title).toBe(entry.title);
      expect(entry.tags).toContain(spec.kind);
      expect(entry.tags).toContain(`type-${String(spec.type).padStart(2, '0')}`);
      for (const fn of ['createApps', 'setup', 'reference', 'trap', 'judge']) expect(typeof mod[fn], `${spec.id}.${fn}`).toBe('function');
    });
  });

  it('covers the twelve scenario types once each, with at most half static pages', async () => {
    const specs = (await loadModules()).map(mod => mod.scenario);
    expect(specs.map(s => s.type).sort((a, b) => a - b)).toEqual(Object.keys(SCENARIO_TYPES).map(Number));
    expect(specs.filter(s => s.kind === 'static-page').length).toBeLessThanOrEqual(6);
  });

  it('is documented in docs/audit/scenarios.md with the same user words', async () => {
    const doc = readFileSync(join(rootDir, 'docs/audit/scenarios.md'), 'utf8');
    for (const mod of await loadModules()) {
      expect(doc).toContain(mod.scenario.id);
      expect(doc).toContain(mod.scenario.userWords);
    }
  });
});

describe('agent scenario harness helpers', () => {
  const tree = [
    '[RootWebArea] Settings',
    '      [combobox] Session timeout = "30 minutes"  @1  (177,193 320×34)',
    '      [checkbox] Require two-factor sign-in checked=true  @7  (181,312 13×13)',
    '            [switch] new-checkout checked=false  @3  (742,238 51×34)',
    '        [cell] #1041',
    '            [button] Approve  @4  (847,202 86×34)',
    '        [cell] #1042',
    '            [button] Approve  @6  (847,270 86×34)',
    '        [button] Ceramic Brake Pad Set — Rear  @9  (157,308 228×34)',
    '        [button] Ceramic Brake Pad Set  @8  (157,274 176×34)',
    '      [textbox] Card holder  @f2:1  (139,219 185×35)',
  ].join('\n');

  it('finds refs by role and exact name, ignoring values and states', () => {
    expect(refFor(tree, 'combobox', 'Session timeout')).toBe('@1');
    expect(refFor(tree, 'checkbox', 'Require two-factor sign-in')).toBe('@7');
    expect(refFor(tree, 'switch', 'new-checkout')).toBe('@3');
    expect(refFor(tree, 'button', 'Ceramic Brake Pad Set')).toBe('@8');
    expect(refFor(tree, 'textbox', 'Card holder')).toBe('@f2:1');
    expect(refFor(tree, 'button', 'Missing')).toBeNull();
  });

  it('finds a ref after an anchor line', () => {
    expect(refFor(tree, 'button', 'Approve')).toBe('@4');
    expect(refAfter(tree, /#1042/, 'button', 'Approve')).toBe('@6');
    expect(refAfter(tree, /#9999/, 'button', 'Approve')).toBeNull();
  });

  it('reads list rows and substitutes the requested download folder', () => {
    const list = [
      '74F35114  Feature flags · Acme                                    http://127.0.0.1:12185/env/production/flags *',
      'EC7B50C7  Feature flags · Acme                                    http://127.0.0.1:12185/env/staging/flags',
    ].join('\n');
    expect(prefixFromList(list, row => row.url.includes('/staging/'))).toBe('EC7B50C7');
    expect(prefixFromList(list, row => row.title === 'Nope')).toBeNull();
    expect(userWordsFor({ userWords: '存到 {downloadDir}' }, { downloadDir: 'D:/out' })).toBe('存到 D:/out');
  });

  it('decodes 8-bit RGB and RGBA PNGs', () => {
    const png = (colorType, rows) => {
      const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
      };
      const width = rows[0].length;
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(rows.length, 4);
      ihdr[8] = 8;
      ihdr[9] = colorType;
      // Row 0 unfiltered, row 1 with the Sub filter (each byte minus the byte one pixel to the left).
      const channels = colorType === 6 ? 4 : 3;
      const raw = rows.map((row, y) => {
        const bytes = row.flat();
        const filtered = y === 0 ? bytes : bytes.map((v, i) => (i >= channels ? (v - bytes[i - channels]) & 0xff : v));
        return Buffer.from([y === 0 ? 0 : 1, ...filtered]);
      });
      return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))]);
    };
    const rgb = decodePng(png(2, [[[255, 0, 0], [0, 255, 0]], [[0, 0, 255], [10, 20, 30]]]));
    expect([rgb.width, rgb.height]).toEqual([2, 2]);
    expect(rgb.pixel(0, 0)).toEqual([255, 0, 0, 255]);
    expect(rgb.pixel(1, 1)).toEqual([10, 20, 30, 255]);
    const rgba = decodePng(png(6, [[[1, 2, 3, 4], [5, 6, 7, 8]], [[9, 10, 11, 12], [200, 100, 50, 25]]]));
    expect(rgba.pixel(1, 1)).toEqual([200, 100, 50, 25]);
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/not a PNG/);
  });

  it('turns checks into a verdict and reads transcripts', () => {
    const result = verdict([{ code: 'a', ok: true }, { code: 'b', ok: false, detail: 'why' }]);
    expect(result.pass).toBe(false);
    expect(result.failures).toEqual([{ code: 'b', detail: 'why' }]);
    const transcript = [{ args: ['scanshot', 'AB12CD34'], stdout: 'saved', stderr: '' }, { args: ['list'], stdout: '', stderr: 'oops' }];
    expect(commandLines(transcript)).toEqual(['scanshot AB12CD34', 'list']);
    expect(transcriptText(transcript)).toBe('saved\noops');
  });

  it('rejects an incomplete spec', () => {
    expect(() => assertSpec({ id: 'agent-01-x', type: 1, kind: 'dynamic-app', title: 't', userWords: 'u' })).toThrow(/startState/);
  });
});
