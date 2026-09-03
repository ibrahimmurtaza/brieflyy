import { describe, expect, it } from 'vitest';

import { renderWelcomeEmail } from './welcome-email.js';

describe('renderWelcomeEmail', () => {
  it('mentions the user, the time, and the timezone', () => {
    const { subject, text } = renderWelcomeEmail({
      firstBriefAt: new Date('2026-06-15T12:00:00Z'),
      timezone: 'America/New_York',
      hour: 8,
      minute: 0,
    });
    expect(subject).toBe('Welcome to Brieflyy');
    expect(text).toMatch(/Welcome to Brieflyy/);
    expect(text).toMatch(/Your first brief will arrive/);
    expect(text).toMatch(/08:00 \(America\/New_York\)/);
  });

  it('uses the user-supplied minute, padding single digits', () => {
    const { text } = renderWelcomeEmail({
      firstBriefAt: new Date('2026-06-15T12:00:00Z'),
      timezone: 'UTC',
      hour: 7,
      minute: 5,
    });
    expect(text).toMatch(/07:05 \(UTC\)/);
  });
});
