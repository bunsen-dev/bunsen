/**
 * Host-side resolution of the platform's provider API keys — the keys the
 * platform's own model calls (LLM scorers, the report step, the supervisor,
 * the `infer-invoke` scaffolder) authenticate with. Kept distinct from the
 * keys passed to the agent under test via `defaults.passEnv`.
 *
 * One function resolves every provider from the host env with a fixed
 * fallback order (first match wins). The resolved key is delivered to a
 * scorer exec as a one-time key file (`runLLMScorer`), only for that
 * criterion's provider — never in any environment, so `type: script` criteria,
 * scorer subprocesses, and `/proc` never see it.
 */

import { SCORER_PROVIDERS, type ScorerProvider } from '@bunsen-dev/types';
import type { ScorerProviderRequirement } from './evaluation-coordinator.js';

/**
 * Host env vars consulted per provider, in priority order. The `BUNSEN_`
 * form lets you give the platform a different key than the agent under test
 * receives through `passEnv`.
 */
export const PLATFORM_KEY_SOURCES: Readonly<Record<ScorerProvider, readonly string[]>> = Object.freeze({
  anthropic: ['BUNSEN_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai: ['BUNSEN_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  google: ['BUNSEN_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
});

/** Human-readable provider names for messages. */
export const PROVIDER_LABELS: Readonly<Record<ScorerProvider, string>> = Object.freeze({
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
});

export interface ResolvedPlatformKey {
  provider: ScorerProvider;
  value: string;
  /** The host env var that satisfied the lookup. */
  source: string;
}

export type PlatformKeys = Partial<Record<ScorerProvider, ResolvedPlatformKey>>;

/** Resolve every provider's platform key from `env` (first matching var wins; empty values ignored). */
export function resolvePlatformKeys(env: Record<string, string | undefined> = process.env): PlatformKeys {
  const out: PlatformKeys = {};
  for (const provider of SCORER_PROVIDERS) {
    for (const name of PLATFORM_KEY_SOURCES[provider]) {
      const value = env[name];
      if (value) {
        out[provider] = { provider, value, source: name };
        break;
      }
    }
  }
  return out;
}

/** `set OPENAI_API_KEY or BUNSEN_OPENAI_API_KEY` — the fix, for error messages. */
export function platformKeyHint(provider: ScorerProvider): string {
  const sources = PLATFORM_KEY_SOURCES[provider];
  // Lead with the plain provider vars (what most users already have), in
  // resolution order, then the BUNSEN_ override form.
  const names = [
    ...sources.filter((name) => !name.startsWith('BUNSEN_')),
    ...sources.filter((name) => name.startsWith('BUNSEN_')),
  ];
  return `set ${names.join(' or ')}`;
}

/**
 * The resolved key a scorer exec for `provider` receives. Throws if the key is
 * not resolved — the preflight is expected to have caught that before any
 * container work. The value travels as a one-time file, never an env var
 * (`runLLMScorer`).
 */
export function scorerKeyFor(provider: ScorerProvider, keys: PlatformKeys): ResolvedPlatformKey {
  const key = keys[provider];
  if (!key) {
    throw new Error(
      `No ${PROVIDER_LABELS[provider]} API key is available for the scorer (${platformKeyHint(provider)}).`,
    );
  }
  return key;
}

/** `an Anthropic` / `an OpenAI` / `a Google (Gemini)`. */
function article(label: string): string {
  return /^[AEIOU]/i.test(label) ? 'an' : 'a';
}

/** One line naming a criterion (or the report) that needs a provider's key. */
function requirementLine(req: ScorerProviderRequirement): string {
  if (req.type === 'report') return `  report (model: ${req.model})`;
  return `  criterion '${req.id}' (type: ${req.type}, weight: ${req.weight}, model: ${req.model})`;
}

/**
 * The preflight failure for an evaluation whose scorers need provider keys the
 * host env does not supply. One block per missing provider (in
 * {@link SCORER_PROVIDERS} order), naming the env vars that fix it and every
 * criterion behind the requirement — a rubric with one stray `openai/…` judge
 * should not send the user hunting for which criterion asked for it.
 */
export function buildMissingScorerKeysError(
  missing: Map<ScorerProvider, ScorerProviderRequirement[]>,
): Error {
  const blocks: string[] = [];
  for (const provider of SCORER_PROVIDERS) {
    const requirements = missing.get(provider);
    if (!requirements || requirements.length === 0) continue;
    const label = PROVIDER_LABELS[provider];
    const header = `Evaluation needs ${article(label)} ${label} API key (${platformKeyHint(provider)}):`;
    blocks.push([header, ...requirements.map(requirementLine)].join('\n'));
  }
  return new Error(blocks.join('\n\n'));
}
