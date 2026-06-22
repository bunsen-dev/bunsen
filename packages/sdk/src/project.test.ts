// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'vitest';
import { openProject, NotImplementedError } from './project.js';

describe('openProject (scaffold)', () => {
  it('returns a project rooted at the given cwd', async () => {
    const project = await openProject('/tmp/example');
    expect(project.root).toBe('/tmp/example');
  });

  it('throws NotImplementedError for unimplemented operations', async () => {
    const project = await openProject('/tmp/example');
    await expect(project.validate()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(project.run({ experiment: 'x', agent: 'y' })).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('rejects remote runs with a specific message', async () => {
    const project = await openProject('/tmp/example');
    await expect(
      project.run({ experiment: 'x', agent: 'y', remote: true }),
    ).rejects.toThrow(/remote: true/);
  });
});
