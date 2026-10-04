import { cleanLabel } from './core.mjs';

// The renderer accepts only a character count, never the secret itself.
// Host-provided width/wrapping functions account for ANSI, CJK and emoji.
export function renderPrivatePanel({ width, height = Infinity, title, message, length = 0, focused = false, seconds = 120, error }, { theme, truncateToWidth, visibleWidth, wrapTextWithAnsi, cursorMarker }) {
  width = Math.max(4, Math.floor(width));
  const inner = width - 4;
  const border = text => theme.fg('borderAccent', text);
  const row = (text = '', background = 'customMessageBg') => {
    const clipped = truncateToWidth(text, inner, '');
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(clipped)));
    return theme.bg('customMessageBg', border('│') + ' ' + theme.bg(background, clipped + padding) + ' ' + border('│'));
  };
  const rows = [theme.bg('customMessageBg', border('╭' + '─'.repeat(width - 2) + '╮'))];
  const badge = inner >= 42 ? 'LOCAL ONLY' : '';
  const heading = truncateToWidth('PRIVATE INPUT', Math.max(0, inner - (badge ? badge.length + 2 : 0)), '');
  const gap = ' '.repeat(Math.max(0, inner - visibleWidth(heading) - badge.length));
  rows.push(row(theme.fg('accent', heading) + gap + theme.fg('muted', badge)), row());
  rows.push(row(theme.fg('text', cleanLabel(title))));
  const context = message.split('\n').flatMap(line => wrapTextWithAnsi(cleanLabel(line), Math.max(1, inner)));
  for (const line of context.slice(0, 3)) rows.push(row(theme.fg('muted', line)));
  if (context.length > 3) rows.push(row(theme.fg('dim', '…')));
  rows.push(row(), row(theme.fg('muted', 'Secret')));
  const cursor = focused ? cursorMarker + '\x1b[7m \x1b[27m' : ' ';
  const available = Math.max(0, inner - 1);
  const field = length ? theme.fg('accent', '•'.repeat(Math.min(length, available))) + cursor : cursor + theme.fg('dim', truncateToWidth('Type or paste your secret…', available, ''));
  const inputRow = row(field, 'selectedBg');
  rows.push(inputRow);
  if (error) rows.push(row(theme.fg('error', cleanLabel(error))));
  rows.push(row());
  const privacy = inner >= 40 ? 'Hidden from chat, history and tool arguments.' : 'Private · never sent to chat';
  rows.push(row(theme.fg('dim', privacy)));
  const help = inner >= 54 ? `Enter submit · Esc cancel · Ctrl+U clear · ${seconds}s` : `Enter OK · Esc cancel · ${seconds}s`;
  for (const line of wrapTextWithAnsi(help, Math.max(1, inner))) rows.push(row(theme.fg('muted', line)));
  const bottom = theme.bg('customMessageBg', border('╰' + '─'.repeat(width - 2) + '╯'));
  rows.push(bottom);
  if (rows.length > height) {
    const compact = [rows[0], row(theme.fg('accent', cleanLabel(title)))];
    if (height >= 6) compact.push(row(theme.fg(error ? 'error' : 'muted', cleanLabel(error || context[0] || 'Private input'))));
    compact.push(inputRow, row(theme.fg('muted', `Enter OK · Esc cancel · ${seconds}s`)), bottom);
    return compact;
  }
  return rows;
}
