import { describe, expect, it } from 'vitest';

import { escapeHtml } from './html.js';

/**
 * The contract, pinned before anything else is allowed to rely on it. Both the
 * page renderers and the email renderer put untrusted values into HTML, and the
 * email renderer used to carry a second, weaker copy of this function.
 */
describe('escapeHtml', () => {
  it('escapes the five characters that can end a text node or an attribute', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so nothing is escaped twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('neutralises a value that tries to close a double-quoted attribute', () => {
    const hostile = '" onmouseover="alert(1)';
    // What matters is that no quote survives, so the value cannot end the
    // attribute and start a new one.
    expect(escapeHtml(hostile)).not.toMatch(/["']/);
    expect(`<a title="${escapeHtml(hostile)}">`).not.toMatch(/title="[^"]*"[^>]*onmouseover/);
  });

  it('neutralises a value that tries to close a single-quoted attribute', () => {
    const hostile = "' onfocus='alert(1)";
    expect(escapeHtml(hostile)).not.toMatch(/["']/);
    expect(`<a title='${escapeHtml(hostile)}'>`).not.toMatch(/title='[^']*'[^>]*onfocus/);
  });

  it('neutralises a value that tries to open a tag', () => {
    const hostile = '<script>alert(1)</script>';
    expect(escapeHtml(hostile)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('fusion energy — 2026')).toBe('fusion energy — 2026');
  });
});
