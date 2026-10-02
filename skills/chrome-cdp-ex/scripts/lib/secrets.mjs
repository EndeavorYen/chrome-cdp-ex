// Named secrets for `fill --secret NAME` (#469). The CLI resolves a name to its value at call
// time, from the environment variable CDP_SECRET_<NAME> or from the dotenv-style file named by
// CDP_SECRETS_FILE, so the value never travels on the command line, in an MCP request, or in a
// recorded action. Only the names that a request references are forwarded to the tab daemon,
// outside the request args; fill receipts show <secret:NAME>, and the daemon scrubs values it has
// typed from later output on a best-effort basis (lib/redaction.mjs scrubSecretText).
import { readFileSync as defaultReadFileSync, statSync as defaultStatSync } from 'fs';
import { resolve } from 'path';

export const SECRET_ENV_PREFIX = 'CDP_SECRET_';
export const SECRETS_FILE_ENV = 'CDP_SECRETS_FILE';
export const SECRET_NAME_RE = /^[A-Z0-9_]+$/;
// Bounds for the daemon request: a request names a handful of secrets, each a password-sized value.
export const MAX_REQUEST_SECRETS = 32;
export const MAX_SECRET_VALUE_CHARS = 8192;
// The session-wide scrub of later output skips values shorter than this: a short value (a PIN
// such as `4`) also occurs in unrelated text, and rewriting it there corrupts the output.
export const MIN_SCRUB_SECRET_CHARS = 4;

const DEFAULT_FS = { readFileSync: defaultReadFileSync, statSync: defaultStatSync };

export function secretMarker(name) {
  return `<secret:${name}>`;
}

export function isSecretName(name) {
  return typeof name === 'string' && SECRET_NAME_RE.test(name);
}

export function assertSecretName(name, command = 'fill') {
  if (name == null || name === '' || String(name).startsWith('--')) {
    throw new Error(`${command}: --secret requires a NAME (the value is read from ${SECRET_ENV_PREFIX}<NAME> or ${SECRETS_FILE_ENV})`);
  }
  if (!isSecretName(name)) {
    throw new Error(`${command}: secret name ${JSON.stringify(String(name))} must match [A-Z0-9_]+ (uppercase letters, digits, underscore)`);
  }
  return name;
}

const DOUBLE_QUOTE_ESCAPES = Object.freeze({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' });

// One value of a secrets-file line (the text after `=`). Grammar:
// - "double quoted": \n \r \t \" \\ are escapes, any other backslash is kept as is;
// - 'single quoted': taken literally;
// - after a closing quote only whitespace and an optional `# comment` may follow;
// - unquoted: a `#` at the start or after whitespace starts a comment; the rest is trimmed.
// A value spans one line; an unterminated quote is an error.
function parseSecretValue(rest, fail) {
  const value = rest.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    let out = '';
    let index = 1;
    let closed = false;
    for (; index < value.length; index += 1) {
      const ch = value[index];
      if (ch === quote) {
        closed = true;
        break;
      }
      if (quote === '"' && ch === '\\' && index + 1 < value.length) {
        const next = value[index + 1];
        out += Object.hasOwn(DOUBLE_QUOTE_ESCAPES, next) ? DOUBLE_QUOTE_ESCAPES[next] : `\\${next}`;
        index += 1;
        continue;
      }
      out += ch;
    }
    if (!closed) fail('unterminated quoted value');
    const tail = value.slice(index + 1).trim();
    if (tail && !tail.startsWith('#')) fail('only a # comment may follow the closing quote');
    return out;
  }
  const comment = value.search(/(?:^|\s)#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

// A dotenv-style file: NAME=VALUE lines (grammar above), blank lines and `#` comment lines
// ignored, an optional `export ` prefix. Errors name the line number only, never the line text,
// which may hold a value.
export function parseSecretsFile(text, { path = SECRETS_FILE_ENV } = {}) {
  const secrets = new Map();
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const fail = (why) => {
      throw new Error(`${path} line ${index + 1}: ${why}`);
    };
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = body.indexOf('=');
    const name = eq === -1 ? '' : body.slice(0, eq).trim();
    if (!isSecretName(name)) fail('expected NAME=VALUE with NAME matching [A-Z0-9_]+');
    secrets.set(name, parseSecretValue(body.slice(eq + 1), fail));
  });
  return secrets;
}

// POSIX only: a secrets file that group or other can read is refused. Windows has no POSIX mode
// bits (statSync reports 0o666 for every writable file), so the check is skipped there.
export function assertPrivateSecretsFile(path, { platform = process.platform, fs = DEFAULT_FS } = {}) {
  let stats;
  try {
    stats = fs.statSync(path);
  } catch (error) {
    throw new Error(`${SECRETS_FILE_ENV} ${path} cannot be read (${error.code || error.message})`);
  }
  if (!stats.isFile()) throw new Error(`${SECRETS_FILE_ENV} ${path} is not a file`);
  if (platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
    throw new Error(`${SECRETS_FILE_ENV} ${path} is readable or writable by group/other (mode ${mode}); run: chmod 600 ${path}`);
  }
}

// Every available secret, read now: CDP_SECRET_<NAME> variables win over the file's entries.
export function loadSecrets({ env = process.env, platform = process.platform, fs = DEFAULT_FS, cwd = process.cwd() } = {}) {
  const secrets = new Map();
  const file = env[SECRETS_FILE_ENV];
  if (file) {
    const path = resolve(cwd, file);
    assertPrivateSecretsFile(path, { platform, fs });
    for (const [name, value] of parseSecretsFile(fs.readFileSync(path, 'utf8'), { path })) secrets.set(name, value);
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(SECRET_ENV_PREFIX) || typeof value !== 'string') continue;
    const name = key.slice(SECRET_ENV_PREFIX.length);
    if (isSecretName(name)) secrets.set(name, value);
  }
  return secrets;
}

// The environment for a spawned tab daemon: values arrive per request, so it needs none.
export function withoutSecretEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith(SECRET_ENV_PREFIX)));
}

export function unknownSecretError(name, availableNames = [], command = 'fill') {
  const names = [...availableNames].sort();
  const available = names.length
    ? `Available: ${names.join(', ')}`
    : `No secrets are set: export ${SECRET_ENV_PREFIX}${name} or point ${SECRETS_FILE_ENV} at a NAME=VALUE file`;
  const error = new Error(`${command}: unknown secret ${name}. ${available}`);
  error.code = 'unknown_secret';
  return error;
}

// The `secrets` object a daemon request may carry: { NAME: value }, bounded and data-only.
export function validateRequestSecrets(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('daemon request secrets must be an object');
  const entries = Object.entries(input);
  if (entries.length > MAX_REQUEST_SECRETS) throw new Error(`daemon request secrets exceed ${MAX_REQUEST_SECRETS} entries`);
  const secrets = Object.create(null);
  for (const [name, value] of entries) {
    if (!isSecretName(name)) throw new Error('daemon request secrets: invalid secret name');
    if (typeof value !== 'string') throw new Error(`daemon request secrets.${name} must be a string`);
    if (value.length > MAX_SECRET_VALUE_CHARS) throw new Error(`daemon request secrets.${name} exceeds ${MAX_SECRET_VALUE_CHARS} characters`);
    secrets[name] = value;
  }
  return Object.freeze(secrets);
}
