// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Golden agent-invocation assertions.
 *
 * The agent invocation is now a pure function of committed config
 * (`buildArgvInvocation` — no model in the path), so we pin the exact
 * invocation each shipped example agent produces. This is the regression net:
 * if a future edit to an example `agent.yaml` (or to the composer) silently
 * changes how an agent is invoked, one of these goldens breaks loudly.
 *
 * Each golden includes the guaranteed args (`entrypoint.args`) appended after
 * composition, exactly as the executor appends them for a base (un-varianted)
 * agent.
 */
import { describe, it, expect } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgvInvocation, formatInvocationForLog, type ArgvInvocation } from './orchestration.js';
import { loadAgent } from './agent-loader.js';
import type { ResolvedExperiment } from './experiment-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_AGENTS = path.resolve(HERE, '../../../examples/agents');

const PROMPT = 'Fix the bug in the authentication module';

function makeExperiment(prompt: string): ResolvedExperiment {
  return { task: { prompt } } as ResolvedExperiment;
}

/**
 * Compose the full invocation for a shipped example agent, mirroring the
 * executor: `buildArgvInvocation` then append the base agent's guaranteed args
 * (`entrypoint.args`).
 */
function composeGolden(agentName: string): ArgvInvocation {
  const agent = loadAgent(path.join(EXAMPLE_AGENTS, agentName));
  const inv = buildArgvInvocation(agent, makeExperiment(PROMPT), []);
  return { command: inv.command, args: [...inv.args, ...(agent.entrypoint.args ?? [])] };
}

describe('golden invocations (example agents)', () => {
  it('codex-cli: codex exec <prompt> --sandbox …', () => {
    expect(composeGolden('codex-cli')).toEqual({
      command: 'codex',
      args: [
        'exec',
        PROMPT,
        '--sandbox',
        'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
      ],
    });
  });

  it('gemini-cli: gemini -p <prompt> --yolo --skip-trust', () => {
    expect(composeGolden('gemini-cli')).toEqual({
      command: 'gemini',
      args: ['-p', PROMPT, '--yolo', '--skip-trust'],
    });
  });

  it('claude-code: bare positional prompt, then guaranteed flags (PATH-resolved)', () => {
    expect(composeGolden('claude-code')).toEqual({
      command: 'claude',
      args: [
        PROMPT,
        '-p',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
        '--output-format',
        'text',
        '--verbose',
      ],
    });
  });

  it('echo-agent: interpreter split with relative script rewrite, offline', () => {
    expect(composeGolden('echo-agent')).toEqual({
      command: 'python',
      args: ['/agent/src/main.py', PROMPT],
    });
  });

  it('basic-coding-agent: interpreter split with absolute script', () => {
    expect(composeGolden('basic-coding-agent')).toEqual({
      command: 'python',
      args: ['/agent/main.py', PROMPT],
    });
  });

  it('claude-sdk-agent: node interpreter split with absolute script', () => {
    expect(composeGolden('claude-sdk-agent')).toEqual({
      command: 'node',
      args: ['/agent/dist/index.js', PROMPT],
    });
  });

  it('renders the codex/gemini goldens as readable command lines', () => {
    expect(formatInvocationForLog(composeGolden('codex-cli'))).toBe(
      `codex exec '${PROMPT}' --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`,
    );
    expect(formatInvocationForLog(composeGolden('gemini-cli'))).toBe(
      `gemini -p '${PROMPT}' --yolo --skip-trust`,
    );
  });
});
