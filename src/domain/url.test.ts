import { describe, expect, it } from 'vitest';

import { isSafeExternalUrl, safeExternalUrl } from './url.js';

describe('safeExternalUrl', () => {
  it('keeps an ordinary https link', () => {
    expect(safeExternalUrl('https://www.reuters.com/world/a-story')).toBe(
      'https://www.reuters.com/world/a-story',
    );
  });

  it('keeps an ordinary http link', () => {
    expect(isSafeExternalUrl('http://example.com/story')).toBe(true);
  });

  it('refuses a javascript: URL, which runs on click without leaving the page', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('JavaScript:alert(1)')).toBeNull();
    expect(safeExternalUrl('  javascript:alert(1)  ')).toBeNull();
  });

  it('refuses the other schemes that execute or embed', () => {
    for (const raw of [
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/abc',
    ]) {
      expect(safeExternalUrl(raw), raw).toBeNull();
    }
  });

  it('refuses a protocol-relative URL, which inherits whatever the page is served over', () => {
    expect(safeExternalUrl('//evil.example/story')).toBeNull();
  });

  it('refuses a value that is not a URL at all', () => {
    for (const raw of ['', '   ', 'not a url', '/world/a-story', 'www.example.com']) {
      expect(safeExternalUrl(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('refuses a link whose scheme is hidden behind markup that a renderer would escape', () => {
    // Escaping turns this into an inert href; the point is that it is refused
    // rather than stored and left for each renderer to get right.
    expect(safeExternalUrl('javascript:alert(1)" onmouseover="alert(2)')).toBeNull();
  });
});
