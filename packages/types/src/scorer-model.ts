/**
 * Scorer model references — the `<provider>/<model>` form used by
 * `scorer.model` (judge, agent, browser-agent) and `evaluation.report.model`.
 *
 * One string rather than a `provider:` + `model:` pair: it is the same shape
 * the trace format already shows (`provider/model` in `list_threads`) and the
 * shape the pricing table keys on. The runtime validates experiment configs
 * with {@link parseScorerModelRef}; the bundled scorer re-parses the resolved
 * value as its own guard. Bare model ids are rejected — there is no default
 * provider.
 */

/** Providers an LLM-backed scorer can run on. */
export type ScorerProvider = 'anthropic' | 'openai' | 'google';

export const SCORER_PROVIDERS: readonly ScorerProvider[] = ['anthropic', 'openai', 'google'];

/**
 * Source-of-truth regex for `scorer.model` / `report.model`. Mirrored as the
 * `pattern` on those fields in `schemas/experiment.v1.json`.
 */
export const SCORER_MODEL_PATTERN = '^(anthropic|openai|google)/.+$';

/** Shown in every "wrong shape" error so the fix is one copy-paste away. */
export const SCORER_MODEL_EXAMPLE = 'anthropic/claude-sonnet-4-6';

export interface ScorerModelRef {
  provider: ScorerProvider;
  /** The provider's own model id, e.g. `claude-sonnet-4-6` or `gpt-5.5`. */
  modelId: string;
  /** The full `<provider>/<model>` string as written. */
  ref: string;
}

export function isScorerProvider(value: string): value is ScorerProvider {
  return (SCORER_PROVIDERS as readonly string[]).includes(value);
}

/** Thrown by {@link parseScorerModelRef}; `message` is phrased to follow a field name. */
export class ScorerModelRefError extends Error {
  readonly ref: string;
  constructor(message: string, ref: string) {
    super(message);
    this.name = 'ScorerModelRefError';
    this.ref = ref;
  }
}

/**
 * Parse a `<provider>/<model>` reference.
 *
 * Throws {@link ScorerModelRefError} with a message that states the required
 * form and shows the fix, e.g. for a bare id:
 * `must be "<provider>/<model>", e.g. anthropic/claude-sonnet-4-6; got "claude-sonnet-4-6"`.
 */
export function parseScorerModelRef(ref: string): ScorerModelRef {
  const slash = ref.indexOf('/');
  if (slash <= 0) {
    throw new ScorerModelRefError(
      `must be "<provider>/<model>", e.g. ${SCORER_MODEL_EXAMPLE}; got ${JSON.stringify(ref)}`,
      ref,
    );
  }
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  if (!isScorerProvider(provider)) {
    throw new ScorerModelRefError(
      `has unknown provider ${JSON.stringify(provider)}; expected one of ${SCORER_PROVIDERS.join(', ')} ` +
        `(e.g. ${SCORER_MODEL_EXAMPLE}); got ${JSON.stringify(ref)}`,
      ref,
    );
  }
  if (modelId.length === 0) {
    throw new ScorerModelRefError(
      `is missing the model id after "${provider}/", e.g. ${SCORER_MODEL_EXAMPLE}; got ${JSON.stringify(ref)}`,
      ref,
    );
  }
  return { provider, modelId, ref };
}

/**
 * The environment variable each provider's API key is delivered to the scorer
 * process under. The host resolves the key from its own env (with fallbacks,
 * see `resolvePlatformKeys` in `@bunsen-dev/runtime`) and sets exactly this
 * variable on the criterion's exec — never in a container's base env.
 *
 * @internal
 */
export const SCORER_PROVIDER_KEY_ENV: Readonly<Record<ScorerProvider, string>> = Object.freeze({
  anthropic: 'BUNSEN_ANTHROPIC_API_KEY',
  openai: 'BUNSEN_OPENAI_API_KEY',
  google: 'BUNSEN_GEMINI_API_KEY',
});
