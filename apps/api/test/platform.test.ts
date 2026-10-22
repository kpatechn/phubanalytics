import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/platform.js';

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(['1.2.0', '1.10.0', '1.9.2', '1.0.5'].sort(compareVersions)).toEqual(['1.0.5', '1.2.0', '1.9.2', '1.10.0']);
  });
  it('treats missing parts as zero and unknown as lowest', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('unknown', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('1.2.3', 'unknown')).toBeGreaterThan(0);
  });
});
