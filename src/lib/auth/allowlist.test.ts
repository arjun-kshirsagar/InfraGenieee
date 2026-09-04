import { afterEach, describe, expect, it } from 'vitest';

import { allowedEmails, isAllowedEmail } from '@/lib/auth/allowlist';

const previous = process.env.ALLOWED_EMAILS;

afterEach(() => {
  if (previous === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = previous;
});

describe('auth allowlist', () => {
  it('matches built-in emails case-insensitively', () => {
    delete process.env.ALLOWED_EMAILS;

    expect(isAllowedEmail('Icpcani@gmail.com')).toBe(true);
    expect(isAllowedEmail('icpcani@gmail.com')).toBe(true);
  });

  it('normalizes configured comma-separated emails', () => {
    process.env.ALLOWED_EMAILS = ' One@Example.com, two@example.com ';

    expect(allowedEmails()).toEqual(['one@example.com', 'two@example.com']);
    expect(isAllowedEmail('one@example.com')).toBe(true);
  });
});
