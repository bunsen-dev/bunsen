// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, expect, it } from 'vitest';

describe('orchestrator standalone prompt design', () => {
  it('teaches the argv contract and forces a single submit_orchestration tool call', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./standalone.ts', import.meta.url), 'utf-8');

    // Argv-first guidance must be present so the model knows not to shell-quote.
    expect(source).toContain('## Argv Contract');
    expect(source).toContain('DO NOT wrap the task prompt in quotes');
    expect(source).toContain('DO NOT escape backticks');

    // Filesystem-exploration guard rails are unchanged.
    expect(source).toContain('Do not ask to inspect the filesystem');
    expect(source).toContain('## Executor-Applied Context');
    expect(source).toContain('Resolved variant env var names');

    // Single forced-tool path: runOnce + tool_choice on submit_orchestration.
    expect(source).toContain('runOnce');
    expect(source).toContain("toolChoice: { type: 'tool', name: 'submit_orchestration' }");
    expect(source).not.toContain('runTools');

    // No legacy or filesystem-tool affordances.
    expect(source).not.toContain("name: 'list_files'");
    expect(source).not.toContain("name: 'read_file'");
    expect(source).not.toContain('## /input Directory Listing');
    expect(source).not.toContain('Runtime roots you may inspect');
    expect(source).not.toContain('Config Path:');
    expect(source).not.toContain('formatAvailableRoots');
    expect(source).not.toContain('sanitizeAgentConfigForOrchestrator');
  });
});
