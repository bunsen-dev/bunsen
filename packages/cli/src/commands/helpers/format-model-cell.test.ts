// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { formatModelCell } from './format-model-cell.js';

describe('formatModelCell', () => {
  it('returns "-" when no model is known', () => {
    expect(formatModelCell(undefined)).toBe('-');
    expect(formatModelCell(undefined, 0)).toBe('-');
  });

  it('returns the bare model for a single-model run', () => {
    expect(formatModelCell('claude-sonnet-4-6', 1)).toBe('claude-sonnet-4-6');
    expect(formatModelCell('gpt-5.5')).toBe('gpt-5.5');
  });

  it('appends "+N" for the additional models beyond the primary', () => {
    expect(formatModelCell('claude-opus-4-7', 2)).toBe('claude-opus-4-7 +1');
    expect(formatModelCell('claude-opus-4-7', 4)).toBe('claude-opus-4-7 +3');
  });
});
