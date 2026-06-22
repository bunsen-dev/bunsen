// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import {
  InvalidDurationError,
  parseDuration,
  parseOptionalDuration,
} from './duration.js';

describe('parseDuration', () => {
  it('parses milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('0ms')).toBe(0);
    expect(parseDuration('1ms')).toBe(1);
  });

  it('parses seconds', () => {
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('300s')).toBe(300_000);
    expect(parseDuration('0s')).toBe(0);
  });

  it('parses minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('15m')).toBe(900_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('parses fractional values', () => {
    expect(parseDuration('1.5s')).toBe(1_500);
    expect(parseDuration('0.25m')).toBe(15_000);
    expect(parseDuration('0.5h')).toBe(1_800_000);
  });

  it('tolerates leading/trailing whitespace', () => {
    expect(parseDuration('  5m  ')).toBe(300_000);
  });

  it('rejects bare integers', () => {
    expect(() => parseDuration('300')).toThrow(InvalidDurationError);
    expect(() => parseDuration('0')).toThrow(InvalidDurationError);
  });

  it('rejects unknown units', () => {
    expect(() => parseDuration('5d')).toThrow(InvalidDurationError);
    expect(() => parseDuration('1w')).toThrow(InvalidDurationError);
    expect(() => parseDuration('5minutes')).toThrow(InvalidDurationError);
  });

  it('rejects negative values', () => {
    expect(() => parseDuration('-5m')).toThrow(InvalidDurationError);
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(() => parseDuration('')).toThrow(InvalidDurationError);
    expect(() => parseDuration('   ')).toThrow(InvalidDurationError);
  });

  it('rejects malformed input', () => {
    expect(() => parseDuration('5 m')).toThrow(InvalidDurationError);
    expect(() => parseDuration('m5')).toThrow(InvalidDurationError);
    expect(() => parseDuration('5m5s')).toThrow(InvalidDurationError);
    expect(() => parseDuration('.5s')).toThrow(InvalidDurationError);
  });

  it('rejects non-string inputs', () => {
    // @ts-expect-error — intentional misuse
    expect(() => parseDuration(300)).toThrow(InvalidDurationError);
    // @ts-expect-error — intentional misuse
    expect(() => parseDuration(null)).toThrow(InvalidDurationError);
    // @ts-expect-error — intentional misuse
    expect(() => parseDuration(undefined)).toThrow(InvalidDurationError);
  });

  it('attaches the offending input to the error', () => {
    try {
      parseDuration('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDurationError);
      expect((err as InvalidDurationError).input).toBe('nope');
    }
  });
});

describe('parseOptionalDuration', () => {
  it('returns undefined for null/undefined', () => {
    expect(parseOptionalDuration(null)).toBeUndefined();
    expect(parseOptionalDuration(undefined)).toBeUndefined();
  });

  it('delegates to parseDuration otherwise', () => {
    expect(parseOptionalDuration('5m')).toBe(300_000);
  });

  it('throws on invalid input', () => {
    expect(() => parseOptionalDuration('bogus')).toThrow(InvalidDurationError);
  });
});
