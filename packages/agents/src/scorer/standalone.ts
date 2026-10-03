#!/usr/bin/env node
/**
 * Entry point for the scorer bundle (`node /bunsen/lib/scorer.cjs --config <path>`).
 *
 * Thin on purpose: read the config the runtime wrote, build the model for its
 * `<provider>/<model>`, run the scorer, print one JSON line
 * ({@link ScorerOutput}) on stdout, exit 0. Anything that goes wrong is a
 * message on stderr and exit 1 — the host turns that into `status: 'error'`
 * for the criterion.
 *
 * The provider key comes from this process's environment
 * (`BUNSEN_ANTHROPIC_API_KEY` / `BUNSEN_OPENAI_API_KEY` / `BUNSEN_GEMINI_API_KEY`),
 * set by the host for this exec and this criterion's provider only. Trace
 * attribution comes from `BUNSEN_TRACE_SOURCE` (`scorer:<criterion id>`), which
 * the host also sets; the runner never hardcodes the header.
 */

import type { ScorerOutput } from '@bunsen-dev/types';
import { createModel, parseModelRef } from '../common/index.js';
import { ScorerConfigError, loadScorerConfig, readScorerApiKey } from './config.js';
import { ScorerError, runScorer } from './runner.js';

// The runner surfaces `result.warnings` through its own stderr lines; the SDK's
// console warnings would interleave with the criterion log for no added signal.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

function parseArgs(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) return argv[i + 1];
  }
  throw new ScorerConfigError('Usage: scorer --config <path-to-config.json>');
}

async function main(): Promise<ScorerOutput> {
  const config = loadScorerConfig(parseArgs(process.argv.slice(2)));
  const ref = parseModelRef(config.model);
  const traceSource = process.env.BUNSEN_TRACE_SOURCE;
  // The key arrives as a one-time file (never an env var — see
  // readScorerApiKey); from here on only the provider closure holds it.
  const model = createModel(ref, {
    apiKey: readScorerApiKey(),
    headers: traceSource ? { 'X-Bunsen-Source': traceSource } : undefined,
  });
  return runScorer(config, { model });
}

main().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  },
  (error: unknown) => {
    console.error(`Scoring failed: ${error instanceof Error ? error.message : String(error)}`);
    // Expected failures (a bad config, no verdict) are fully described by their
    // message; anything else is a crash whose stack belongs in the criterion log.
    const expected = error instanceof ScorerConfigError || error instanceof ScorerError;
    if (!expected && error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  },
);
