import { describe, expect, it } from 'vitest';
import {
  classifyFrameOrigin,
  frameSiteMatches,
  parseFrameSiteEntry,
  parseFrameSites,
} from '../skills/chrome-cdp-ex/scripts/lib/frame-sites.mjs';

function entry(raw) {
  return parseFrameSiteEntry(raw);
}

function matches(raw, origin) {
  return frameSiteMatches(origin, [entry(raw)]);
}

describe('CDP_FRAME_SITES parser', () => {
  it('accepts https with and without a port, and treats :443 as the default port', () => {
    const plain = entry('https://pay.example.com');
    const portless = entry('https://pay.example.com:443');
    expect(plain).toMatchObject({ protocol: 'https:', hostname: 'pay.example.com', port: '', wildcard: false });
    expect(portless.port).toBe('');
    expect(matches('https://pay.example.com:443', 'https://pay.example.com')).toBe(true);
    expect(matches('https://pay.example.com', 'https://pay.example.com:443')).toBe(true);
    const explicit = entry('https://pay.example.com:8443');
    expect(explicit.port).toBe('8443');
    expect(frameSiteMatches('https://pay.example.com:8443', [explicit])).toBe(true);
    expect(frameSiteMatches('https://pay.example.com', [explicit])).toBe(false);
  });

  it('strips one trailing dot, lowercases the host, and converts IDN to punycode', () => {
    expect(entry('https://Pay.Example.com').hostname).toBe('pay.example.com');
    expect(entry('https://pay.example.com.').hostname).toBe('pay.example.com');
    expect(matches('https://pay.example.com.', 'https://pay.example.com')).toBe(true);
    expect(entry('https://bücher.example').hostname).toBe('xn--bcher-kva.example');
    expect(matches('https://bücher.example', 'https://xn--bcher-kva.example')).toBe(true);
  });

  it('accepts loopback http only for localhost, 127.0.0.1 and [::1]', () => {
    expect(entry('http://localhost')).toMatchObject({ protocol: 'http:', hostname: 'localhost', port: '' });
    expect(entry('http://127.0.0.1')).toMatchObject({ protocol: 'http:', hostname: '127.0.0.1', port: '' });
    expect(entry('http://[::1]')).toMatchObject({ protocol: 'http:', hostname: '::1', port: '' });
    expect(entry('https://[::1]')).toMatchObject({ protocol: 'https:', hostname: '::1' });
    expect(matches('http://localhost', 'http://localhost')).toBe(true);
    expect(matches('http://127.0.0.1', 'http://127.0.0.1')).toBe(true);
    expect(matches('http://[::1]', 'http://[::1]')).toBe(true);
  });

  it('rejects bare *, userinfo, path, query, empty host, IPv6 without brackets, and a star outside the first label', () => {
    for (const bad of [
      '*',
      'https://a@b',
      'https://pay.example.com/checkout',
      'https://pay.example.com?x=1',
      'https://pay.example.com#frag',
      'https://',
      'http://::1',
      'https://::1',
      'https://ex*.example.com',
      'https://*.pay.example.com/extra',
    ]) {
      expect(() => entry(bad), bad).toThrow(/^policy config: /);
    }
  });

  it('rejects non-https non-loopback, a single-label wildcard, and public-suffix wildcards', () => {
    for (const bad of [
      'http://pay.example.com',
      'http://127.0.0.2',
      'http://[::ffff:127.0.0.1]',
      'https://*.com',
      'https://*.co.uk',
      'https://*.github.io',
      'https://*.com.au',
    ]) {
      expect(() => entry(bad), bad).toThrow(/^policy config: /);
    }
  });

  it('does not match other loopback spellings, a wildcard bare host, or a non-default port', () => {
    expect(matches('http://localhost', 'http://127.0.0.2')).toBe(false);
    expect(matches('http://[::1]', 'http://[::ffff:127.0.0.1]')).toBe(false);
    expect(matches('http://127.0.0.1', 'http://127.0.0.2')).toBe(false);
    expect(matches('https://*.example.com', 'https://example.com')).toBe(false);
    expect(matches('https://*.example.com', 'https://evil-example.com')).toBe(false);
    expect(matches('https://*.example.com', 'https://example.com.evil.com')).toBe(false);
    expect(matches('https://*.example.com', 'https://pay.example.com')).toBe(true);
    expect(matches('https://pay.example.com', 'https://pay.example.com:8443')).toBe(false);
    expect(matches('http://localhost', 'http://localhost:9')).toBe(false);
  });

  it('treats the public-suffix list as a floor, so *.example.com is accepted and does not match the bare host', () => {
    expect(entry('https://*.example.com').wildcard).toBe(true);
    expect(matches('https://*.example.com', 'https://example.com')).toBe(false);
    expect(matches('https://*.example.com', 'https://a.example.com')).toBe(true);
  });

  it('parses a comma-separated list and treats an empty value as unset', () => {
    expect(parseFrameSites('')).toBeNull();
    expect(parseFrameSites('  ,  ')).toBeNull();
    const list = parseFrameSites('https://pay.example.com, https://*.example.com');
    expect(list).toHaveLength(2);
    expect(frameSiteMatches('https://a.example.com', list)).toBe(true);
    expect(() => parseFrameSites('https://pay.example.com,*')).toThrow(/^policy config: /);
  });
});

describe('frame origin classification', () => {
  const allowed = parseFrameSites('https://pay.example.com, http://localhost');

  it('classifies sandboxed, data, and opaque blob origins as opaque-origin', () => {
    for (const origin of ['', 'null', '://', 'data:text/html,hi', 'blob:null/uuid']) {
      expect(classifyFrameOrigin(origin, allowed), origin).toMatchObject({ read: false, reason: 'opaque-origin' });
    }
  });

  it('gates about:srcdoc on the inherited origin', () => {
    expect(classifyFrameOrigin('https://pay.example.com', allowed)).toEqual({
      read: true,
      origin: 'https://pay.example.com',
    });
    expect(classifyFrameOrigin('https://ads.example.com', allowed)).toMatchObject({
      read: false,
      reason: 'not-allowlisted',
      origin: 'https://ads.example.com',
    });
  });

  it('checks https before the allowlist, and unset before not-allowlisted', () => {
    expect(classifyFrameOrigin('http://pay.example.com', null)).toMatchObject({ reason: 'not-https' });
    expect(classifyFrameOrigin('http://pay.example.com', allowed)).toMatchObject({ reason: 'not-https' });
    expect(classifyFrameOrigin('http://127.0.0.2', allowed)).toMatchObject({ reason: 'not-https' });
    expect(classifyFrameOrigin('https://pay.example.com', null)).toMatchObject({ reason: 'unset' });
    expect(classifyFrameOrigin('http://localhost', allowed)).toEqual({ read: true, origin: 'http://localhost' });
    expect(classifyFrameOrigin('http://localhost:9', allowed)).toMatchObject({ reason: 'not-allowlisted' });
  });

  it('treats a data:, blob:, or null prefix as opaque before the URL origin is reused', () => {
    for (const origin of [
      'data:text/html,hi',
      'data:https://pay.example.com',
      'blob:https://pay.example.com/uuid',
      'blob:http://localhost/x',
      'null',
    ]) {
      expect(classifyFrameOrigin(origin, allowed), origin).toEqual({
        read: false,
        reason: 'opaque-origin',
        origin: null,
      });
    }
  });
});
