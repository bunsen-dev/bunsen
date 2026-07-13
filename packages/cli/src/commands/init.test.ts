// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { describe, it, expect } from 'bun:test';
import {
  parseExperimentConfig,
  parseAgentConfig,
  buildArgvInvocation,
  STABLE_PATHS,
  RUN_PATHS,
  type ResolvedAgent,
  type ResolvedExperiment,
} from '@bunsen-dev/runtime';
import { EXAMPLE_EXPERIMENT_YAML, EXAMPLE_AGENT_YAML } from './init.js';

// Guards the canonical first-run flow (`bn init --example` -> `bn run
// hello-world echo-agent`). These are contract-level assertions against the
// real loaders and the real invocation composer, so a divergence between what
// the scaffold promises and what the runtime does breaks here instead of on a
// new user's first `bn run` (the hero example once shipped broken because only
// mocked paths were tested).
describe('bn init --example scaffold', () => {
  const experiment = parseExperimentConfig(EXAMPLE_EXPERIMENT_YAML, {
    source: 'experiment.yaml',
  });
  const agent = parseAgentConfig(EXAMPLE_AGENT_YAML);

  it('experiment and agent parse against the v1 loaders', () => {
    expect(experiment.version).toBe('v1');
    expect(experiment.name).toBe('hello-world');
    expect(agent.version).toBe('v1');
    expect(agent.name).toBe('echo-agent');
  });

  it('invocation composes to `echo <prompt>` — prompt-first, no shell wrapper', () => {
    const invocation = buildArgvInvocation(
      agent as unknown as ResolvedAgent,
      { task: { prompt: experiment.task.prompt } } as ResolvedExperiment,
      [],
    );
    expect(invocation).toEqual({
      command: 'echo',
      args: [experiment.task.prompt],
    });
  });

  it('scorer greps the run-context logs path where agent stdout actually lands', () => {
    const criterion = experiment.evaluation.criteria[0]!;
    expect(criterion.type).toBe('script');
    if (criterion.type !== 'script') throw new Error('unreachable');
    // The path is derived from the same constants the executor (saveLogs ->
    // RUN_PATHS.logs in the run dir) and the scorer container (run dir mounted
    // at STABLE_PATHS.runDir) use, so the scaffold can't drift from the runtime.
    const agentLogsPath = `${STABLE_PATHS.runDir}/${RUN_PATHS.logs}`;
    expect(criterion.run.trim()).toBe(`grep -F 'hello, world' ${agentLogsPath}`);
  });

  it('echoing the prompt satisfies the scorer (needle is a substring of the prompt)', () => {
    // The echo-agent prints the prompt verbatim; the scorer passes only
    // because the grep needle appears inside the prompt text itself.
    expect(experiment.task.prompt).toContain('hello, world');
  });
});
