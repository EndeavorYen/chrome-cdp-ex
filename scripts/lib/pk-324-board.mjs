/**
 * Locked 2026-08-17 live-session PK board (chrome-cdp-ex vs Browser Use vs Playwright).
 * Numbers are measured cells only. Do not invent, average, or remeasure here.
 */

export const LOCKED_PK_BOARD = Object.freeze({
  date: '2026-08-17',
  sha: '22c525d4',
  viewport: '1042×632',
  n: 3,
  scoreboard: Object.freeze({
    jobs: 10,
    chromeCdpEx: 10,
    browserUse: 8,
    playwright: 9,
  }),
  slowerThanBrowserUse: Object.freeze([
    Object.freeze({ job: 'nav example.org', cdp: 297, browserUse: 16 }),
    Object.freeze({ job: 'read HF home', cdp: 152, browserUse: 6 }),
    Object.freeze({ job: 'hover reveal', cdp: 145, browserUse: 14 }),
    Object.freeze({ job: 'overlay detect', cdp: 142, browserUse: 21 }),
  ]),
  tools: Object.freeze([
    Object.freeze({ key: 'cdp', label: 'chrome-cdp-ex', color: '#60a5fa' }),
    Object.freeze({ key: 'browserUse', label: 'Browser Use', color: '#fbbf24' }),
    Object.freeze({ key: 'playwright', label: 'Playwright', color: '#34d399' }),
  ]),
  jobs: Object.freeze([
    Object.freeze({
      name: 'scroll to bottom (HF home)',
      axis: 'scroll HF',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 139, token: 62 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 1, time: 227, token: 118 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 2, token: 41 }),
    }),
    Object.freeze({
      name: 'nested overflow (Comfy #content-container)',
      axis: 'nested',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 144, token: 83 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 3, time: 391, token: 6307 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 72, token: 70 }),
    }),
    Object.freeze({
      name: 'click Browse 2M+ models',
      axis: 'click 2M',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 487, token: 549 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 2, time: 507, token: 7636 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 352, token: 0 }),
    }),
    Object.freeze({
      name: 'search submit bert',
      axis: 'search bert',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 410, token: 114 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 5, time: 1261, token: 770 }),
      playwright: Object.freeze({ success: 'PASS', steps: 2, time: 1047, token: 0 }),
    }),
    Object.freeze({
      name: 'nav example.org',
      axis: 'nav',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 297, token: 69 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 1, time: 16, token: 86 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 12, token: 35 }),
    }),
    Object.freeze({
      name: 'read HF home',
      axis: 'read HF',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 152, token: 3863 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 1, time: 6, token: 7540 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 3, token: 4427 }),
    }),
    Object.freeze({
      name: 'hover reveal',
      axis: 'hover',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 145, token: 192 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 2, time: 14, token: 12025 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 67, token: 0 }),
    }),
    Object.freeze({
      name: 'PDF text one page',
      axis: 'PDF',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 232, token: 4323 }),
      browserUse: Object.freeze({ success: 'FAIL', steps: 1, time: 5, token: 94 }),
      playwright: Object.freeze({ success: 'FAIL', steps: 1, time: 2, token: 0 }),
    }),
    Object.freeze({
      name: 'overlay detect',
      axis: 'overlay',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 142, token: 232 }),
      browserUse: Object.freeze({ success: 'FAIL', steps: 1, time: 21, token: 35139 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 1, token: 178 }),
    }),
    Object.freeze({
      name: 'click Browse 1M+ applications',
      axis: 'click 1M',
      cdp: Object.freeze({ success: 'PASS', steps: 1, time: 457, token: 580 }),
      browserUse: Object.freeze({ success: 'PASS', steps: 2, time: 625, token: 7640 }),
      playwright: Object.freeze({ success: 'PASS', steps: 1, time: 318, token: 0 }),
    }),
  ]),
});

export const PK_324_CHART_FACES = Object.freeze(['steps', 'token', 'time']);
export const PK_324_CHART_FILES = Object.freeze({
  steps: 'experiment/pk-324-steps.svg',
  token: 'experiment/pk-324-token.svg',
  time: 'experiment/pk-324-time.svg',
});
export const PK_324_SCOREBOARD_FILE = 'experiment/pk-324-scoreboard.svg';
export const README_SCORE_FACES = Object.freeze(['steps', 'token', 'time']);

export function scoreCell(row, toolKey) {
  const cell = row[toolKey];
  return `${cell.success} / ${cell.steps} / ${cell.time} / ${cell.token}`;
}

export function passFaceWinners(job, face) {
  const keys = ['cdp', 'browserUse', 'playwright'];
  const pass = keys.filter(key => job[key].success === 'PASS');
  const min = Math.min(...pass.map(key => job[key][face]));
  return pass.filter(key => job[key][face] === min);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function niceMax(value) {
  if (value <= 0) return 1;
  if (Number.isInteger(value) && value <= 10) return value;
  const padded = value * 1.08;
  const magnitude = 10 ** Math.floor(Math.log10(padded));
  const normalized = padded / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function tickValues(max) {
  if (max <= 6) return Array.from({ length: max + 1 }, (_, index) => index);
  const steps = 4;
  return Array.from({ length: steps + 1 }, (_, index) => Math.round((max * index) / steps));
}

export function renderPk324ChartSvg(face, board = LOCKED_PK_BOARD) {
  if (!PK_324_CHART_FACES.includes(face)) {
    throw new Error(`Unknown PK chart face: ${face}`);
  }
  const width = 960;
  const height = 348;
  const pad = { top: 72, right: 20, bottom: 86, left: 58 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const values = board.jobs.flatMap(job => board.tools.map(tool => job[tool.key][face]));
  const max = niceMax(Math.max(...values));
  const groupWidth = plotWidth / board.jobs.length;
  const innerPad = 10;
  const barGap = 3;
  const barWidth = (groupWidth - innerPad * 2 - barGap * (board.tools.length - 1)) / board.tools.length;
  const units = { steps: 'steps', token: 'UTF-8 chars', time: 'wall ms' };
  const titles = {
    steps: 'Steps per job',
    token: 'Tokens returned to the agent',
    time: 'Wall time (ms)',
  };

  const legend = board.tools.map((tool, index) => {
    const x = pad.left + index * 210;
    return [
      `<rect x="${x}" y="44" width="12" height="12" rx="2" fill="${tool.color}"/>`,
      `<text x="${x + 18}" y="54" fill="#e5e7eb" font-size="13">${escapeXml(tool.label)}</text>`,
    ].join('');
  }).join('');

  const ticks = tickValues(max).map(tick => {
    const y = pad.top + plotHeight - (tick / max) * plotHeight;
    return [
      `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="1"/>`,
      `<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#9ca3af" font-size="11">${tick}</text>`,
    ].join('');
  }).join('');

  const bars = board.jobs.flatMap((job, jobIndex) => {
    const groupX = pad.left + jobIndex * groupWidth;
    return board.tools.map((tool, toolIndex) => {
      const value = job[tool.key][face];
      const barHeight = value <= 0 ? 0 : Math.max(2, (value / max) * plotHeight);
      const x = groupX + innerPad + toolIndex * (barWidth + barGap);
      const y = pad.top + plotHeight - barHeight;
      const label = `${tool.label} ${job.name} ${face} ${value}`;
      return [
        `<rect class="pk-bar" data-job="${escapeXml(job.name)}" data-tool="${escapeXml(tool.label)}" data-face="${face}" data-value="${value}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="${tool.color}">`,
        `<title>${escapeXml(label)}</title>`,
        '</rect>',
        `<text class="pk-value" data-job="${escapeXml(job.name)}" data-tool="${escapeXml(tool.label)}" data-face="${face}" font-size="0">${value}</text>`,
      ].join('');
    });
  }).join('');

  const axisLabels = board.jobs.map((job, jobIndex) => {
    const x = pad.left + jobIndex * groupWidth + groupWidth / 2;
    const y = height - 52;
    return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="end" fill="#9ca3af" font-size="11" transform="rotate(-36 ${x.toFixed(1)} ${y})">${escapeXml(job.axis)}</text>`;
  }).join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(titles[face])}">`,
    '<rect width="100%" height="100%" fill="#0b0f14"/>',
    `<text x="${pad.left}" y="28" fill="#f9fafb" font-size="18" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700">${escapeXml(titles[face])}</text>`,
    `<text x="${width - pad.right}" y="28" text-anchor="end" fill="#9ca3af" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(units[face])} · not averaged</text>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${legend}</g>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${ticks}</g>`,
    `<line x1="${pad.left}" y1="${pad.top + plotHeight}" x2="${width - pad.right}" y2="${pad.top + plotHeight}" stroke="#4b5563" stroke-width="1.5"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${bars}</g>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${axisLabels}</g>`,
    `<text x="${pad.left}" y="${height - 12}" fill="#6b7280" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">X-axis = 10 jobs · ${board.date} · ${board.sha}</text>`,
    '</svg>',
    '',
  ].join('\n');
}

export function renderPk324Charts(board = LOCKED_PK_BOARD) {
  return Object.fromEntries(PK_324_CHART_FACES.map(face => [face, renderPk324ChartSvg(face, board)]));
}

export function renderPk324ScoreboardSvg(board = LOCKED_PK_BOARD) {
  const width = 960;
  const height = 648;
  const padX = 20;
  const labelWidth = 276;
  const tableX = padX + labelWidth;
  const tableRight = width - padX;
  const colWidth = (tableRight - tableX) / board.tools.length;
  const headerY = 28;
  const colHeaderY = 74;
  const tableTop = 86;
  const totalRowHeight = 40;
  const jobRowHeight = 46;
  const jobsTop = tableTop + totalRowHeight;
  const failFill = '#3f1518';
  const failStroke = '#f87171';
  const passFill = '#111827';
  const totalFill = '#0f172a';

  const legend = board.tools.map((tool, index) => {
    const x = tableX + index * colWidth + 10;
    return [
      `<rect x="${x.toFixed(1)}" y="62" width="10" height="10" rx="2" fill="${tool.color}"/>`,
      `<text x="${(x + 16).toFixed(1)}" y="${colHeaderY}" fill="#e5e7eb" font-size="13">${escapeXml(tool.label)}</text>`,
    ].join('');
  }).join('');

  const totals = board.tools.map((tool, index) => {
    const valueKey = tool.key === 'cdp' ? 'chromeCdpEx' : tool.key;
    const score = `${board.scoreboard[valueKey]}/10`;
    const x = tableX + index * colWidth;
    const winner = tool.key === 'cdp';
    const weight = winner ? ' font-weight="700"' : '';
    const fill = winner ? tool.color : '#e5e7eb';
    return [
      `<g class="pk-total" data-tool="${escapeXml(tool.label)}">`,
      `<rect x="${x.toFixed(2)}" y="${tableTop}" width="${colWidth.toFixed(2)}" height="${totalRowHeight}" fill="${totalFill}"/>`,
      `<text x="${(x + colWidth / 2).toFixed(1)}" y="${tableTop + 26}" text-anchor="middle" fill="${fill}" font-size="18" data-value="${score}"${weight}>${score}</text>`,
      '</g>',
    ].join('');
  }).join('');

  const jobRows = board.jobs.map((job, jobIndex) => {
    const y = jobsTop + jobIndex * jobRowHeight;
    const label = `<text x="${padX + 8}" y="${y + 28}" fill="#e5e7eb" font-size="12">${escapeXml(job.name)}</text>`;
    const cells = board.tools.map((tool, toolIndex) => {
      const cell = job[tool.key];
      const x = tableX + toolIndex * colWidth;
      const failed = cell.success === 'FAIL';
      const className = failed ? 'pk-cell pk-fail' : 'pk-cell';
      const rect = failed
        ? `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${colWidth.toFixed(2)}" height="${jobRowHeight}" fill="${failFill}" stroke="${failStroke}" stroke-width="1"/>`
        : `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${colWidth.toFixed(2)}" height="${jobRowHeight}" fill="${passFill}"/>`;
      const statusFill = failed ? '#f87171' : '#86efac';
      const faces = README_SCORE_FACES.map((face, faceIndex) => {
        const value = cell[face];
        const win = !failed && passFaceWinners(job, face).includes(tool.key);
        const weight = win ? ' font-weight="700"' : '';
        const faceFill = failed ? '#fca5a5' : win ? '#f9fafb' : '#9ca3af';
        const prefix = faceIndex === 0 ? '' : '<tspan fill="#6b7280"> / </tspan>';
        return `${prefix}<tspan data-face="${face}" fill="${faceFill}"${weight}>${value}</tspan>`;
      }).join('');
      const visibleScore = `${cell.steps} / ${cell.token} / ${cell.time}`;
      return [
        `<g class="${className}" data-job="${escapeXml(job.name)}" data-tool="${escapeXml(tool.label)}" data-success="${cell.success}" data-steps="${cell.steps}" data-token="${cell.token}" data-time="${cell.time}">`,
        rect,
        `<text x="${(x + colWidth / 2).toFixed(1)}" y="${(y + 17).toFixed(1)}" text-anchor="middle" fill="${statusFill}" font-size="11">${cell.success}</text>`,
        `<text x="${(x + colWidth / 2).toFixed(1)}" y="${(y + 34).toFixed(1)}" text-anchor="middle" font-size="12" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${faces}</text>`,
        `<text class="pk-score-text" font-size="0">${escapeXml(visibleScore)}</text>`,
        '</g>',
      ].join('');
    }).join('');
    return `${label}${cells}`;
  }).join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="PK scoreboard for chrome-cdp-ex, Browser Use, and Playwright">`,
    '<rect width="100%" height="100%" fill="#0b0f14"/>',
    `<text x="${padX}" y="${headerY}" fill="#f9fafb" font-size="18" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="700">10 jobs. Who finishes.</text>`,
    `<text x="${width - padX}" y="${headerY}" text-anchor="end" fill="#9ca3af" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(board.date)} · ${escapeXml(board.sha)}</text>`,
    `<text x="${padX}" y="48" fill="#9ca3af" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">steps / token / wall ms · PASS winners bold · FAIL cannot win</text>`,
    `<text x="${padX + 8}" y="${tableTop + 26}" fill="#e5e7eb" font-size="13" font-weight="700">Total success</text>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${legend}</g>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${totals}</g>`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif">${jobRows}</g>`,
    `<text x="${padX}" y="${height - 16}" fill="#6b7280" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">X-axis = 10 jobs · ${escapeXml(board.date)} · ${escapeXml(board.sha)} · FAIL cells marked in red</text>`,
    '</svg>',
    '',
  ].join('\n');
}

