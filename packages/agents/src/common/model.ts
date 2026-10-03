/**
 * Provider-agnostic model layer for the platform's own model calls (the
 * scorer bundle and the host-side `bn agents infer-invoke` scaffolder).
 *
 * One `LanguageModel` factory over the Vercel AI SDK providers. The model is
 * named by a `<provider>/<model>` string (parsed by `@bunsen-dev/types`); the
 * API key is always passed explicitly — never read from a provider SDK's own
 * default env var (Google's is `GOOGLE_GENERATIVE_AI_API_KEY`, which Bunsen
 * does not use).
 *
 * No custom `fetch`: inside a container the proxy dispatcher is installed via
 * `NODE_OPTIONS=--require=/bunsen/runtime/proxy-bootstrap.cjs` (see
 * `getProxyEnv` in `@bunsen-dev/runtime`), which routes the SDK's fetch through
 * mitmproxy with the pinned CA. On the host the scaffolder talks to the
 * provider directly.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { parseScorerModelRef, type ScorerModelRef, type ScorerProvider } from '@bunsen-dev/types';

export { parseScorerModelRef as parseModelRef, type ScorerModelRef, type ScorerProvider };

export interface CreateModelOptions {
  /** The provider's API key. Required — there is no env-var fallback here. */
  apiKey: string;
  /** Extra headers on every request, e.g. `X-Bunsen-Source` for trace attribution. */
  headers?: Record<string, string>;
}

/**
 * Build a `LanguageModel` for a `<provider>/<model>` reference.
 *
 * Throws (via {@link parseModelRef}) on a malformed reference. The runtime
 * validates `scorer.model` before a config ever reaches the bundle; this is
 * the bundle's own guard.
 */
export function createModel(ref: string | ScorerModelRef, options: CreateModelOptions): LanguageModel {
  const parsed = typeof ref === 'string' ? parseScorerModelRef(ref) : ref;
  const { apiKey, headers } = options;
  switch (parsed.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, headers })(parsed.modelId);
    case 'openai':
      // The default OpenAI language model uses the Responses API (non-streaming
      // under generateText) — the path the trace proxy parses as `/v1/responses`.
      return createOpenAI({ apiKey, headers })(parsed.modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey, headers })(parsed.modelId);
  }
}
