// One key classifier for every redaction path (#455).
// A key is split into tokens on `_`, `-`, `.`, `%`, brackets and camelCase, and
// only whole tokens are compared with the keyword list, so `access_token`,
// `accessToken` and `client_secret` match while `pinned`, `cardinality`,
// `passage` and `sidebar` do not.
//
// Rules beyond "whole token in the list":
// - Two adjacent tokens are also tried glued (`api`+`key` -> `apikey`), and a
//   token ending in a strong suffix counts (`accesstoken`, `jsessionid`).
// - `token` is a secret, but `token` used as a quantity is not: plural
//   `tokens`, `maxTokens`, `max_token`, `tokenCount`, `token_limit` stay
//   readable (LLM budgets, design-token maps).
// - URL-query-only keys: a bare `key` (`?key=AIza…`), `sig` and `signature`
//   (`X-Amz-Signature`) are secrets in a URL query or fragment, but not as an
//   object key or in prose (`Sort key: name`, a `signature` prop).

export const REDACTED_VALUE = '<redacted>';

const SENSITIVE_KEY_TOKENS = new Set([
  'pass', 'password', 'passwords', 'passwd', 'passphrase', 'pwd',
  'secret', 'secrets', 'token', 'apikey', 'privatekey',
  'accesskey', 'secretkey', 'sessionkey', 'authkey',
  'credential', 'credentials', 'otp', '2fa', 'mfa', 'auth', 'authorization',
  'pin', 'cvv', 'cvc', 'card', 'ssn',
  'session', 'sid', 'sessid', 'cookie', 'jwt', 'csrf', 'xsrf', 'refresh', 'access',
]);
const URL_QUERY_KEY_TOKENS = new Set(['signature', 'sig']);
const URL_QUERY_WHOLE_KEYS = new Set(['key']);
// Glued compounds such as `accesstoken`, `clientsecret`, `jsessionid`, `phpsessid`.
const SENSITIVE_KEY_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'apikey', 'sessionid', 'sessid'];
const TOKEN_QUANTITY_BEFORE = new Set(['max', 'min', 'num', 'total']);
const TOKEN_QUANTITY_AFTER = new Set(['count', 'counts', 'limit', 'limits', 'length', 'size', 'usage', 'budget', 'total']);

// The acronym split uses a lookahead, not `([A-Z]+)([A-Z][a-z])`: that form
// rescans an upper-case run from every position, quadratic on a long key (#459).
export function sensitiveKeyTokens(key = '') {
  return String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveToken(token, { prev, next, urlQuery }) {
  if (token === 'token' && (TOKEN_QUANTITY_BEFORE.has(prev) || TOKEN_QUANTITY_AFTER.has(next))) return false;
  if (SENSITIVE_KEY_TOKENS.has(token)) return true;
  if (urlQuery && URL_QUERY_KEY_TOKENS.has(token)) return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => {
    if (token.length <= suffix.length || !token.endsWith(suffix)) return false;
    // `maxtoken` is a quantity, not a secret.
    return !(suffix === 'token' && TOKEN_QUANTITY_BEFORE.has(token.slice(0, -suffix.length)));
  });
}

// `urlQuery: true` when the key names a URL query/fragment parameter.
export function isSensitiveKey(key = '', { urlQuery = false } = {}) {
  const tokens = sensitiveKeyTokens(key);
  if (tokens.length === 0) return false;
  if (urlQuery && tokens.length === 1 && URL_QUERY_WHOLE_KEYS.has(tokens[0])) return true;
  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (isSensitiveToken(tokens[i], { prev, next, urlQuery })) return true;
    // `api_key` / `apiKey` / `private-key` split into two tokens.
    if (next && isSensitiveToken(tokens[i] + next, { prev, next: tokens[i + 2], urlQuery })) return true;
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
    return isSensitiveKey(decodeKey(rawKey), { urlQuery: true }) ? `${rawKey}=${REDACTED_VALUE}` : part;
  }).join('&');
}

// A scheme may only start where a run of scheme characters starts. With `\b`,
// the unbounded `[a-z0-9+.-]*` rescanned a long dotted or hyphenated token
// from every word boundary (quadratic, #459); the lookbehind scans each run
// once, so a scheme of any length is still matched in linear time.
const URL_USERINFO_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)(@)/gi;
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
    .replace(PATH_PARAM_RE, (match, key) => (isSensitiveKey(decodeKey(key), { urlQuery: true }) ? `;${key}=${REDACTED_VALUE}` : match));
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
// prefix, optional key quote (`"access_token":`), key (may be %-encoded), separator.
const ASSIGNMENT_KEY_RE = /(^|[\s{[,;?&#])(["']?)([A-Za-z0-9_.%-]+)\2(\s*[:=]\s*)/g;
// Whole quoted value, an unterminated quoted value, or a bare value.
const ASSIGNMENT_VALUE_RE = /"[^"\n]*"|'[^'\n]*'|(["']?)[^"'\s,;&}\])]+/y;
// `#pin:checked`, `.token:hover`, `input.password:focus` are CSS selectors, not
// `key: value` pairs; recorded selectors must replay unchanged.
const CSS_PSEUDO_AFTER_COLON_RE = /:(?:hover|focus(?:-visible|-within)?|active|checked|disabled|enabled|visited|link|empty|required|optional|invalid|valid|in-range|out-of-range|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child|nth-last-child|nth-of-type|nth-last-of-type|not|has|is|where|placeholder-shown|read-only|read-write|before|after|root|target|indeterminate|default|autofill)(?![A-Za-z0-9_-])/y;

function isCssSelectorColon(text, separator, keyEnd) {
  if (separator !== ':') return false;
  CSS_PSEUDO_AFTER_COLON_RE.lastIndex = keyEnd;
  return CSS_PSEUDO_AFTER_COLON_RE.test(text);
}

// `key=value` / `key: value` pairs in free text (console lines, DOM diffs,
// URLs inside messages). A non-secret pair is skipped past its separator only,
// so a secret hiding in its value (`?a=b#access_token=…`) is still examined.
// `truncated`: the text was cut off, so a quoted value left open at the end
// ran past the cut and is redacted to the end, not only up to its first space.
function redactSecretAssignments(text, { truncated = false } = {}) {
  let out = '';
  let last = 0;
  ASSIGNMENT_KEY_RE.lastIndex = 0;
  let match;
  while ((match = ASSIGNMENT_KEY_RE.exec(text)) !== null) {
    const [whole, prefix, keyQuote, rawKey, separator] = match;
    const valueStart = match.index + whole.length;
    const isEquals = separator.includes('=');
    // `#` opens a URL fragment parameter (`#access_token=…`) only; `#id:…` is a selector.
    if (prefix === '#' && !isEquals) continue;
    if (isCssSelectorColon(text, separator, match.index + prefix.length + keyQuote.length * 2 + rawKey.length)) continue;
    const urlQuery = isEquals && !keyQuote && (prefix === '?' || prefix === '&' || prefix === '#');
    if (!isSensitiveKey(decodeKey(rawKey), { urlQuery })) continue;
    ASSIGNMENT_VALUE_RE.lastIndex = valueStart;
    const value = ASSIGNMENT_VALUE_RE.exec(text);
    if (!value) continue;
    const quote = /^["']/.test(value[0]) ? value[0][0] : '';
    const openToCut = truncated && quote && !(value[0].length > 1 && value[0].endsWith(quote))
      && text.indexOf(quote, valueStart + 1) < 0 && text.indexOf('\n', valueStart + 1) < 0;
    out += `${text.slice(last, valueStart)}${quote}${REDACTED_VALUE}${openToCut ? '' : quote}`;
    last = openToCut ? text.length : valueStart + value[0].length;
    ASSIGNMENT_KEY_RE.lastIndex = last;
  }
  return last === 0 ? text : `${out}${text.slice(last)}`;
}

// `scheme://user:pa` at the very end of a cut-off text: the `@` that would mark
// it as a password was cut away (it may also be a port; the tail is hidden anyway).
const URL_USERINFO_CUT_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)$/i;

// Pass `{ truncated: true }` when `value` is a cut-off prefix of a longer text.
export function redactSensitiveString(value, { truncated = false } = {}) {
  const text = String(value ?? '');
  const redacted = text
    .replace(AUTH_HEADER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(URL_USERINFO_RE, `$1${REDACTED_VALUE}$3`);
  return redactSecretAssignments(truncated ? redacted.replace(URL_USERINFO_CUT_RE, `$1${REDACTED_VALUE}`) : redacted, { truncated });
}
