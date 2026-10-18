# Pi / pi-coding-agent

## Install

This package declares skill discovery in `package.json`:

```json
{
  "pi": {
    "skills": ["./skills"]
  }
}
```

From the package root (checkout or release tarball):

```bash
node scripts/setup.mjs --for pi
node skills/chrome-cdp-ex/scripts/cdp.mjs doctor
```

## Route

Prefer **CLI**. Official distribution remains GitHub Release tarballs — this project does not publish to the npm registry.

See also: `skills/chrome-cdp-ex/hosts/pi.md`.
