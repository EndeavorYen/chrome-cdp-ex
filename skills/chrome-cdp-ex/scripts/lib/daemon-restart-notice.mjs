// The first user-visible line after a tab daemon restart (#575). Text output starts with it.
// JSON output prints it first and leaves the JSON body on the following lines, so a parser
// that reads the whole stdout has to skip this one line.

export const DAEMON_RESTART_NOTICE_PREFIX = 'daemon restarted:';

export function withoutDaemonRestartNotice(text) {
  const raw = String(text ?? '');
  const leading = raw.match(/^\uFEFF?\s*/)?.[0].length ?? 0;
  const rest = raw.slice(leading);
  if (!rest.startsWith(DAEMON_RESTART_NOTICE_PREFIX)) return raw;
  const nl = rest.indexOf('\n');
  if (nl === -1) return '';
  return rest.slice(nl + 1);
}
