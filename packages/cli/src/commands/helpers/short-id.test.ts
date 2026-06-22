// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import { shortRunId } from './short-id.js';

describe('shortRunId', () => {
  it('returns the last 8 chars of a ULID', () => {
    const ulid = '01HZA5K3CT9X8WYP7Q2RM4F6BN';
    expect(shortRunId(ulid)).toBe(ulid.slice(-8));
  });

  it('falls back to the leading 8 chars for short ids', () => {
    expect(shortRunId('abc123')).toBe('abc123');
    expect(shortRunId('legacy0123456')).toBe('legacy01');
  });

  it('disambiguates near-simultaneous ULIDs', () => {
    // ULIDs with the same time prefix (first 10 chars) should still produce
    // distinct shortened forms thanks to the random suffix.
    const a = '01HZA5K3CT9X8WYP7Q2RM4F6BN';
    const b = '01HZA5K3CTQQQQQQQQQQQQQQQQ';
    expect(shortRunId(a)).not.toBe(shortRunId(b));
  });
});
