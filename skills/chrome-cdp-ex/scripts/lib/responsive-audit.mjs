const DEFAULT_FINDING_LIMIT = 12;

function boundedFinding(finding = {}) {
  const pick = {};
  for (const key of [
    'selector', 'name', 'severity', 'clippedRatio', 'overlapRatio',
    'elementRect', 'containerRect', 'occluderRect', 'occluderSelector',
    'occluderName', 'suppression',
  ]) {
    if (finding[key] !== undefined && finding[key] !== null && finding[key] !== '') {
      pick[key] = finding[key];
    }
  }
  return pick;
}

export function normalizeResponsiveFindings(metrics = {}, { limit = DEFAULT_FINDING_LIMIT } = {}) {
  const cap = Math.max(0, Math.min(Number(limit) || DEFAULT_FINDING_LIMIT, 50));
  const clipped = Array.isArray(metrics.clippedControls) ? metrics.clippedControls : [];
  const overlaps = Array.isArray(metrics.overlaps) ? metrics.overlaps : [];
  const suppressed = [...clipped, ...overlaps].filter(finding => finding?.suppressed).length;
  const clippedControls = clipped.filter(finding => !finding?.suppressed).slice(0, cap).map(boundedFinding);
  const materialOverlaps = overlaps.filter(finding => !finding?.suppressed).slice(0, cap).map(boundedFinding);
  return {
    clippedControls,
    overlaps: materialOverlaps,
    suppressed,
    truncated: clipped.filter(finding => !finding?.suppressed).length > cap
      || overlaps.filter(finding => !finding?.suppressed).length > cap,
  };
}

export function hasResponsiveFindings(findings = {}) {
  return Boolean(findings.clippedControls?.length || findings.overlaps?.length);
}

