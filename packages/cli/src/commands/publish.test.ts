// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import { publishRunCommand, publishReportCommand } from './publish.js';
import { BunsenCliError } from '../errors.js';
import { EXIT_CODES } from '../exit-codes.js';

describe('publishRunCommand', () => {
  it('throws a structured `not_implemented` error for the reserved publishing surface', () => {
    let caught: BunsenCliError | undefined;
    try {
      publishRunCommand('run-abc', { visibility: 'public' });
    } catch (err) {
      caught = err as BunsenCliError;
    }
    expect(caught).toBeInstanceOf(BunsenCliError);
    expect(caught!.code).toBe('not_implemented');
    expect(caught!.exitCode).toBe(EXIT_CODES.GENERIC);
    expect(caught!.message).toMatch(/not yet implemented/i);
    expect(caught!.message).toMatch(/future release/i);
    expect(caught!.details).toEqual({
      runId: 'run-abc',
      visibility: 'public',
      feature: 'publishing',
    });
  });

  it('omits visibility from details when not provided', () => {
    let caught: BunsenCliError | undefined;
    try {
      publishRunCommand('run-xyz', {});
    } catch (err) {
      caught = err as BunsenCliError;
    }
    expect(caught!.details).toEqual({
      runId: 'run-xyz',
      feature: 'publishing',
    });
  });
});

describe('publishReportCommand', () => {
  it('throws a structured `not_implemented` error for the reserved publishing surface', () => {
    let caught: BunsenCliError | undefined;
    try {
      publishReportCommand('reports/2026-04-29.md');
    } catch (err) {
      caught = err as BunsenCliError;
    }
    expect(caught).toBeInstanceOf(BunsenCliError);
    expect(caught!.code).toBe('not_implemented');
    expect(caught!.exitCode).toBe(EXIT_CODES.GENERIC);
    expect(caught!.message).toMatch(/not yet implemented/i);
    expect(caught!.details).toEqual({
      reportPath: 'reports/2026-04-29.md',
      feature: 'publishing',
    });
  });
});
