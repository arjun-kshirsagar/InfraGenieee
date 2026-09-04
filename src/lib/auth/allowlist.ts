/**
 * InfraGenie — access allowlist.
 *
 * Only these emails may sign in and use the app. Configure via the
 * ALLOWED_EMAILS environment variable (comma-separated). If unset, falls back
 * to the built-in default so the app is never accidentally left wide open.
 *
 * To add people: set ALLOWED_EMAILS in Vercel → Settings → Environment
 * Variables, e.g. "a@x.com, b@y.com, c@z.com". No redeploy of code needed —
 * just redeploy to pick up the new env value.
 */

const DEFAULT_ALLOWED = ['visheshpaliwal777@gmail.com',
  'arjunk.dev2025@gmail.com',
  'kshirsagararjun20@gmail.com',
  'Icpcani@gmail.com',
  'vibhuttv@gmail.com'
];

export function allowedEmails(): string[] {
  const raw = process.env.ALLOWED_EMAILS;
  if (!raw) return DEFAULT_ALLOWED;
  const list = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED;
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}
