// A `Next:` line is only a shell command (#637). Kind and "ask a human first"
// stay on their own lines so the command can be pasted into bash or PowerShell.

export const ASK_HUMAN_FIRST_LINE = 'Ask a human first';

export function formatNextLine(command) {
  const text = String(command ?? '').trim();
  if (!text) return '';
  return `Next: ${text}`;
}

// Lines that close an error after its Recovery block. Kind is included only when
// the caller says the block above does not already carry this kind.
export function formatNextClosingLines(recovery, { includeKind = false, existingKind = null } = {}) {
  const lines = [];
  const kind = recovery?.kind || '';
  if (includeKind && kind && kind !== existingKind) lines.push(`Kind: ${kind}`);
  if (recovery?.consentRequired && recovery?.run) lines.push(ASK_HUMAN_FIRST_LINE);
  // The command to paste is `run`. When discovery has no command (a live profile
  // must not be relaunched), `then` is the executable follow-up, such as `cdp doctor`.
  const command = String(recovery?.run || recovery?.then || '').trim();
  if (command) lines.push(formatNextLine(command));
  return lines;
}
