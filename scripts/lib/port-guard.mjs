// Guard for the live scripts under scripts/: they must only ever talk to a test browser the caller started.
// Unset would fall back to cdp.mjs's default 9222 (the user's daily Chrome); 9224 is the user's logged-in
// profile. Ports are compared as numbers so "09222" is refused too.
const USER_CHROME_PORTS = new Set([9222, 9224]);

export function checkTestPort(value) {
  const text = String(value ?? '').trim();
  if (text === '') return { ok: false, reason: 'CDP_PORT is not set; set it to the port of a test browser you started' };
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: `CDP_PORT must be an integer from 1 to 65535, got "${value}"` };
  if (USER_CHROME_PORTS.has(port)) return { ok: false, reason: `CDP_PORT ${text} is 9222 or 9224 (your own Chrome); use a test browser you started` };
  return { ok: true, port };
}

// Exits 2 before the caller spawns or connects anything.
export function requireTestPort(env = process.env) {
  const check = checkTestPort(env.CDP_PORT);
  if (!check.ok) {
    console.error(`refusing to run: ${check.reason}`);
    process.exit(2);
  }
  return check.port;
}
