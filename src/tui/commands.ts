export const COMMANDS: { name: string; description: string }[] = [
  { name: '/help', description: 'list these commands' },
  { name: '/setup', description: 'change provider, API key, model or folder' },
  { name: '/config', description: 'show the current settings' },
  { name: '/config set', description: 'change one setting' },
  { name: '/config reload', description: 'discard edits and re-read the file' },
  { name: '/verbose', description: 'show or hide tool activity' },
  { name: '/clear', description: 'clear the transcript' },
  { name: '/exit', description: 'quit' },
];

export const MAX_SUGGESTIONS = 6;

/** Commands matching what has been typed so far. Empty unless the line starts with "/". */
export function matchingCommands(draft: string): typeof COMMANDS {
  if (!draft.startsWith('/')) return [];
  return COMMANDS.filter(command => command.name.startsWith(draft) || draft === '/').slice(0, MAX_SUGGESTIONS);
}
