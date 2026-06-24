// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

// bun:test's `vi.mock` patches in place (no hoisting), so a plain object works
// where vitest needed `vi.hoisted`.
const coreMocks = {
  loadRunManifest: vi.fn(),
  getWorkspaceTarPath: vi.fn(),
  loadWorkspaceDiff: vi.fn(),
};

vi.mock('@bunsen-dev/runtime', () => coreMocks);

import { exportCommand } from './export.js';

const TAR_BLOCK_SIZE = 512;

let tmpDir: string;
let exitSpy: Mock<typeof process.exit>;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-export-test-'));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  coreMocks.loadRunManifest.mockReturnValue({
    experiment: { path: path.join(tmpDir, 'experiment') },
  });
  coreMocks.loadWorkspaceDiff.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('exportCommand tar extraction', () => {
  it('extracts a safe workspace tarball', async () => {
    const tarPath = path.join(tmpDir, 'workspace.tar.gz');
    const outputDir = path.join(tmpDir, 'out');
    fs.writeFileSync(tarPath, makeTarGz([{ name: 'src/app.txt', body: 'hello\n' }]));
    coreMocks.getWorkspaceTarPath.mockReturnValue(tarPath);

    await exportCommand('RUN1', { output: outputDir });

    expect(fs.readFileSync(path.join(outputDir, 'src/app.txt'), 'utf8')).toBe('hello\n');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects tar members with parent-directory traversal', async () => {
    const tarPath = path.join(tmpDir, 'workspace.tar.gz');
    const outputDir = path.join(tmpDir, 'out');
    fs.writeFileSync(tarPath, makeTarGz([{ name: '../escape.txt', body: 'nope\n' }]));
    coreMocks.getWorkspaceTarPath.mockReturnValue(tarPath);

    await exportCommand('RUN1', { output: outputDir });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(path.join(tmpDir, 'escape.txt'))).toBe(false);
  });

  it('rejects symlinks that point outside the output directory', async () => {
    const tarPath = path.join(tmpDir, 'workspace.tar.gz');
    const outputDir = path.join(tmpDir, 'out');
    fs.writeFileSync(tarPath, makeTarGz([
      { name: 'src/link', body: '', type: '2', linkPath: '../../escape.txt' },
    ]));
    coreMocks.getWorkspaceTarPath.mockReturnValue(tarPath);

    await exportCommand('RUN1', { output: outputDir });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fs.existsSync(path.join(outputDir, 'src', 'link'))).toBe(false);
  });
});

interface TarEntry {
  name: string;
  body: string;
  type?: string;
  linkPath?: string;
}

function makeTarGz(entries: TarEntry[]): Buffer {
  return gzipSync(Buffer.concat([
    ...entries.flatMap(entry => [tarHeader(entry), tarBody(entry.body)]),
    Buffer.alloc(TAR_BLOCK_SIZE * 2),
  ]));
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const body = Buffer.from(entry.body);
  writeString(header, entry.name, 0, 100);
  writeString(header, '0000644', 100, 8);
  writeString(header, '0000000', 108, 8);
  writeString(header, '0000000', 116, 8);
  writeOctal(header, entry.type === '2' ? 0 : body.length, 124, 12);
  writeString(header, '00000000000', 136, 12);
  header.fill(0x20, 148, 156);
  writeString(header, entry.type ?? '0', 156, 1);
  if (entry.linkPath) {
    writeString(header, entry.linkPath, 157, 100);
  }
  writeString(header, 'ustar', 257, 6);
  writeString(header, '00', 263, 2);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeString(header, checksum.toString(8).padStart(6, '0'), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarBody(body: string): Buffer {
  const content = Buffer.from(body);
  const paddedLength = Math.ceil(content.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const padded = Buffer.alloc(paddedLength);
  content.copy(padded);
  return padded;
}

function writeString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8');
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  writeString(buffer, value.toString(8).padStart(length - 1, '0'), offset, length - 1);
}
