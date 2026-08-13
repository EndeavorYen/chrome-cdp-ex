import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = {
  commands: readFileSync(new URL('../skills/chrome-cdp-ex/references/commands.md', import.meta.url), 'utf8'),
  reference: readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8'),
  readme: readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
  changelog: readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  skill: readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8'),
};

function unreleasedChangelog(text) {
  const match = text.match(/^## \[Unreleased\][\s\S]*?(?=^## \[)/m);
  return match ? match[0] : '';
}

describe('claim-honest table documentation', () => {
  it('removes unbounded full-table claims from current-facing docs', () => {
    const currentFacing = [
      files.commands,
      files.reference,
      files.readme,
      files.skill,
      unreleasedChangelog(files.changelog),
    ].join('\n');
    expect(currentFacing).not.toMatch(/Full table data/i);
    expect(currentFacing).not.toMatch(/no row limit/i);
    expect(currentFacing).not.toMatch(/no 5-row truncation/i);
    expect(currentFacing).not.toMatch(/all tables on page \(tab-separated, no row limit\)/i);
  });

  it('explains bounded observation, completeness, collection, continuation, ceilings, confirmation, and loadall', () => {
    const docs = `${files.commands}\n${unreleasedChangelog(files.changelog)}`;
    expect(docs).toMatch(/bounded observation/i);
    expect(docs).toMatch(/completeness/i);
    expect(docs).toMatch(/--collect/);
    expect(docs).toMatch(/--scroll-container/);
    expect(docs).toMatch(/--continue/);
    expect(docs).toMatch(/confirm:\s*true/);
    expect(docs).toMatch(/20 inline/i);
    expect(docs).toMatch(/8,192/);
    expect(docs).toMatch(/16,384/);
    expect(docs).toMatch(/100,000/);
    expect(docs).toMatch(/loadall/);
    expect(docs).toMatch(/recycl/i);
    expect(docs).toMatch(/Windows/i);
    expect(docs).toMatch(/aria-rowindex|row-key-column/);
  });
});
