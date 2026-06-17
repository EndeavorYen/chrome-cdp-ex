function commandMeta(commands, cmd) {
  return commands.find(command => command.name === cmd || (command.aliases || []).includes(cmd)) || null;
}

export function commandReturnsActionJson(cmd, { commands = [] } = {}) {
  const meta = commandMeta(commands, cmd);
  return meta?.mutates === true
    && meta.feedbackPolicy
    && Array.isArray(meta.outputFormats)
    && meta.outputFormats.includes('json');
}

export function argsHaveFormatOption(args = []) {
  return Array.isArray(args) && args.includes('--format');
}

export function autoActionJsonArgs(cmd, args = [], enabled = false, { commands = [] } = {}) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  if (!enabled || !commandReturnsActionJson(cmd, { commands }) || argsHaveFormatOption(normalizedArgs)) return normalizedArgs;
  return [...normalizedArgs, '--format', 'json'];
}
