// One key classifier for every redaction path (#455).
// A key is split into tokens on `_`, `-`, `.`, brackets and camelCase, and only
// whole tokens are compared with the keyword list, so `access_token`,
// `accessToken` and `X-Amz-Signature` match while `pinned`, `cardinality`,
// `passage` and `sidebar` do not.

export const REDACTED_VALUE = '<redacted>';

const SENSITIVE_KEY_TOKENS = new Set([
  'pass', 'password', 'passwords', 'passwd', 'passphrase', 'pwd',
  'secret', 'secrets', 'token', 'tokens', 'apikey', 'privatekey',
  'accesskey', 'secretkey', 'sessionkey', 'authkey',
  'credential', 'credentials', 'otp', '2fa', 'mfa', 'auth', 'authorization',
  'pin', 'cvv', 'cvc', 'card', 'ssn',
  'session', 'sid', 'sessid', 'cookie', 'jwt', 'csrf', 'xsrf', 'refresh', 'access',
  'signature', 'sig',
]);
// Glued compounds such as `accesstoken`, `clientsecret`, `jsessionid`, `phpsessid`.
const SENSITIVE_KEY_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey', 'sessionid', 'sessid'];
// Only when it is the entire key (`?key=AIza…` on Google APIs); `sort_key` stays readable.
const SENSITIVE_WHOLE_KEYS = new Set(['key']);

export function sensitiveKeyTokens(key = '') {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveToken(token) {
  if (SENSITIVE_KEY_TOKENS.has(token)) return true;
  return SENSITIVE_KEY_SUFFIXES.some(suffix => token.length > suffix.length && token.endsWith(suffix));
}

export function isSensitiveKey(key = '') {
  const tokens = sensitiveKeyTokens(key);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && SENSITIVE_WHOLE_KEYS.has(tokens[0])) return true;
  for (let i = 0; i < tokens.length; i++) {
    if (isSensitiveToken(tokens[i])) return true;
    // `api_key` / `apiKey` / `private-key` split into two tokens.
    if (i + 1 < tokens.length && isSensitiveToken(tokens[i] + tokens[i + 1])) return true;
  }
  return false;
}

function decodeKey(rawKey) {
  try {
    return decodeURIComponent(String(rawKey).replace(/\+/g, ' '));
  } catch {
    return String(rawKey);
  }
}

function redactQueryString(query) {
  return String(query).split('&').map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return part;
    const rawKey = part.slice(0, eq);
    return isSensitiveKey(decodeKey(rawKey)) ? `${rawKey}=${REDACTED_VALUE}` : part;
  }).join('&');
}

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)(@)/gi;
const PATH_PARAM_RE = /;([^;=/?#]+)=([^;/?#]*)/g;

// Redact secret values in one URL without re-encoding the rest. Non-secret
// URLs come back byte-identical; nothing is parsed with `new URL`, so relative
// and opaque URLs are handled the same way.
export function redactUrl(value) {
  const text = String(value ?? '');
  if (!text) return text;
  const withoutUserinfo = text.replace(URL_USERINFO_RE, `$1${REDACTED_VALUE}$3`);
  const hashAt = withoutUserinfo.indexOf('#');
  const head = hashAt >= 0 ? withoutUserinfo.slice(0, hashAt) : withoutUserinfo;
  let fragment = hashAt >= 0 ? withoutUserinfo.slice(hashAt + 1) : null;
  const queryAt = head.indexOf('?');
  const path = (queryAt >= 0 ? head.slice(0, queryAt) : head)
    .replace(PATH_PARAM_RE, (match, key) => (isSensitiveKey(decodeKey(key)) ? `;${key}=${REDACTED_VALUE}` : match));
  const query = queryAt >= 0 ? head.slice(queryAt + 1) : null;
  if (fragment != null) {
    // OAuth implicit flow (`#access_token=…`) and hash routes (`#/cb?token=…`).
    const fragmentQueryAt = fragment.indexOf('?');
    if (fragmentQueryAt >= 0) {
      fragment = `${fragment.slice(0, fragmentQueryAt + 1)}${redactQueryString(fragment.slice(fragmentQueryAt + 1))}`;
    } else if (fragment.includes('=')) {
      fragment = redactQueryString(fragment);
    }
  }
  return `${path}${query != null ? `?${redactQueryString(query)}` : ''}${fragment != null ? `#${fragment}` : ''}`;
}

const AUTH_HEADER_VALUE_RE = /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi;
const BEARER_VALUE_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const ASSIGNMENT_KEY_RE = /(^|[\s{[,;?&#])([A-Za-z0-9_.-]+)(\s*[:=]\s*)/g;
const ASSIGNMENT_VALUE_RE = /(["']?)([^"'\s,;&}\])]+)/y;

// `key=value` / `key: value` pairs in free text (console lines, DOM diffs,
// URLs inside messages). A non-secret pair is skipped past its separator only,
// so a secret hiding in its value (`?a=b#access_token=…`) is still examined.
function redactSecretAssignments(text) {
  let out = '';
  let last = 0;
  ASSIGNMENT_KEY_RE.lastIndex = 0;
  let match;
  while ((match = ASSIGNMENT_KEY_RE.exec(text)) !== null) {
    const [, , key] = match;
    const valueStart = match.index + match[0].length;
    if (!isSensitiveKey(key)) continue;
    ASSIGNMENT_VALUE_RE.lastIndex = valueStart;
    const value = ASSIGNMENT_VALUE_RE.exec(text);
    if (!value) continue;
    const quote = value[1];
    out += `${text.slice(last, valueStart)}${quote}${REDACTED_VALUE}${quote}`;
    last = valueStart + value[0].length;
    ASSIGNMENT_KEY_RE.lastIndex = last;
  }
  return last === 0 ? text : `${out}${text.slice(last)}`;
}

export function redactSensitiveString(value) {
  const text = String(value ?? '');
  return redactSecretAssignments(text
    .replace(AUTH_HEADER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(URL_USERINFO_RE, `$1${REDACTED_VALUE}$3`));
}
