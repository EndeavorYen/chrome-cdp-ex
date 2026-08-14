import { describe, expect, it } from 'vitest';

import {
  CARDS_SCHEMA,
  DEFAULT_CARD_CAP,
  MAX_CARD_CAP,
  VIRTUALIZED_NEXT,
  CARDS_UNCHANGED_NEXT,
  buildCardsModel,
  formatCardsJson,
  formatCardsText,
} from '../skills/chrome-cdp-ex/scripts/lib/cards-model.mjs';

function ax(id, parentId, role, name, extra = {}) {
  return {
    nodeId: String(id),
    ...(parentId == null ? {} : { parentId: String(parentId) }),
    role: { value: role },
    name: { value: name },
    ...(extra.childIds ? { childIds: extra.childIds.map(String) } : {}),
    ...(extra.backendDOMNodeId != null ? { backendDOMNodeId: extra.backendDOMNodeId } : {}),
    ...(extra.properties ? { properties: extra.properties } : {}),
  };
}

function urlProp(href) {
  return [{ name: 'url', value: { value: href } }];
}

function tweetArticle(id, parentId, { handle, statusId, text, replies = 0, likes = 0, backend = id * 10 }) {
  const articleId = id;
  const handleLinkId = id + 1;
  const statusLinkId = id + 2;
  const replyId = id + 3;
  const likeId = id + 4;
  return [
    ax(articleId, parentId, 'article', `${handle} ${text}`, {
      backendDOMNodeId: backend,
      childIds: [handleLinkId, statusLinkId, replyId, likeId],
    }),
    ax(handleLinkId, articleId, 'link', handle, {
      backendDOMNodeId: backend + 1,
      properties: urlProp(`https://x.com/${handle.slice(1)}`),
    }),
    ax(statusLinkId, articleId, 'link', 'Show this post', {
      backendDOMNodeId: backend + 2,
      properties: urlProp(`https://x.com/${handle.slice(1)}/status/${statusId}`),
    }),
    ax(replyId, articleId, 'button', `${replies} replies`, { backendDOMNodeId: backend + 3 }),
    ax(likeId, articleId, 'button', `${likes} likes`, { backendDOMNodeId: backend + 4 }),
  ];
}

function feedTree({ articles = 2, extraNavItems = 0, vh = 720 } = {}) {
  const nodes = [
    ax(1, null, 'RootWebArea', 'Home', { childIds: [2, 3] }),
    ax(2, 1, 'banner', 'Site chrome', { childIds: extraNavItems ? [20] : [] }),
    ax(3, 1, 'main', 'Home timeline', { backendDOMNodeId: 9, childIds: [4] }),
    ax(4, 3, 'feed', 'Your Home Timeline', { backendDOMNodeId: 11, childIds: [] }),
  ];
  if (extraNavItems) {
    nodes.push(ax(20, 2, 'navigation', 'Primary', { childIds: [21] }));
    nodes.push(ax(21, 20, 'listitem', 'Home nav item', { backendDOMNodeId: 21 }));
  }
  const feedChildIds = [];
  let nextId = 100;
  for (let i = 0; i < articles; i++) {
    const articleNodes = tweetArticle(nextId, 4, {
      handle: `@user${i}`,
      statusId: String(1000 + i),
      text: `Visible post ${i} about the timeline`,
      replies: i + 1,
      likes: (i + 1) * 10,
      backend: 200 + i,
    });
    feedChildIds.push(nextId);
    nodes.push(...articleNodes);
    nextId += 10;
  }
  nodes.find(n => n.nodeId === '4').childIds = feedChildIds.map(String);
  return { nodes, meta: { vw: 1280, vh, scrollY: 0, scrollMax: 4000, layoutMap: { main: [{ h: 2000 }] } } };
}

describe('buildCardsModel', () => {
  it('returns chrome-cdp-ex.cards.v1 with truncated article cards, not a full a11y dump', () => {
    const { nodes, meta } = feedTree({ articles: 2, extraNavItems: 1, vh: 400 });
    const refMap = new Map();
    const model = buildCardsModel(nodes, meta, refMap, { targetPrefix: 'ABC12345' });

    expect(model.schema).toBe(CARDS_SCHEMA);
    expect(model.schema).toBe('chrome-cdp-ex.cards.v1');
    expect(model.cards).toHaveLength(2);
    expect(model.truncated).toBe(false);
    expect(model.cards[0]).toMatchObject({
      ref: '@1',
      url: 'https://x.com/user0/status/1000',
      handle: '@user0',
      text: expect.stringContaining('Visible post 0'),
    });
    expect(model.cards[0].engagement).toMatch(/1 replies/);
    expect(model.cards[0].engagement).toMatch(/10 likes/);
    expect(JSON.stringify(model)).not.toMatch(/Site chrome|Home nav item|Your Home Timeline/);
    expect(refMap.get(1)).toBe(200);
    expect(model.next).toBeTruthy();
  });

  it('caps at 12 cards by default and sets truncated when more articles exist', () => {
    const { nodes, meta } = feedTree({ articles: 15, vh: 4000 });
    const model = buildCardsModel(nodes, meta, new Map());
    expect(DEFAULT_CARD_CAP).toBe(12);
    expect(model.cards).toHaveLength(12);
    expect(model.truncated).toBe(true);
    expect(model.cards.at(-1).handle).toBe('@user11');
  });

  it('lets numeric --last change the cap up to 20', () => {
    const { nodes, meta } = feedTree({ articles: 25, vh: 8000 });
    expect(buildCardsModel(nodes, meta, new Map(), { last: 3 }).cards).toHaveLength(3);
    const maxed = buildCardsModel(nodes, meta, new Map(), { last: 50 });
    expect(MAX_CARD_CAP).toBe(20);
    expect(maxed.cards).toHaveLength(20);
    expect(maxed.truncated).toBe(true);
  });

  it('points truncated next at a larger --last instead of the cap already applied', () => {
    const { nodes, meta } = feedTree({ articles: 15, vh: 400 });
    const model = buildCardsModel(nodes, meta, new Map(), { targetPrefix: 'ABC12345' });
    expect(model.truncated).toBe(true);
    expect(model.virtualized).not.toBe(true);
    expect(model.next).toBe('cdp perceive ABC12345 --cards --last 15');
  });

  it('asks to scroll when truncated at the max card cap', () => {
    const { nodes, meta } = feedTree({ articles: 25, vh: 400 });
    const model = buildCardsModel(nodes, meta, new Map(), { last: 20 });
    expect(model.truncated).toBe(true);
    expect(model.next).toBe(VIRTUALIZED_NEXT);
  });

  it('truncates visible text around 180 characters', () => {
    const longText = 'word '.repeat(80).trim();
    const nodes = [
      ax(1, null, 'RootWebArea', 'Home', { childIds: [2] }),
      ax(2, 1, 'main', 'Feed', { childIds: [3] }),
      ax(3, 2, 'article', `@alice ${longText}`, {
        backendDOMNodeId: 9,
        childIds: [4],
      }),
      ax(4, 3, 'link', 'permalink', { properties: urlProp('https://x.com/alice/status/9') }),
    ];
    const [card] = buildCardsModel(nodes, { vh: 200 }, new Map()).cards;
    expect(card.text.length).toBeLessThanOrEqual(180);
    expect(card.text.length).toBeGreaterThan(100);
  });

  it('collects listitem cards in a feed when articles are absent', () => {
    const nodes = [
      ax(1, null, 'RootWebArea', 'Home', { childIds: [2] }),
      ax(2, 1, 'feed', 'Latest', { childIds: [3, 6] }),
      ax(3, 2, 'listitem', '@bob a compact status', {
        backendDOMNodeId: 31,
        childIds: [4, 5],
      }),
      ax(4, 3, 'link', '@bob', { properties: urlProp('https://x.com/bob') }),
      ax(5, 3, 'link', 'post', { properties: urlProp('https://x.com/bob/status/77') }),
      ax(6, 2, 'listitem', '@cara another status', {
        backendDOMNodeId: 61,
        childIds: [7],
      }),
      ax(7, 6, 'link', 'post', { properties: urlProp('https://x.com/cara/status/88') }),
    ];
    const model = buildCardsModel(nodes, { vh: 200 }, new Map());
    expect(model.cards.map(card => card.handle)).toEqual(['@bob', '@cara']);
    expect(model.cards[0].url).toBe('https://x.com/bob/status/77');
  });

  it('ignores nav listitems outside feed/main', () => {
    const nodes = [
      ax(1, null, 'RootWebArea', 'Home', { childIds: [2, 4] }),
      ax(2, 1, 'navigation', 'Sidebar', { childIds: [3] }),
      ax(3, 2, 'listitem', 'Explore', { backendDOMNodeId: 3 }),
      ax(4, 1, 'main', 'Timeline', { childIds: [5] }),
      ax(5, 4, 'article', '@dana only the article', {
        backendDOMNodeId: 5,
        childIds: [6],
      }),
      ax(6, 5, 'link', 'post', { properties: urlProp('https://x.com/dana/status/1') }),
    ];
    const model = buildCardsModel(nodes, { vh: 200 }, new Map());
    expect(model.cards).toHaveLength(1);
    expect(model.cards[0].handle).toBe('@dana');
  });

  it('marks virtualized when fewer articles than the viewport height suggests', () => {
    const { nodes, meta } = feedTree({ articles: 2, vh: 900 });
    const model = buildCardsModel(nodes, meta, new Map());
    expect(model.virtualized).toBe(true);
    expect(model.next).toMatch(/timeline virtualized; scroll and re-run --cards/i);
  });

  it('does not mark a dense in-tree timeline as virtualized', () => {
    const { nodes, meta } = feedTree({ articles: 6, vh: 720 });
    const model = buildCardsModel(nodes, meta, new Map());
    expect(model.virtualized).not.toBe(true);
  });

  it('marks unchanged when the same card window is still first after scroll', () => {
    const { nodes, meta } = feedTree({ articles: 3, vh: 720 });
    const first = buildCardsModel(nodes, { ...meta, scrollY: 0 }, new Map());
    const second = buildCardsModel(nodes, { ...meta, scrollY: 480 }, new Map(), {
      previousCards: first.cards,
      previousScrollY: 0,
    });
    expect(second.unchanged).toBe(true);
    expect(second.virtualizedWindowUnchanged).toBe(true);
    expect(second.next).toBe(CARDS_UNCHANGED_NEXT);
  });
});

describe('cards output formatters', () => {
  it('formats JSON with the versioned schema', () => {
    const { nodes, meta } = feedTree({ articles: 1, vh: 200 });
    const parsed = JSON.parse(formatCardsJson(buildCardsModel(nodes, meta, new Map())));
    expect(parsed.schema).toBe('chrome-cdp-ex.cards.v1');
    expect(parsed.cards[0].ref).toBe('@1');
  });

  it('formats compact text without dumping the a11y tree', () => {
    const { nodes, meta } = feedTree({ articles: 2, extraNavItems: 1, vh: 400 });
    const text = formatCardsText(buildCardsModel(nodes, meta, new Map(), { targetPrefix: 'ABC12345' }));
    expect(text).toContain('chrome-cdp-ex.cards.v1');
    expect(text).toContain('@user0');
    expect(text).toContain('@1');
    expect(text).not.toContain('[banner]');
    expect(text).not.toContain('Site chrome');
  });
});
