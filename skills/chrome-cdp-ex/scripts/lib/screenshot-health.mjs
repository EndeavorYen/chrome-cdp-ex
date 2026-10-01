// A frame is contradictory only where the DOM predicts a light pixel and the capture
// shows near-black. Each grid point walks the paint stack at that point (topmost first,
// into open shadow roots) until something paints: an opaque background colour predicts a
// tone, while canvas / video / img / iframe / background-image content cannot be predicted
// from CSS and is left out. Transparent layers (a full-window UI overlay) are looked
// through (#452: a dark WebGL canvas under a light page's UI is a real frame).
//
// `clip` is the capture's CSS-px rectangle in document coordinates, as
// Page.captureScreenshot reads it. Without it the frame is the viewport. Points outside
// the viewport cannot be hit-tested and are left out.
export function screenshotHealthScript(pngBase64, { clip = null } = {}) {
  const clipJson = JSON.stringify(clip && Number.isFinite(clip.width) && Number.isFinite(clip.height)
    ? { x: Number(clip.x) || 0, y: Number(clip.y) || 0, width: clip.width, height: clip.height }
    : null);
  return `(async () => {
    const parseRgba = value => {
      const match = String(value || '').match(/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)(?:[,/ ]+([\\d.]+%?))?/i);
      if (!match) return null;
      let alpha = match[4] == null ? 1 : parseFloat(match[4]);
      if (String(match[4] || '').endsWith('%')) alpha /= 100;
      return { rgb: match.slice(1, 4).map(Number), alpha };
    };
    const toneFor = rgb => {
      if (!rgb) return 'unknown';
      const linear = rgb.map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
      });
      const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      return luminance >= 0.45 ? 'light' : luminance <= 0.20 ? 'dark' : 'unknown';
    };
    const opaqueTone = style => {
      const rgba = parseRgba(style?.backgroundColor);
      return rgba && rgba.alpha >= 0.9 ? toneFor(rgba.rgb) : null;
    };
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;
    const rootStyle = document.documentElement ? getComputedStyle(document.documentElement) : null;
    const pageTone = opaqueTone(bodyStyle) || opaqueTone(rootStyle) || 'unknown';
    const MEDIA = /^(canvas|video|img|picture|iframe|frame|embed|object|svg)$/i;
    // Paint stack at a point, topmost first; an open shadow root's stack replaces its host.
    const stackAt = (root, x, y, depth) => {
      const list = typeof root.elementsFromPoint === 'function'
        ? root.elementsFromPoint(x, y)
        : [root.elementFromPoint?.(x, y)].filter(Boolean);
      const out = [];
      for (const node of list) {
        if (depth < 4 && node.shadowRoot && node.shadowRoot !== root) {
          for (const inner of stackAt(node.shadowRoot, x, y, depth + 1)) {
            if (inner !== node && !out.includes(inner)) out.push(inner);
          }
        }
        if (!out.includes(node)) out.push(node);
      }
      return out;
    };
    const expectedTone = (x, y) => {
      const stack = stackAt(document, x, y, 0);
      if (!stack.length) return 'unknown';
      for (const node of stack) {
        if (!node || node.nodeType !== 1) continue;
        if (MEDIA.test(node.tagName)) return 'media';
        const style = getComputedStyle(node);
        if (style.backgroundImage && style.backgroundImage !== 'none') return 'media';
        const tone = opaqueTone(style);
        if (tone) return tone;
      }
      return pageTone;
    };
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('screenshot image decode failed'));
    });
    image.src = 'data:image/png;base64,${pngBase64}';
    await loaded;
    const width = Math.max(1, Math.min(64, image.naturalWidth || image.width || 1));
    const height = Math.max(1, Math.min(64, image.naturalHeight || image.height || 1));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const isNearBlack = index => pixels[index] <= 20 && pixels[index + 1] <= 20 && pixels[index + 2] <= 20;
    let visible = 0;
    let nearBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 16) continue;
      visible += 1;
      if (isNearBlack(index)) nearBlack += 1;
    }
    const nearBlackRatio = visible ? nearBlack / visible : 0;
    const clip = ${clipJson};
    const frame = clip
      ? { ...clip, x: clip.x - scrollX, y: clip.y - scrollY }
      : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    const GRID = 12;
    let points = 0;
    let lightPoints = 0;
    let mediaPoints = 0;
    let contradicted = 0;
    for (let row = 0; row < GRID; row += 1) {
      for (let col = 0; col < GRID; col += 1) {
        const fx = (col + 0.5) / GRID;
        const fy = (row + 0.5) / GRID;
        const x = frame.x + fx * frame.width;
        const y = frame.y + fy * frame.height;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const index = (Math.min(height - 1, Math.floor(fy * height)) * width + Math.min(width - 1, Math.floor(fx * width))) * 4;
        if (pixels[index + 3] < 16) continue;
        points += 1;
        const tone = expectedTone(x, y);
        if (tone === 'media') mediaPoints += 1;
        if (tone !== 'light') continue;
        lightPoints += 1;
        if (isNearBlack(index)) contradicted += 1;
      }
    }
    const lightRatio = points ? lightPoints / points : 0;
    const contradictionRatio = lightPoints ? contradicted / lightPoints : 0;
    const retry = lightRatio >= 0.5 && contradictionRatio >= 0.80;
    return JSON.stringify({
      retry,
      reason: retry ? 'near-black-frame-on-light-page' : pageTone === 'dark' ? 'dark-page' : 'frame-consistent',
      nearBlackRatio,
      contradictionRatio,
      lightRatio,
      mediaRatio: points ? mediaPoints / points : 0,
      pageTone,
      sample: { width, height, visiblePixels: visible, points },
    });
  })()`;
}

export function unavailableScreenshotSanity(reason = 'inspection-unavailable') {
  return { retry: false, reason, nearBlackRatio: null, pageTone: 'unknown' };
}
