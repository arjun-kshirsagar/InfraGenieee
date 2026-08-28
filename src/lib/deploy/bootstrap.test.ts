import { describe, expect, it } from 'vitest';

import { shouldRestoreLastAnalysis } from './bootstrap';

describe('shouldRestoreLastAnalysis', () => {
  it('restores on a plain /deploy visit', () => {
    expect(shouldRestoreLastAnalysis(null)).toBe(true);
  });

  it('does not hide the input behind stale results for /deploy?prd=<id>', () => {
    expect(shouldRestoreLastAnalysis('prd_abc123def456')).toBe(false);
  });
});
