// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseGitignore,
  FALLBACK_EXCLUSIONS,
  buildGitignoreFilter,
  buildGitignoreFilterFromContents,
  listNonIgnoredFiles,
  collectAllExclusionPatterns,
} from './gitignore.js';

describe('parseGitignore', () => {
  it('parses simple patterns', () => {
    const content = `
node_modules
dist
build
`;
    expect(parseGitignore(content)).toEqual(['node_modules', 'dist', 'build']);
  });

  it('skips comments', () => {
    const content = `
# Dependencies
node_modules
# Build output
dist
`;
    expect(parseGitignore(content)).toEqual(['node_modules', 'dist']);
  });

  it('skips empty lines', () => {
    const content = `
node_modules

dist

build
`;
    expect(parseGitignore(content)).toEqual(['node_modules', 'dist', 'build']);
  });

  it('skips negation patterns', () => {
    const content = `
*.log
!important.log
dist
`;
    expect(parseGitignore(content)).toEqual(['*.log', 'dist']);
  });

  it('removes trailing slashes', () => {
    const content = `
node_modules/
dist/
build///
`;
    expect(parseGitignore(content)).toEqual(['node_modules', 'dist', 'build']);
  });

  it('preserves glob patterns', () => {
    const content = `
*.log
**/*.tmp
src/**/*.test.js
`;
    expect(parseGitignore(content)).toEqual(['*.log', '**/*.tmp', 'src/**/*.test.js']);
  });

  it('handles inline comments (keeps them - gitignore does not support inline comments)', () => {
    // Note: .gitignore does NOT support inline comments, so "dist # comment" is a valid pattern
    const content = `node_modules # this is not a comment in gitignore`;
    expect(parseGitignore(content)).toEqual(['node_modules # this is not a comment in gitignore']);
  });

  it('handles empty content', () => {
    expect(parseGitignore('')).toEqual([]);
  });

  it('handles whitespace-only lines', () => {
    const content = `
node_modules

dist
\t\t
build
`;
    expect(parseGitignore(content)).toEqual(['node_modules', 'dist', 'build']);
  });
});

describe('buildGitignoreFilter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bunsen-gitignore-filter-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates filter from root .gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\n*.log\n');

    const filter = await buildGitignoreFilter(tempDir);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('node_modules/foo')).toBe(true);
    expect(filter.ignores('app.log')).toBe(true);
    expect(filter.ignores('src/index.js')).toBe(false);
  });

  it('always ignores .git', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'dist\n');

    const filter = await buildGitignoreFilter(tempDir);

    expect(filter.ignores('.git')).toBe(true);
    expect(filter.ignores('.git/config')).toBe(true);
  });

  it('uses fallback when no .gitignore exists', async () => {
    const filter = await buildGitignoreFilter(tempDir);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('dist')).toBe(true);
    expect(filter.ignores('__pycache__')).toBe(true);
    expect(filter.ignores('src/index.js')).toBe(false);
  });

  it('handles nested .gitignore files', async () => {
    // Create directory structure
    await fs.mkdir(path.join(tempDir, 'packages', 'foo'), { recursive: true });

    // Root .gitignore
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\n');

    // Nested .gitignore
    await fs.writeFile(
      path.join(tempDir, 'packages', 'foo', '.gitignore'),
      'dist\n*.tmp\n'
    );

    const filter = await buildGitignoreFilter(tempDir);

    // Root patterns apply everywhere
    expect(filter.ignores('node_modules')).toBe(true);

    // Nested patterns apply with correct path prefix
    expect(filter.ignores('packages/foo/dist')).toBe(true);
    expect(filter.ignores('packages/foo/test.tmp')).toBe(true);

    // Nested patterns should not apply to root
    expect(filter.ignores('dist')).toBe(false);
  });

  it('handles negation patterns', async () => {
    await fs.writeFile(
      path.join(tempDir, '.gitignore'),
      '*.log\n!important.log\n'
    );

    const filter = await buildGitignoreFilter(tempDir);

    expect(filter.ignores('debug.log')).toBe(true);
    expect(filter.ignores('important.log')).toBe(false);
  });

  it('filters array of paths', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\n*.log\n');

    const filter = await buildGitignoreFilter(tempDir);
    const paths = ['src/index.js', 'node_modules/foo', 'app.log', 'README.md'];
    const filtered = filter.filter(paths);

    expect(filtered).toEqual(['src/index.js', 'README.md']);
  });
});

describe('listNonIgnoredFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bunsen-gitignore-list-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists all files when no .gitignore', async () => {
    // Create files (but avoid files that would match fallback exclusions)
    await fs.writeFile(path.join(tempDir, 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'README.md'), 'content');
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.writeFile(path.join(tempDir, 'src', 'app.js'), 'content');

    const files = await listNonIgnoredFiles(tempDir);

    expect(files).toContain('index.js');
    expect(files).toContain('README.md');
    expect(files).toContain(path.join('src', 'app.js'));
  });

  it('excludes files matching .gitignore patterns', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), '*.log\nsecrets/\n');
    await fs.writeFile(path.join(tempDir, 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'debug.log'), 'content');
    await fs.mkdir(path.join(tempDir, 'secrets'));
    await fs.writeFile(path.join(tempDir, 'secrets', 'key.txt'), 'content');

    const files = await listNonIgnoredFiles(tempDir);

    expect(files).toContain('index.js');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('debug.log');
    expect(files).not.toContain(path.join('secrets', 'key.txt'));
  });

  it('handles nested directories correctly', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'dist/\n');
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.mkdir(path.join(tempDir, 'dist'));
    await fs.writeFile(path.join(tempDir, 'src', 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'dist', 'bundle.js'), 'content');

    const files = await listNonIgnoredFiles(tempDir);

    expect(files).toContain(path.join('src', 'index.js'));
    expect(files).not.toContain(path.join('dist', 'bundle.js'));
  });

  it('respects nested .gitignore files', async () => {
    await fs.mkdir(path.join(tempDir, 'packages', 'foo'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules/\n');
    await fs.writeFile(path.join(tempDir, 'packages', 'foo', '.gitignore'), '*.tmp\n');

    await fs.writeFile(path.join(tempDir, 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'packages', 'foo', 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'packages', 'foo', 'test.tmp'), 'content');

    const files = await listNonIgnoredFiles(tempDir);

    expect(files).toContain('index.js');
    expect(files).toContain(path.join('packages', 'foo', 'index.js'));
    expect(files).not.toContain(path.join('packages', 'foo', 'test.tmp'));
  });

  it('uses provided filter if given', async () => {
    await fs.writeFile(path.join(tempDir, 'index.js'), 'content');
    await fs.writeFile(path.join(tempDir, 'test.log'), 'content');

    // Create a custom filter
    const customFilter = await buildGitignoreFilter(tempDir);
    customFilter.ig.add('*.log');

    const files = await listNonIgnoredFiles(tempDir, customFilter);

    expect(files).toContain('index.js');
    expect(files).not.toContain('test.log');
  });
});

describe('collectAllExclusionPatterns', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bunsen-gitignore-collect-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('collects patterns from root .gitignore', async () => {
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\ndist\n');

    const result = await collectAllExclusionPatterns(tempDir);

    expect(result.source).toBe('gitignore');
    expect(result.patterns).toContain('.git');
    expect(result.patterns).toContain('node_modules');
    expect(result.patterns).toContain('dist');
  });

  it('collects patterns from nested .gitignore files', async () => {
    await fs.mkdir(path.join(tempDir, 'packages', 'foo'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\n');
    await fs.writeFile(path.join(tempDir, 'packages', 'foo', '.gitignore'), 'dist\n*.tmp\n');

    const result = await collectAllExclusionPatterns(tempDir);

    expect(result.source).toBe('gitignore');
    expect(result.patterns).toContain('.git');
    expect(result.patterns).toContain('node_modules');
    expect(result.patterns).toContain('dist');
    expect(result.patterns).toContain('*.tmp');
  });

  it('deduplicates patterns', async () => {
    await fs.mkdir(path.join(tempDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.gitignore'), 'node_modules\ndist\n');
    await fs.writeFile(path.join(tempDir, 'sub', '.gitignore'), 'dist\n*.log\n');

    const result = await collectAllExclusionPatterns(tempDir);

    // dist should only appear once
    const distCount = result.patterns.filter(p => p === 'dist').length;
    expect(distCount).toBe(1);
  });

  it('uses fallback when no .gitignore exists', async () => {
    const result = await collectAllExclusionPatterns(tempDir);

    expect(result.source).toBe('fallback');
    expect(result.patterns).toContain('.git');
    expect(result.patterns).toContain('node_modules');
    expect(result.patterns).toContain('dist');
  });
});

describe('FALLBACK_EXCLUSIONS', () => {
  it('contains essential exclusions', () => {
    expect(FALLBACK_EXCLUSIONS).toContain('node_modules');
    expect(FALLBACK_EXCLUSIONS).toContain('dist');
    expect(FALLBACK_EXCLUSIONS).toContain('build');
    expect(FALLBACK_EXCLUSIONS).toContain('__pycache__');
    expect(FALLBACK_EXCLUSIONS).toContain('.venv');
    expect(FALLBACK_EXCLUSIONS).toContain('.next');
  });

  it('does not contain .git (added separately)', () => {
    expect(FALLBACK_EXCLUSIONS).not.toContain('.git');
  });
});

describe('buildGitignoreFilterFromContents', () => {
  it('creates filter from root gitignore content', () => {
    const contents = [
      { content: 'node_modules\n*.log\n', relativeDir: '.' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('node_modules/foo')).toBe(true);
    expect(filter.ignores('app.log')).toBe(true);
    expect(filter.ignores('src/index.js')).toBe(false);
  });

  it('always ignores .git', () => {
    const contents = [
      { content: 'dist\n', relativeDir: '.' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('.git')).toBe(true);
    expect(filter.ignores('.git/config')).toBe(true);
  });

  it('uses fallback when no contents provided', () => {
    const filter = buildGitignoreFilterFromContents([]);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('dist')).toBe(true);
    expect(filter.ignores('__pycache__')).toBe(true);
    expect(filter.ignores('src/index.js')).toBe(false);
  });

  it('does not use fallback when useFallback is false', () => {
    const filter = buildGitignoreFilterFromContents([], false);

    // Only .git should be ignored
    expect(filter.ignores('.git')).toBe(true);
    expect(filter.ignores('node_modules')).toBe(false);
    expect(filter.ignores('dist')).toBe(false);
  });

  it('handles nested gitignore files with path adjustment', () => {
    const contents = [
      { content: 'node_modules\n', relativeDir: '.' },
      { content: 'dist\n*.tmp\n', relativeDir: 'packages/foo' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    // Root patterns apply everywhere
    expect(filter.ignores('node_modules')).toBe(true);

    // Nested patterns apply with correct path prefix
    expect(filter.ignores('packages/foo/dist')).toBe(true);
    expect(filter.ignores('packages/foo/test.tmp')).toBe(true);

    // Nested patterns should not apply to root
    expect(filter.ignores('dist')).toBe(false);
  });

  it('handles negation patterns', () => {
    const contents = [
      { content: '*.log\n!important.log\n', relativeDir: '.' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('debug.log')).toBe(true);
    expect(filter.ignores('important.log')).toBe(false);
  });

  it('handles negation patterns in nested gitignore', () => {
    const contents = [
      { content: '*.log\n!important.log\n', relativeDir: 'packages/app' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('packages/app/debug.log')).toBe(true);
    expect(filter.ignores('packages/app/important.log')).toBe(false);
    // Root should not be affected
    expect(filter.ignores('debug.log')).toBe(false);
  });

  it('filters array of paths', () => {
    const contents = [
      { content: 'node_modules\n*.log\n', relativeDir: '.' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);
    const paths = ['src/index.js', 'node_modules/foo', 'app.log', 'README.md'];
    const filtered = filter.filter(paths);

    expect(filtered).toEqual(['src/index.js', 'README.md']);
  });

  it('handles comments and blank lines', () => {
    const contents = [
      { content: '# Comment\nnode_modules\n\n# Another comment\ndist\n', relativeDir: '.' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('dist')).toBe(true);
  });

  it('handles multiple nested gitignore files', () => {
    const contents = [
      { content: 'node_modules\n', relativeDir: '.' },
      { content: 'build\n', relativeDir: 'packages/core' },
      { content: 'dist\n', relativeDir: 'packages/cli' },
    ];

    const filter = buildGitignoreFilterFromContents(contents);

    expect(filter.ignores('node_modules')).toBe(true);
    expect(filter.ignores('packages/core/build')).toBe(true);
    expect(filter.ignores('packages/cli/dist')).toBe(true);
    // Cross-package patterns don't apply
    expect(filter.ignores('packages/core/dist')).toBe(false);
    expect(filter.ignores('packages/cli/build')).toBe(false);
  });
});
