import { describe, expect, it } from 'vitest';

import {
  createPerceptionModel,
  formatPerceptionJson,
  goldenPathActRecommendation,
} from '../skills/chrome-cdp-ex/scripts/lib/perception-model.mjs';

describe('perception model lib', () => {
  it('builds an agent-readable perception model with a primary action recommendation', () => {
    const model = createPerceptionModel({
      targetPrefix: 'ABC123',
      page: { title: 'Dashboard', url: 'https://example.test/app' },
      viewport: { width: 1280, height: 720 },
      consoleHealth: { errors: 0, warnings: 0, exceptions: 0 },
      refs: { generation: 3 },
      nodes: [{ role: 'button', name: 'Save', ref: '@2' }],
      limits: { maxDepth: 8 },
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.perceive.v1',
      targetPrefix: 'ABC123',
      viewport: { coordinateSpace: 'viewport-css-px' },
      refs: { generation: 3, validity: 'until-navigation-or-dom-rewrite' },
      recommendation: {
        source: 'golden-path',
        stage: 'act',
        run: 'cdp click ABC123 @2',
        after: 'cdp perceive ABC123 --since-action',
      },
      nextSteps: [
        'cdp click ABC123 @2',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123',
      ],
    });
  });

  it('keeps default act recommendations executable when no ref is known', () => {
    expect(goldenPathActRecommendation('ABC123')).toMatchObject({
      run: 'cdp click ABC123 @ref  # choose a ref from perceive',
      commands: [
        'cdp click ABC123 @ref  # choose a ref from perceive',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123',
      ],
    });
  });

  it('formats perception JSON without depending on the CLI entrypoint', () => {
    const parsed = JSON.parse(formatPerceptionJson(createPerceptionModel({
      targetPrefix: 'ABC123',
      page: {},
      viewport: {},
      consoleHealth: {},
      refs: { generation: 1 },
      nodes: [],
      limits: {},
    })));

    expect(parsed.schema).toBe('chrome-cdp-ex.perceive.v1');
  });
});
