export const CARDS_SCHEMA = 'chrome-cdp-ex.cards.v1';
export const DEFAULT_CARD_CAP = 12;
export const MAX_CARD_CAP = 20;
export const CARD_TEXT_LIMIT = 180;
export const TYPICAL_CARD_HEIGHT_PX = 200;
export const VIRTUALIZED_NEXT = 'timeline virtualized; scroll and re-run --cards';

const HANDLE_RE = /@[A-Za-z0-9_]{1,30}/;
const PERMALINK_RE = /\/(?:status|statuses|posts?|articles?|p|notes?)\//i;
const ENGAGEMENT_RE = /(\d[\d,.]*\s*[KkMmBb]?)\s*(repl(?:y|ies)|like[s]?|repost[s]?|retweet[s]?|view[s]?|comment[s]?|share[s]?)/i;
const CARD_ROLES = new Set(['article', 'listitem']);

export function cardCapFromLast(last) {
  if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
    return Math.min(MAX_CARD_CAP, Math.max(1, Math.floor(last)));
  }
  return DEFAULT_CARD_CAP;
}

function roleOf(node) {
  return String(node?.role?.value || '').trim().toLowerCase();
}

function nameOf(node) {
  return String(node?.name?.value ?? '');
}

function axProp(node, name) {
  const properties = node?.properties;
  if (!Array.isArray(properties)) return null;
  const hit = properties.find(property => property && property.name === name);
  const value = hit?.value?.value;
  return value == null || value === '' ? null : String(value);
}

export function compactCardText(value, max = CARD_TEXT_LIMIT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd();
}

function indexTree(nodes) {
  const nodesById = new Map((nodes || []).map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes || []) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }
  function childrenOf(node) {
    const children = [];
    const seen = new Set();
    for (const childId of node.childIds || []) {
      const child = nodesById.get(childId);
      if (child && !seen.has(child.nodeId)) {
        seen.add(child.nodeId);
        children.push(child);
      }
    }
    for (const child of childrenByParent.get(node.nodeId) || []) {
      if (!seen.has(child.nodeId)) {
        seen.add(child.nodeId);
        children.push(child);
      }
    }
    return children;
  }
  return { nodesById, childrenOf };
}

function ancestorsOf(node, nodesById) {
  const chain = [];
  let current = node;
  const seen = new Set();
  while (current) {
    chain.push(current);
    if (!current.parentId || seen.has(current.parentId)) break;
    seen.add(current.parentId);
    current = nodesById.get(current.parentId);
  }
  return chain;
}

function inRoleScope(node, nodesById, roles) {
  return ancestorsOf(node, nodesById).some(ancestor => roles.has(roleOf(ancestor)));
}

function collectSubtree(node, childrenOf) {
  const collected = [];
  const visit = current => {
    collected.push(current);
    for (const child of childrenOf(current)) visit(child);
  };
  visit(node);
  return collected;
}

function extractHandle(nodes) {
  for (const node of nodes) {
    const match = nameOf(node).match(HANDLE_RE);
    if (match) return match[0];
  }
  return null;
}

function extractUrl(nodes) {
  const urls = [];
  for (const node of nodes) {
    const href = axProp(node, 'url');
    if (href && /^https?:\/\//i.test(href)) urls.push(href);
  }
  return urls.find(href => PERMALINK_RE.test(href)) || urls[0] || null;
}

function extractEngagement(nodes) {
  const crumbs = [];
  const seen = new Set();
  for (const node of nodes) {
    const role = roleOf(node);
    if (role !== 'button' && role !== 'link' && role !== 'menuitem') continue;
    const name = compactCardText(nameOf(node), 80);
    const match = name.match(ENGAGEMENT_RE);
    if (!match) continue;
    const key = match[2].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    crumbs.push(`${match[1].replace(/\s+/g, '')} ${key}`);
  }
  return crumbs.length ? crumbs.join(' · ') : undefined;
}

function extractText(cardNode, handle) {
  let text = compactCardText(nameOf(cardNode), CARD_TEXT_LIMIT * 4);
  if (handle && text.startsWith(handle)) text = text.slice(handle.length).trim();
  return compactCardText(text, CARD_TEXT_LIMIT);
}

function isCardCandidate(node, { nodesById, hasFeed, hasMain, hasScopedArticles }) {
  const role = roleOf(node);
  if (!CARD_ROLES.has(role)) return false;
  const scoped = hasFeed
    ? inRoleScope(node, nodesById, new Set(['feed']))
    : hasMain
      ? inRoleScope(node, nodesById, new Set(['main']))
      : true;
  if (!scoped) return false;
  if (role === 'article') return true;
  return !hasScopedArticles;
}

export function buildCardsModel(nodes = [], meta = {}, refMap = null, opts = {}) {
  const cap = cardCapFromLast(opts.last);
  const targetPrefix = opts.targetPrefix || '<target>';
  const { nodesById, childrenOf } = indexTree(nodes);
  const hasFeed = (nodes || []).some(node => roleOf(node) === 'feed');
  const hasMain = (nodes || []).some(node => roleOf(node) === 'main');
  const hasScopedArticles = (nodes || []).some(node => {
    if (roleOf(node) !== 'article') return false;
    if (hasFeed) return inRoleScope(node, nodesById, new Set(['feed']));
    if (hasMain) return inRoleScope(node, nodesById, new Set(['main']));
    return true;
  });

  const candidates = [];
  const skip = new Set();
  const visit = node => {
    if (!node || skip.has(node.nodeId)) {
      for (const child of node ? childrenOf(node) : []) visit(child);
      return;
    }
    if (isCardCandidate(node, { nodesById, hasFeed, hasMain, hasScopedArticles })) {
      candidates.push(node);
      for (const descendant of collectSubtree(node, childrenOf).slice(1)) skip.add(descendant.nodeId);
    }
    for (const child of childrenOf(node)) visit(child);
  };
  const roots = (nodes || []).filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root);

  const foundCount = candidates.length;
  const selected = candidates.slice(0, cap);
  if (refMap && typeof refMap.clear === 'function') refMap.clear();

  const cards = [];
  let refCounter = 0;
  for (const node of selected) {
    const subtree = collectSubtree(node, childrenOf);
    const handle = extractHandle(subtree);
    const card = {
      ref: null,
      url: extractUrl(subtree),
      handle,
      text: extractText(node, handle),
    };
    if (node.backendDOMNodeId != null) {
      refCounter += 1;
      card.ref = `@${refCounter}`;
      if (refMap && typeof refMap.set === 'function') refMap.set(refCounter, node.backendDOMNodeId);
    }
    const engagement = extractEngagement(subtree);
    if (engagement) card.engagement = engagement;
    cards.push(card);
  }

  const vh = Number(meta.vh) || 0;
  const expectedVisible = vh > 0 ? Math.floor(vh / TYPICAL_CARD_HEIGHT_PX) : 0;
  const virtualized = foundCount > 0 && expectedVisible > 0 && foundCount < expectedVisible;
  const truncated = foundCount > cap;
  const next = virtualized
    ? VIRTUALIZED_NEXT
    : truncated
      ? `cdp perceive ${targetPrefix} --cards --last ${cap}`
      : `cdp perceive ${targetPrefix} --cards`;

  const model = {
    schema: CARDS_SCHEMA,
    cards,
    truncated,
    next,
  };
  if (virtualized) model.virtualized = true;
  return model;
}

export function formatCardsJson(model) {
  return JSON.stringify(model, null, 2);
}

export function formatCardsText(model = {}) {
  const cards = Array.isArray(model.cards) ? model.cards : [];
  const flags = [
    model.truncated ? 'truncated' : null,
    model.virtualized ? 'virtualized' : null,
  ].filter(Boolean);
  const lines = [
    `${model.schema || CARDS_SCHEMA}  ${cards.length} card${cards.length === 1 ? '' : 's'}${flags.length ? `  ${flags.join(' ')}` : ''}`,
  ];
  for (const card of cards) {
    lines.push([card.ref, card.handle, card.text, card.url, card.engagement].filter(Boolean).join('  '));
  }
  if (model.next) lines.push(`next: ${model.next}`);
  return lines.join('\n');
}
