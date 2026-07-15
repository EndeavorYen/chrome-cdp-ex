export function screenshotHealthScript(pngBase64) {
  return `(async () => {
    const parseRgb = value => {
      const match = String(value || '').match(/rgba?\\((\\d+)[, ]+(\\d+)[, ]+(\\d+)/i);
      return match ? match.slice(1, 4).map(Number) : null;
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
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;
    const rootStyle = document.documentElement ? getComputedStyle(document.documentElement) : null;
    const bodyRgb = parseRgb(bodyStyle?.backgroundColor);
    const rootRgb = parseRgb(rootStyle?.backgroundColor);
    const pageTone = toneFor(bodyRgb) !== 'unknown' ? toneFor(bodyRgb) : toneFor(rootRgb);
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
    let visible = 0;
    let nearBlack = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 16) continue;
      visible += 1;
      if (pixels[index] <= 20 && pixels[index + 1] <= 20 && pixels[index + 2] <= 20) nearBlack += 1;
    }
    const nearBlackRatio = visible ? nearBlack / visible : 0;
    const retry = pageTone === 'light' && nearBlackRatio >= 0.80;
    return JSON.stringify({
      retry,
      reason: retry ? 'near-black-frame-on-light-page' : pageTone === 'dark' ? 'dark-page' : 'frame-consistent',
      nearBlackRatio,
      pageTone,
      sample: { width, height, visiblePixels: visible },
    });
  })()`;
}

export function unavailableScreenshotSanity(reason = 'inspection-unavailable') {
  return { retry: false, reason, nearBlackRatio: null, pageTone: 'unknown' };
}

