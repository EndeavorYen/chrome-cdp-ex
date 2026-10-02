import { describe, expect, it } from 'vitest';
import { join } from 'path';

const { resolveNpmInvocation, runNpm } = await import('../scripts/check-public-contracts.mjs');

const NODE = join('/opt', 'node', 'bin', 'node');

describe('#516 check-public-contracts runs npm without a shell', () => {
  it('prefers npm_execpath when it is npm\'s JS entry point', () => {
    const invocation = resolveNpmInvocation({
      env: { npm_execpath: '/x/npm/bin/npm-cli.js' },
      execPath: NODE,
      exists: () => true,
    });
    expect(invocation).toEqual({ command: NODE, prefix: ['/x/npm/bin/npm-cli.js'] });
  });

  it('falls back to the npm bundled beside the Node binary (Windows layout)', () => {
    const bundled = join(join('/opt', 'node', 'bin'), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const invocation = resolveNpmInvocation({
      env: {},
      execPath: NODE,
      exists: path => path === bundled,
    });
    expect(invocation).toEqual({ command: NODE, prefix: [bundled] });
  });

  it('falls back to the npm of a POSIX install prefix (bin/node, lib/node_modules/npm)', () => {
    const prefixed = join(join('/opt', 'node', 'bin'), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const invocation = resolveNpmInvocation({
      env: {},
      execPath: NODE,
      exists: path => path === prefixed,
    });
    expect(invocation).toEqual({ command: NODE, prefix: [prefixed] });
  });

  it.each([
    '/usr/local/bin/pnpm',
    '/usr/lib/node_modules/pnpm/bin/pnpm.cjs',
    '/usr/lib/node_modules/yarn/bin/yarn.js',
  ])('ignores npm_execpath %s, which is not npm, and uses a bare npm only as the last resort', execpath => {
    const invocation = resolveNpmInvocation({
      env: { npm_execpath: execpath },
      execPath: NODE,
      exists: path => path === execpath,
    });
    expect(invocation).toEqual({ command: 'npm', prefix: [] });
  });

  it('reports a spawn failure instead of crashing on null stderr', () => {
    const spawn = () => ({ status: null, stdout: null, stderr: null, error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) });
    expect(() => runNpm(['pack'], { invocation: { command: 'npm', prefix: [] }, spawn }))
      .toThrow('npm pack could not start (npm): spawn npm ENOENT');
  });

  it('reports a non-zero exit with whatever output there is', () => {
    const spawn = () => ({ status: 1, stdout: '', stderr: 'npm ERR! boom\n' });
    expect(() => runNpm(['pack'], { invocation: { command: 'npm', prefix: [] }, spawn }))
      .toThrow('npm pack failed (exit 1): npm ERR! boom');
  });

  it('passes the prefix, args and cwd through with shell:false', () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '[]', stderr: '' };
    };
    expect(runNpm(['pack', '--json'], { cwd: '/repo', invocation: { command: NODE, prefix: ['/n/npm-cli.js'] }, spawn })).toBe('[]');
    expect(calls).toEqual([{
      command: NODE,
      args: ['/n/npm-cli.js', 'pack', '--json'],
      options: { cwd: '/repo', encoding: 'utf8', shell: false, windowsHide: true },
    }]);
  });

  it('really runs npm on this host (Linux and Windows CI)', () => {
    expect(runNpm(['--version']).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
