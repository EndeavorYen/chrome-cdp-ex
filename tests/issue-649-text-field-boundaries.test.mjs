import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// #649: `text` added a newline only after a fixed list of tags, so table cells, <dt>/<dd> pairs and
// grid cells ran together ("Part numberBP-4471-C", "AdatumIn transit"). A table cell now ends with a
// tab and any other element laid out as a block ends its line, the way innerText separates them.
// The page script runs here on a small fake DOM whose computed display each node states.

const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };
const t = value => ({ nodeType: Node.TEXT_NODE, nodeValue: value });
// `tag` may carry a role: 'span[role=gridcell]'.
const el = (tag, display, ...childNodes) => {
  const [, name, role] = tag.match(/^([a-z0-9]+)(?:\[role=([a-z]+)\])?$/);
  return {
    nodeType: Node.ELEMENT_NODE,
    tagName: name.toUpperCase(),
    childNodes,
    hidden: false,
    display,
    getAttribute: attr => (attr === 'role' && role ? role : null),
    matches: sel => sel.toLowerCase() === name,
  };
};

// `text <t> "#target"` on a page whose #target is `target`.
function text(target) {
  const html = {
    ...el('html', 'block', target),
    matches: () => false,
    querySelector: sel => (sel === '#target' ? target : null),
  };
  const out = runInNewContext(T.textPageScript({ selectors: ['#target'] }), {
    document: { documentElement: html, body: html, querySelector: html.querySelector },
    window: { getComputedStyle: node => ({ display: node.display, visibility: 'visible' }) },
    Node,
    JSON,
  });
  return JSON.parse(out).text;
}

describe('#649 text keeps field boundaries', () => {
  it('puts <dt> and <dd> on their own lines', () => {
    const dl = el('dl', 'block',
      el('dt', 'block', t('Part number')), el('dd', 'block', t('BP-4471-C')),
      el('dt', 'block', t('Price')), el('dd', 'block', t('$64.90')),
      el('dt', 'block', t('In stock')), el('dd', 'block', t('37')));
    expect(text(dl)).toBe('Part number\nBP-4471-C\nPrice\n$64.90\nIn stock\n37');
  });

  it('separates table cells with a tab and rows with a newline', () => {
    const row = cells => el('tr', 'table-row', ...cells.map(value => el('td', 'table-cell', t(value))));
    const table = el('table', 'table', el('tbody', 'table-row-group',
      row(['#1042', 'Ann Lee', 'Conference hotel, 2 nights', 'NT$ 9,800', 'Pending']),
      row(['#1043', 'Bo Chen', 'Taxi', 'NT$ 420', 'Approved'])));
    expect(text(table)).toBe('#1042\tAnn Lee\tConference hotel, 2 nights\tNT$ 9,800\tPending\n#1043\tBo Chen\tTaxi\tNT$ 420\tApproved');
  });

  it('keeps an empty cell as an empty column and ends a cell at a block inside it', () => {
    const row = el('tr', 'table-row',
      el('td', 'table-cell', t(' \t a \t ')),
      el('td', 'table-cell'),
      el('td', 'table-cell', el('div', 'block', t('c'))),
      el('th', 'table-cell', t('d')));
    expect(text(row)).toBe('a\t\tc\td');
  });

  it('reads an ARIA grid built from divs like a table: tab between cells, newline between rows', () => {
    const row = (cellRole, values) => el('div[role=row]', 'grid', ...values.map(value => el(`span[role=${cellRole}]`, 'block', t(value))));
    const grid = el('div[role=grid]', 'block',
      row('columnheader', ['Shipment', 'Customer', 'Status', 'ETA']),
      row('gridcell', ['SHP-00183', 'Adatum', 'In transit', '2026-10-14']),
      row('gridcell', ['SHP-00184', 'Fabrikam', 'Out for delivery', '2026-10-11']));
    expect(text(grid)).toBe('Shipment\tCustomer\tStatus\tETA\nSHP-00183\tAdatum\tIn transit\t2026-10-14\nSHP-00184\tFabrikam\tOut for delivery\t2026-10-11');
  });

  it('ends each grid or flex item without a role (a blockified span) on its own line', () => {
    const grid = el('div', 'grid',
      el('span', 'block', t('Owner')), el('span', 'block', t('Platform team')),
      el('span', 'block', t('Status')), el('span', 'block', t('Active')));
    expect(text(grid)).toBe('Owner\nPlatform team\nStatus\nActive');
    const card = el('section', 'flex', el('span', 'block', t('Owner')), el('span', 'block', t('Platform team')));
    expect(text(card)).toBe('Owner\nPlatform team');
  });

  it('leaves inline elements joined, as on screen', () => {
    const p = el('p', 'block', el('b', 'inline', t('Bold')), t('text'), el('span', 'inline-block', t('badge')));
    expect(text(p)).toBe('Boldtextbadge');
  });

  it('adds no blank line when a block sits inside a tag that already ends the line', () => {
    const list = el('ul', 'block',
      el('li', 'list-item', el('a', 'block', t('One'))),
      el('li', 'list-item', el('a', 'block', el('span', 'block', t('Two')))));
    expect(text(list)).toBe('One\nTwo');
  });

  it('keeps the blank line that nested block tags already printed', () => {
    const page = el('section', 'block', el('div', 'block', el('p', 'block', t('a'))), el('div', 'block', el('p', 'block', t('b'))));
    expect(text(page)).toBe('a\n\nb');
  });
});
