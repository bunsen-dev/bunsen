// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, vi } from 'vitest';
import { BunsenCliError, toCliError, reportError } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';

describe('BunsenCliError', () => {
  it('passes through code, exit code, and details', () => {
    const err = new BunsenCliError('test_code', 'oh no', {
      exitCode: EXIT_CODES.VALIDATION,
      details: { path: '/foo' },
    });
    expect(err.code).toBe('test_code');
    expect(err.exitCode).toBe(EXIT_CODES.VALIDATION);
    expect(err.toPayload()).toMatchObject({
      code: 'test_code',
      message: 'oh no',
      details: { path: '/foo' },
    });
  });
});

describe('toCliError', () => {
  it('returns the same instance for BunsenCliError', () => {
    const err = new BunsenCliError('code', 'msg');
    expect(toCliError(err)).toBe(err);
  });

  it('wraps generic errors as internal_error', () => {
    const wrapped = toCliError(new Error('boom'));
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.exitCode).toBe(EXIT_CODES.GENERIC);
  });
});

describe('reportError', () => {
  it('writes JSON payload to stdout under --format json', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = new BunsenCliError('test_code', 'oh no', {
      exitCode: EXIT_CODES.VALIDATION,
    });
    reportError(err, 'json');
    expect(stdoutSpy).toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(out)).toEqual({
      error: { code: 'test_code', message: 'oh no' },
    });
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.VALIDATION);
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('writes to stderr under text format', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = new BunsenCliError('not_found', 'missing thing');
    reportError(err, 'text');
    expect(stderrSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.GENERIC);
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
