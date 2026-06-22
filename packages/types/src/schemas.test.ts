// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __clearSchemaCache,
  listSchemaIds,
  loadSchema,
  schemaUrl,
  type SchemaId,
} from './schemas.js';

describe('schema loader', () => {
  beforeEach(() => {
    __clearSchemaCache();
  });

  it('lists every bundled schema id', () => {
    const ids = listSchemaIds();
    expect(ids).toEqual([
      'project.v1',
      'suite.v1',
      'experiment.v1',
      'agent.v1',
    ]);
  });

  it('loads each bundled schema from disk', () => {
    for (const id of listSchemaIds()) {
      const schema = loadSchema(id);
      expect(schema).toBeTypeOf('object');
      // Every bundled stub has a $id matching the canonical URL.
      expect(schema.$id).toBe(schemaUrl(id));
      // And declares version: v1 as a constant.
      const properties = schema.properties as Record<string, unknown>;
      expect(properties).toBeDefined();
      const versionSchema = properties.version as Record<string, unknown>;
      expect(versionSchema.const).toBe('v1');
    }
  });

  it('caches loaded schemas (same reference on repeat calls)', () => {
    const first = loadSchema('experiment.v1');
    const second = loadSchema('experiment.v1');
    expect(second).toBe(first);
  });

  it('exposes the canonical $schema URL for every id', () => {
    expect(schemaUrl('project.v1')).toBe('https://schemas.bunsen.dev/project.v1.json');
    expect(schemaUrl('suite.v1')).toBe('https://schemas.bunsen.dev/suite.v1.json');
    expect(schemaUrl('experiment.v1')).toBe('https://schemas.bunsen.dev/experiment.v1.json');
    expect(schemaUrl('agent.v1')).toBe('https://schemas.bunsen.dev/agent.v1.json');
  });

  it('does not require a network fetch (offline validation works)', () => {
    // Loading the schema must succeed without any fetch/network calls. The
    // loader is a thin wrapper around readFileSync, so this is true by
    // construction — but keeping the assertion here makes the requirement
    // explicit and catches accidental regressions if someone rewrites the
    // loader later.
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (() => {
      throw new Error('network should not be touched');
    }) as typeof fetch;
    try {
      for (const id of listSchemaIds()) {
        expect(() => loadSchema(id)).not.toThrow();
      }
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
    }
  });

  it('throws a descriptive error for an unknown id', () => {
    expect(() => loadSchema('nope.v1' as SchemaId)).toThrow(/Failed to read bundled schema/);
  });
});
