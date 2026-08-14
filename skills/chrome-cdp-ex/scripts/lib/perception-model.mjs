import { uniqueNextStepCommands } from './action-recovery.mjs';

export function buildGoldenPathRecommendation({
  stage,
  targetPrefix = null,
  run = null,
  ask = null,
  after = null,
  evidence = null,
  report = null,
  reason = null,
  commands = null,
  requiresUserAction = false,
  consentRequired = false,
} = {}) {
  return {
    source: 'golden-path',
    stage,
    targetPrefix,
    run,
    ask,
    after,
    evidence,
    report,
    requiresUserAction,
    consentRequired,
    reason,
    commands: commands || uniqueNextStepCommands([run, after, evidence, report]),
  };
}

export function goldenPathOpenPageRecommendation() {
  return buildGoldenPathRecommendation({
    stage: 'open-page',
    run: 'cdp open https://example.com',
    after: 'cdp text <target-from-open> --auto',
    reason: 'no debuggable page targets are available yet',
    commands: ['cdp open https://example.com'],
  });
}

export function goldenPathListRecommendation() {
  return buildGoldenPathRecommendation({
    stage: 'pick-target',
    run: 'cdp list --format json',
    after: 'cdp text <target-from-list> --auto',
    evidence: 'cdp perceive <target-from-list> --cards',
    reason: 'list already returned pages — pick a tab, then text --auto / --cards. Do not auto-aim the starred tab. (sample after list — not a next-probe): cdp perceive <target-from-list> -C -d 8',
    commands: [
      'cdp list --format json',
      'cdp text <target-from-list> --auto',
      'cdp perceive <target-from-list> --cards',
    ],
  });
}

export function goldenPathReadPageRecommendation(targetPrefix) {
  return buildGoldenPathRecommendation({
    stage: 'read-page',
    targetPrefix,
    run: `cdp text ${targetPrefix} --auto`,
    after: `cdp perceive ${targetPrefix} --cards`,
    evidence: `cdp perceive ${targetPrefix} --qa`,
    report: `cdp report ${targetPrefix}`,
    reason: 'For "what does this page say", use text --auto or --cards. perceive -C -d 8 is a sample after list, not a next-probe',
  });
}

export function goldenPathPerceiveRecommendation(targetPrefix) {
  return buildGoldenPathRecommendation({
    stage: 'perceive',
    targetPrefix,
    run: `cdp perceive ${targetPrefix} -C -d 8`,
    after: `cdp click ${targetPrefix} @ref  # choose a ref from perceive`,
    evidence: `cdp perceive ${targetPrefix} --since-action`,
    report: `cdp report ${targetPrefix}`,
    reason: 'observe the real page before choosing an action target. For "what does this page say", run cdp text ' + targetPrefix + ' --auto',
  });
}

export function goldenPathActRecommendation(targetPrefix, { ref = '@ref', fromPerceptionBelow = false } = {}) {
  const refText = ref === '@ref'
    ? `cdp click ${targetPrefix} @ref  # choose a ref from ${fromPerceptionBelow ? 'the perception below' : 'perceive'}`
    : `cdp click ${targetPrefix} ${ref}`;
  return buildGoldenPathRecommendation({
    stage: 'act',
    targetPrefix,
    run: refText,
    after: `cdp perceive ${targetPrefix} --since-action`,
    report: `cdp report ${targetPrefix}`,
    reason: ref === '@ref'
      ? 'perception is ready; choose an interactive ref and act'
      : `use the first interactive ref ${ref} from perception, then verify action evidence`,
  });
}

export function goldenPathBrowserPermissionRecommendation(targetPrefix) {
  return buildGoldenPathRecommendation({
    stage: 'browser-permission',
    targetPrefix,
    run: `cdp perceive ${targetPrefix} -C -d 8`,
    ask: 'Click Allow if Chrome asks.',
    after: `cdp click ${targetPrefix} @ref  # choose a ref from perceive`,
    evidence: `cdp perceive ${targetPrefix} --since-action`,
    report: `cdp report ${targetPrefix}`,
    requiresUserAction: true,
    reason: 'browser debugging approval is not confirmed yet',
    commands: [`cdp perceive ${targetPrefix} -C -d 8`],
  });
}

export function createPerceptionModel({ targetPrefix = '<target>', page, viewport, consoleHealth, refs, nodes, limits }) {
  const firstRef = nodes?.find(node => node.ref)?.ref || '@ref';
  const recommendation = goldenPathActRecommendation(targetPrefix, { ref: firstRef });
  return {
    schema: 'chrome-cdp-ex.perceive.v1',
    targetPrefix,
    page,
    viewport: {
      ...viewport,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
    refs: {
      generation: refs.generation,
      validity: 'until-navigation-or-dom-rewrite',
    },
    nodes,
    limits,
    recommendation,
    nextSteps: recommendation.commands,
  };
}

export function formatPerceptionJson(model) {
  return JSON.stringify(model, null, 2);
}
