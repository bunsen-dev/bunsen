// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import {
  parseSchemaMeta,
  SchemaMetaError,
  tryParseSchemaMeta,
} from './schema-meta.js';

describe('parseSchemaMeta', () => {
  it('accepts a minimal v1 resource', () => {
    expect(parseSchemaMeta({ version: 'v1' })).toEqual({ version: 'v1' });
  });

  it('preserves the $schema URL when present', () => {
    const meta = parseSchemaMeta({
      $schema: 'https://schemas.bunsen.dev/experiment.v1.json',
      version: 'v1',
    });
    expect(meta).toEqual({
      $schema: 'https://schemas.bunsen.dev/experiment.v1.json',
      version: 'v1',
    });
  });

  it('ignores extra fields (parser handles the rest of the resource)', () => {
    const meta = parseSchemaMeta({
      version: 'v1',
      name: 'markdown-editor',
      extra: { anything: true },
    });
    expect(meta).toEqual({ version: 'v1' });
  });

  it('rejects missing version', () => {
    expect(() => parseSchemaMeta({})).toThrow(SchemaMetaError);
    expect(() => parseSchemaMeta({ name: 'x' })).toThrow(/Missing required "version"/);
  });

  it('rejects non-string version', () => {
    expect(() => parseSchemaMeta({ version: 1 })).toThrow(/must be a string/);
  });

  it('rejects unsupported version values', () => {
    expect(() => parseSchemaMeta({ version: 'v2' })).toThrow(/Unsupported schema version/);
    expect(() => parseSchemaMeta({ version: '1.0.0' })).toThrow(/Unsupported schema version/);
  });

  it('rejects non-object roots', () => {
    expect(() => parseSchemaMeta(null)).toThrow(SchemaMetaError);
    expect(() => parseSchemaMeta('version: v1')).toThrow(SchemaMetaError);
    expect(() => parseSchemaMeta([{ version: 'v1' }])).toThrow(SchemaMetaError);
  });

  it('rejects non-string $schema', () => {
    expect(() => parseSchemaMeta({ $schema: 42, version: 'v1' })).toThrow(
      /"\$schema" must be a string/,
    );
  });

  it('includes the resource name in error messages', () => {
    expect(() =>
      parseSchemaMeta({}, { resource: 'experiment.yaml' }),
    ).toThrow(/^experiment\.yaml: /);
  });

  it('respects an explicit allowedVersions list', () => {
    // For now the only value is v1, but the API supports narrowing/widening.
    expect(() =>
      parseSchemaMeta({ version: 'v1' }, { allowedVersions: [] }),
    ).toThrow(/Unsupported schema version/);
  });
});

describe('tryParseSchemaMeta', () => {
  it('returns ok: true for valid input', () => {
    const result = tryParseSchemaMeta({ version: 'v1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.meta.version).toBe('v1');
  });

  it('returns ok: false with a SchemaMetaError for invalid input', () => {
    const result = tryParseSchemaMeta({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SchemaMetaError);
      expect(result.error.field).toBe('version');
    }
  });
});
