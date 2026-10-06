import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrivatePanel } from '../src/panel.mjs';

// Plain-text renderer doubles. The real host's ANSI/Unicode helpers are also
// checked through the Pi loader during development; no dependency is installed.
const api = {
  theme: { fg: (_color, text) => text, bg: (_color, text) => text },
  truncateToWidth: (text, width) => Array.from(text).slice(0, Math.max(0, width)).join(''),
  visibleWidth: text => Array.from(text).length,
  wrapTextWithAnsi: (text, width) => {
    const chars = Array.from(text), lines = [];
    for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''));
    return lines.length ? lines : [''];
  },
  cursorMarker: '',
};

test('private modal has complete borders, padding, title, purpose, masked field and controls', () => {
  const rows = renderPrivatePanel({ width: 72, title: 'Private input', message: 'Service API key', length: 12, seconds: 85 }, api);
  assert.ok(rows[0].startsWith('╭'));
  assert.ok(rows.at(-1).startsWith('╰'));
  assert.ok(rows.slice(1, -1).every(row => row.startsWith('│') && row.endsWith('│')));
  assert.ok(rows.every(row => Array.from(row).length === 72));
  const text = rows.join('\n');
  for (const content of ['PRIVATE INPUT', 'LOCAL ONLY', 'Service API key', '••••', 'Enter submit', 'Esc cancel', '85s']) assert.ok(text.includes(content));
});

test('public reason and credential label are visible in authentication modals', () => {
  for (const title of ['Private input', 'SSH key passphrase', 'Sudo password']) {
    const rows = renderPrivatePanel({ width: 72, height: 19, title, message: 'Reason: Authenticate the requested Git fetch.\nCredential: SSH key', length: 0 }, api);
    const text = rows.join('\n');
    assert.ok(text.includes('Reason: Authenticate the requested Git fetch.'));
    assert.ok(text.includes('Credential: SSH key'));
  }
});

test('narrow layouts and long context remain bounded; only a count is accepted for masking', () => {
  for (const width of [8, 20, 36, 72]) {
    const rows = renderPrivatePanel({ width, title: 'SSH key passphrase', message: 'A long public context line '.repeat(40), length: 65536, seconds: 1 }, api);
    assert.ok(rows.every(row => Array.from(row).length === width));
    assert.ok(rows.length < 25);
    assert.ok(rows.at(-1).endsWith('╯'));
  }
});

test('short terminals keep the field, controls and both borders visible', () => {
  const rows = renderPrivatePanel({ width: 36, height: 6, title: 'Private input', message: 'A long context '.repeat(20), length: 5 }, api);
  assert.equal(rows.length, 6);
  assert.ok(rows[0].startsWith('╭'));
  assert.ok(rows.at(-1).endsWith('╯'));
  assert.ok(rows.join('\n').includes('•••••'));
  assert.ok(rows.join('\n').includes('Esc cancel'));
});

test('empty state gives paste guidance; validation stays inside the bordered modal', () => {
  const rows = renderPrivatePanel({ width: 72, title: 'Sudo password', message: 'Local machine', length: 0, error: 'Invalid input: try again.' }, api);
  const text = rows.join('\n');
  assert.ok(text.includes('Type or paste your secret'));
  assert.ok(text.includes('Invalid input: try again.'));
});
