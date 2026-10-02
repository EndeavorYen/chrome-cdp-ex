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

function isSensitiveToken(token, { prev, next, urlQuery, tokenSet = SENSITIVE_KEY_TOKENS }) {
  if (token === 'token' && (TOKEN_QUANTITY_BEFORE.has(prev) || TOKEN_QUANTITY_AFTER.has(next))) return false;
  if (tokenSet.has(token)) return true;
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
  return hasSensitiveToken(tokens, { urlQuery, tokenSet: SENSITIVE_KEY_TOKENS });
}

function hasSensitiveToken(tokens, { urlQuery = false, tokenSet }) {
  for (let i = 0; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (isSensitiveToken(tokens[i], { prev, next, urlQuery, tokenSet })) return true;
    // `api_key` / `apiKey` / `private-key` split into two tokens.
    if (next && isSensitiveToken(tokens[i] + next, { prev, next: tokens[i + 2], urlQuery, tokenSet })) return true;
  }
  return false;
}

// Form fields are named in prose ("Session name", "Access level", "Refresh interval"). The bare
// words that make a URL key secret (`?session=…`) do not make a field secret; their compounds
// still do (`session_id`, `access_token`, `refresh_token`, `card_number`, `access code`).
const FIELD_NON_SECRET_WORDS = new Set(['session', 'access', 'refresh', 'sid', 'cookie', 'card']);
const SENSITIVE_FIELD_TOKENS = new Set([
  ...[...SENSITIVE_KEY_TOKENS].filter(token => !FIELD_NON_SECRET_WORDS.has(token)),
  'sessionid', 'cardnumber', 'creditcard', 'accesscode', 'csc',
]);

// Field names whose words are not secret one by one: autocomplete values for card and
// one-time codes, and one-time/verification code labels. Matched on the token list joined
// with `-`, so `cc_number`, `ccNumber`, `autocomplete="cc-number"` and `One-time code` all hit.
const SENSITIVE_FIELD_PHRASE_RE = /(?:^|-)(?:one-time-(?:code|password|passcode|pin)|verification-code|security-code|cc-number|cc-csc|cc-exp)(?:-|$)/;

// A form field whose typed value must stay out of receipts and logs (#485). `text` is one
// string that describes the field: a CSS selector, or its name, id, autocomplete, aria-label,
// placeholder or label text.
export function isSensitiveFieldText(text = '') {
  const tokens = sensitiveKeyTokens(text);
  if (tokens.length === 0) return false;
  return hasSensitiveToken(tokens, { tokenSet: SENSITIVE_FIELD_TOKENS })
    || SENSITIVE_FIELD_PHRASE_RE.test(tokens.join('-'));
}

function decodeKey(rawKey) {
  try {
    return decodeURIComponent(String(rawKey).replace(/\+/g, ' '));
  } catch {
    return String(rawKey);
  }
}

// `code` is a generic word (`?code=US`), so it counts as a secret only in the
// shape of an OAuth authorization response: a query that also carries `state=`.
function isOAuthCodeQuery(parts) {
  return parts.some(part => part.includes('=') && decodeKey(part.slice(0, part.indexOf('='))).toLowerCase() === 'state');
}

function redactQueryString(query) {
  const parts = String(query).split('&');
  const oauth = isOAuthCodeQuery(parts);
  return parts.map((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return part;
    const rawKey = part.slice(0, eq);
    const key = decodeKey(rawKey);
    const secret = isSensitiveKey(key, { urlQuery: true }) || (oauth && key.toLowerCase() === 'code');
    return secret ? `${rawKey}=${REDACTED_VALUE}` : part;
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

// A JSON Web Token (`header.payload.signature`, both JSON parts base64url `{"…`)
// is a bearer secret wherever it appears, whatever its key.
// A match may start only where a base64url run starts: with `\b`, every `eyJ`
// inside one long `[A-Za-z0-9_-]` run (`eyJ-eyJ-…`) was a new start that scanned
// to the end of the run, which is quadratic on page-controlled text (#467 review).
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const AUTH_HEADER_VALUE_RE = /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi;
const BEARER_VALUE_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
// prefix, optional key quote (`"access_token":`), key (may be %-encoded), separator.
const ASSIGNMENT_KEY_RE = /(^|[\s{[,;?&#])(["']?)([A-Za-z0-9_.%-]+)\2(\s*[:=]\s*)/g;
// A bare (unquoted) value. Quoted values are read by scanQuotedValue.
const BARE_VALUE_RE = /[^"'\s,;&}\])]+/y;
// A quoted secret is read up to its real closing quote (#503): `\"` and line
// breaks are part of the value. With no closing quote within this many
// characters, everything up to the bound is redacted.
//
// Quotes in prose are ambiguous and are not guessed at: in
// `password: 'it's QZ7'` the apostrophe closes the value, and in
// `password: it's "QZ7"` the value is the bare word `it`. Both leak.
export const MAX_QUOTED_VALUE_CHARS = 4096;

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// One left-to-right pass from the opening quote at `start`; a backslash
// escapes the next character. Returns the index just past the value.
function scanQuotedValue(text, start) {
  const quote = text.charCodeAt(start);
  const limit = Math.min(text.length, start + 1 + MAX_QUOTED_VALUE_CHARS);
  for (let i = start + 1; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x5c) i++;
    else if (code === quote) return { end: i + 1, closed: true };
  }
  // Unterminated within the bound: stop at the bound, never inside a surrogate pair.
  const end = limit < text.length && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit + 1 : limit;
  return { end, closed: false };
}

// The secret value starting at `valueStart` as `{ end, quote, closed }`, or null.
function secretValueSpan(text, valueStart) {
  const first = text[valueStart];
  if (first !== '"' && first !== '\'') {
    BARE_VALUE_RE.lastIndex = valueStart;
    const bare = BARE_VALUE_RE.exec(text);
    return bare ? { end: valueStart + bare[0].length, quote: '', closed: true } : null;
  }
  // A lone quote at the very end has no value to hide.
  if (valueStart + 1 >= text.length) return null;
  return { ...scanQuotedValue(text, valueStart), quote: first };
}

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
// A quoted value left open (by the page, or by a cut) is redacted to the end
// of the text or MAX_QUOTED_VALUE_CHARS, whichever comes first.
//
// Keys are also looked for inside a quoted secret value. A stray quote
// (`token: "x`) closes on whatever quote comes next, which may open the
// next secret's key or value (`{"password":"QZ7"}`, `password: 'QZ7 "X'`) or
// lie past the bound; that next secret is still found and its span merged.
// Key scanning only moves forward and resumes after a bare value, and two
// scans for the same quote never overlap, so this stays linear.
function redactSecretAssignments(text) {
  const spans = [];
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
    if (!isSensitiveKey(decodeKey(rawKey), { urlQuery })) {
      // Give back the whitespace after a non-secret key's separator: it is the prefix
      // the next key needs (`user: token=…`, `msg: password: "…"`).
      ASSIGNMENT_KEY_RE.lastIndex = match.index + whole.trimEnd().length;
      continue;
    }
    const span = secretValueSpan(text, valueStart);
    if (!span) continue;
    const close = span.closed ? span.quote : '';
    const prev = spans[spans.length - 1];
    if (prev && valueStart < prev.end) {
      if (span.end > prev.end) Object.assign(prev, { end: span.end, close });
    } else {
      spans.push({ start: valueStart, end: span.end, open: span.quote, close });
    }
    ASSIGNMENT_KEY_RE.lastIndex = span.quote ? valueStart + 1 : span.end;
  }
  if (spans.length === 0) return text;
  let out = '';
  let last = 0;
  for (const span of spans) {
    out += `${text.slice(last, span.start)}${span.open}${REDACTED_VALUE}${span.close}`;
    last = span.end;
  }
  return `${out}${text.slice(last)}`;
}

// `scheme://user:pa` at the very end of a cut-off text: the `@` that would mark
// it as a password was cut away (it may also be a port; the tail is hidden anyway).
const URL_USERINFO_CUT_RE = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#@]+)$/i;

export function redactJwts(value) {
  return String(value ?? '').replace(JWT_RE, REDACTED_VALUE);
}

// Pass `{ truncated: true }` when `value` is a cut-off prefix of a longer text.
export function redactSensitiveString(value, { truncated = false } = {}) {
  const text = String(value ?? '');
  const redacted = text
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(AUTH_HEADER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(URL_USERINFO_RE, `$1${REDACTED_VALUE}$3`);
  return redactSecretAssignments(truncated ? redacted.replace(URL_USERINFO_CUT_RE, `$1${REDACTED_VALUE}`) : redacted);
}

const MIN_SUBSTRING_SECRET_CHARS = 4;
const MIN_PREVIEW_PREFIX_CHARS = 8;

// Literal secret values (a value typed into a sensitive field, the value it replaced) scrubbed
// from a string, array or object (#485). A value of 4+ characters is replaced wherever it
// appears, also JSON-escaped and as a truncated `prefix…` preview of 8+ characters. A shorter
// value is replaced only as a whole string or a quoted `"x"`, so a one-digit PIN cannot garble
// counts, ids or durations.
//
// Scrub a model before it is serialized, never serialized JSON: only string leaves change, so
// a secret such as `null`, `true` or `1234` cannot corrupt JSON keywords, numbers or keys.
// `keepKeys` names fields whose value is a code-generated identifier (`schema`, `action`), left
// alone so a secret such as `fill` cannot rename the schema or the action.
export function scrubSecretValues(value, secrets = [], { keepKeys = null } = {}) {
  const list = [...new Set((Array.isArray(secrets) ? secrets : [secrets])
    .filter(secret => typeof secret === 'string' && secret !== '' && secret !== REDACTED_VALUE))]
    .sort((a, b) => b.length - a.length);
  if (list.length === 0 || value == null) return value;
  return scrubSecretsDeep(value, list, keepKeys);
}

function scrubSecretsDeep(value, list, keepKeys) {
  if (typeof value === 'string') return list.reduce((text, secret) => scrubSecretInString(text, secret), value);
  if (Array.isArray(value)) return value.map(item => scrubSecretsDeep(item, list, keepKeys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      keepKeys?.has(key) && typeof entry === 'string' ? entry : scrubSecretsDeep(entry, list, keepKeys),
    ]));
  }
  return value;
}

function scrubSecretInString(text, secret) {
  if (text === secret) return REDACTED_VALUE;
  let out = text;
  const escaped = JSON.stringify(secret).slice(1, -1);
  for (const form of escaped === secret ? [secret] : [secret, escaped]) {
    if (secret.length >= MIN_SUBSTRING_SECRET_CHARS) {
      out = out.split(form).join(REDACTED_VALUE);
    } else {
      out = out.split(`"${form}"`).join(`"${REDACTED_VALUE}"`)
        .split(`\\"${form}\\"`).join(`\\"${REDACTED_VALUE}\\"`);
    }
    if (form.length > MIN_PREVIEW_PREFIX_CHARS) out = scrubTruncatedPreviews(out, form);
  }
  return out;
}

// `sk-live-abcdef…` / `sk-live-abcdef...`: a receipt cut the secret short.
function scrubTruncatedPreviews(text, secret) {
  const head = secret.slice(0, MIN_PREVIEW_PREFIX_CHARS);
  let out = '';
  let from = 0;
  let scan = 0;
  let at;
  while ((at = text.indexOf(head, scan)) !== -1) {
    let length = MIN_PREVIEW_PREFIX_CHARS;
    while (length < secret.length && text[at + length] === secret[length]) length++;
    const rest = text.slice(at + length, at + length + 3);
    const ellipsis = rest.startsWith('…') ? 1 : rest === '...' ? 3 : 0;
    if (ellipsis) {
      out += `${text.slice(from, at)}${REDACTED_VALUE}`;
      from = at + length + ellipsis;
      scan = from;
    } else {
      scan = at + 1;
    }
  }
  return from === 0 ? text : `${out}${text.slice(from)}`;
}

// Structural redaction for parsed JSON (#467): a sensitive key hides its whole
// value (object, array or scalar), string leaves go through
// redactSensitiveString, and a string that itself holds JSON is parsed and
// redacted the same way (best effort). `changed` reports whether anything was
// hidden, so a caller can keep the original bytes when nothing was.
const MAX_STRUCTURAL_DEPTH = 64;

function looksLikeJsonText(text) {
  const trimmed = text.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

// Keeps numbers that a double cannot hold (64-bit ids) byte-exact.
function preciseJsonParse(text) {
  if (typeof JSON.rawJSON !== 'function') return JSON.parse(text);
  return JSON.parse(text, (key, value, context) => (
    typeof value === 'number' && typeof context?.source === 'string' && String(value) !== context.source
      ? JSON.rawJSON(context.source)
      : value
  ));
}

export function redactSensitiveValue(value, { isSensitive = key => isSensitiveKey(key), parseJsonStrings = true } = {}) {
  let changed = false;
  const walk = (node, key, depth) => {
    if (key != null && isSensitive(key)) {
      changed = true;
      return REDACTED_VALUE;
    }
    if (node == null || typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      if (parseJsonStrings && depth < MAX_STRUCTURAL_DEPTH && looksLikeJsonText(node)) {
        try {
          const parsed = preciseJsonParse(node);
          const before = changed;
          changed = false;
          const redacted = walk(parsed, null, depth + 1);
          const inner = changed;
          changed = before || inner;
          return inner ? JSON.stringify(redacted) : node;
        } catch {
          // Not JSON after all; fall through to the string rules.
        }
      }
      const out = redactSensitiveString(node);
      if (out !== node) changed = true;
      return out;
    }
    if (typeof JSON.isRawJSON === 'function' && JSON.isRawJSON(node)) return node;
    if (depth >= MAX_STRUCTURAL_DEPTH) {
      // Too deep to walk safely: redact its text form instead.
      const text = JSON.stringify(node);
      const out = redactSensitiveString(text);
      if (out === text) return node;
      changed = true;
      return out;
    }
    if (Array.isArray(node)) return node.map(item => walk(item, null, depth + 1));
    if (typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([entryKey, entryValue]) => [entryKey, walk(entryValue, entryKey, depth + 1)]));
    }
    return node;
  };
  const result = walk(value, null, 0);
  return { value: result, changed };
}

// Redacts a JSON document as JSON. Returns null when `text` is not JSON, so the
// caller can fall back to the string rules. The output stays valid JSON: when a
// value was hidden it is re-serialized (2-space indent if the input had line
// breaks); otherwise the input comes back unchanged.
export function redactJsonText(text, options = {}) {
  const source = String(text ?? '');
  if (!looksLikeJsonText(source)) return null;
  let parsed;
  try {
    parsed = preciseJsonParse(source);
  } catch {
    return null;
  }
  const { value, changed } = redactSensitiveValue(parsed, options);
  if (!changed) return { text: source, changed: false };
  return { text: JSON.stringify(value, null, /\n/.test(source.trim()) ? 2 : undefined), changed: true };
}

// HTML and XML markup: `<input name="csrf_token" value="…">`, Rails
// `authenticity_token`, `<meta name="csrf-token" content="…">`, a password
// input's value, and `<token>…</token>` elements. Best effort, regex only.
// Linear on hostile text: a tag stops at the next `<`, and an attribute name can
// start only where a name run starts.
const MARKUP_TAG_RE = /<(input|meta)\b[^<>]*>/gi;
const MARKUP_ATTR_RE = /(?<![\w:-])([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
const XML_ELEMENT_RE = /<([A-Za-z_][\w.:-]*)(\s[^<>]*)?>([^<]*)<\/\1\s*>/g;

function attrValue(raw) {
  return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

export function redactMarkupSecrets(value) {
  const text = String(value ?? '');
  if (!text.includes('<')) return text;
  return text
    .replace(MARKUP_TAG_RE, (tag, tagName) => {
      const attrs = {};
      for (const match of tag.matchAll(MARKUP_ATTR_RE)) attrs[match[1].toLowerCase()] = attrValue(match[2]);
      const name = attrs.name || attrs.property || attrs.id || '';
      const isInput = tagName.toLowerCase() === 'input';
      const secret = isSensitiveKey(name) || (isInput && String(attrs.type || '').toLowerCase() === 'password');
      if (!secret) return tag;
      const valueAttr = isInput ? 'value' : 'content';
      return tag.replace(MARKUP_ATTR_RE, (attr, attrName, raw) => {
        if (attrName.toLowerCase() !== valueAttr) return attr;
        const quote = raw.startsWith('"') || raw.startsWith("'") ? raw[0] : '"';
        return `${attrName}=${quote}${REDACTED_VALUE}${quote}`;
      });
    })
    .replace(XML_ELEMENT_RE, (element, name, attrs = '', content) => (
      content.trim() && isSensitiveKey(name.split(':').pop()) ? `<${name}${attrs}>${REDACTED_VALUE}</${name}>` : element
    ));
}
