// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import { resolveFormat, isMachineFormat, renderMachine, FormatFlagError } from './format.js';

describe('resolveFormat', () => {
  it('defaults to text when nothing is set', () => {
    expect(resolveFormat({})).toBe('text');
  });

  it('honors --format', () => {
    expect(resolveFormat({ format: 'json' })).toBe('json');
    expect(resolveFormat({ format: 'yaml' })).toBe('yaml');
    expect(resolveFormat({ format: 'text' })).toBe('text');
  });

  it('throws FormatFlagError on bad value', () => {
    expect(() => resolveFormat({ format: 'xml' })).toThrow(FormatFlagError);
  });
});

describe('isMachineFormat', () => {
  it('classifies json/yaml as machine', () => {
    expect(isMachineFormat('json')).toBe(true);
    expect(isMachineFormat('yaml')).toBe(true);
  });
  it('classifies text as not machine', () => {
    expect(isMachineFormat('text')).toBe(false);
  });
});

describe('renderMachine', () => {
  it('renders JSON with trailing newline', () => {
    const out = renderMachine({ a: 1 }, 'json');
    expect(out).toBe('{\n  "a": 1\n}\n');
  });

  it('renders YAML', () => {
    const out = renderMachine({ a: 1 }, 'yaml');
    expect(out).toBe('a: 1\n');
  });

  it('rejects text format', () => {
    expect(() => renderMachine({}, 'text')).toThrow();
  });
});
