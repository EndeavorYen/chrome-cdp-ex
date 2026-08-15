function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

export function classifyPageHealth(signals = {}) {
  const readyState = String(signals.readyState || '').toLowerCase();
  const visibleTextLength = finiteCount(signals.visibleTextLength);
  const elementCount = finiteCount(signals.elementCount);
  const visibleControlCount = finiteCount(signals.visibleControlCount);
  const bodyWidth = finiteCount(signals.bodyRect?.width);
  const bodyHeight = finiteCount(signals.bodyRect?.height);
  const changed = signals.changed === true;
  const evidence = {
    url: String(signals.url || ''),
    title: String(signals.title || ''),
    readyState: readyState || null,
    visibleTextLength,
    elementCount,
    visibleControlCount,
    bodyRect: bodyWidth == null && bodyHeight == null ? null : { width: bodyWidth, height: bodyHeight },
    changed,
  };

  if (readyState === 'loading') {
    return { status: 'indeterminate', isBlank: false, confidence: 'low', evidence };
  }

  const populated = changed
    || (visibleTextLength != null && visibleTextLength >= 2)
    || (visibleControlCount != null && visibleControlCount > 0)
    || (elementCount != null && elementCount >= 8)
    || (elementCount != null && elementCount >= 4 && bodyHeight != null && bodyHeight >= 16);
  if (populated) {
    return { status: 'populated', isBlank: false, confidence: changed ? 'high' : 'medium', evidence };
  }

  const hasStableSignals = visibleTextLength != null && elementCount != null && visibleControlCount != null;
  const empty = hasStableSignals
    && visibleTextLength === 0
    && visibleControlCount === 0
    && elementCount <= 3
    && (bodyHeight == null || bodyHeight <= 1);
  if (empty) {
    return { status: 'blank', isBlank: true, confidence: 'high', evidence };
  }

  return { status: 'indeterminate', isBlank: false, confidence: 'low', evidence };
}

export function pageHealthScript() {
  return `(function() {
    const controls = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const body = document.body;
    const rect = body ? body.getBoundingClientRect() : { width: 0, height: 0 };
    const text = body ? (body.innerText || body.textContent || '') : '';
    return JSON.stringify({
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      visibleTextLength: text.trim().length,
      elementCount: document.querySelectorAll('*').length,
      visibleControlCount: controls.length,
      bodyRect: { width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  })()`;
}

