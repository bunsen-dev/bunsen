import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScorerModelRefError } from '@bunsen-dev/types';
import { createModel, parseModelRef, resolveApiKey } from './model.js';

// Each provider factory is mocked so we can assert exactly what `createModel`
// hands it: the explicit API key (never a provider SDK's own env var) and the
// headers that carry trace attribution.
const providers = vi.hoisted(() => {
  const make = (tag: string) => {
    const provider = vi.fn((modelId: string) => ({ tag, modelId }));
    const factory = vi.fn(() => provider);
    return { provider, factory };
  };
  return { anthropic: make('anthropic'), openai: make('openai'), google: make('google') };
});

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: providers.anthropic.factory }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: providers.openai.factory }));
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: providers.google.factory }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseModelRef', () => {
  it('splits a <provider>/<model> reference, keeping the full ref', () => {
    expect(parseModelRef('anthropic/claude-sonnet-5-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      ref: 'anthropic/claude-sonnet-5-5',
    });
    // Model ids may themselves contain slashes (e.g. a vendored path form).
    expect(parseModelRef('google/models/gemini-3.1-pro-preview')).toEqual({
      provider: 'google',
      modelId: 'models/gemini-3.1-pro-preview',
      ref: 'google/models/gemini-3.1-pro-preview',
    });
    expect(parseModelRef('openai/gpt-5.6').provider).toBe('openai');
  });

  it('rejects a bare model id — there is no default provider', () => {
    expect(() => parseModelRef('claude-sonnet-5-5')).toThrow(ScorerModelRefError);
    expect(() => parseModelRef('claude-sonnet-5-5')).toThrow(
      'must be "<provider>/<model>", e.g. anthropic/claude-sonnet-5-5; got "claude-sonnet-5-5"',
    );
  });

  it('rejects an unknown provider, naming the ones that exist', () => {
    expect(() => parseModelRef('bedrock/claude-sonnet-5-5')).toThrow(
      /has unknown provider "bedrock"; expected one of anthropic, openai, google/,
    );
  });

  it('rejects a missing model id', () => {
    expect(() => parseModelRef('anthropic/')).toThrow(/is missing the model id after "anthropic\/"/);
  });
});

describe('resolveApiKey', () => {
  it('reads the provider-specific BUNSEN_ variable the host sets on the exec', () => {
    const env = {
      BUNSEN_ANTHROPIC_API_KEY: 'sk-ant',
      BUNSEN_OPENAI_API_KEY: 'sk-oai',
      BUNSEN_GEMINI_API_KEY: 'sk-gem',
    };
    expect(resolveApiKey('anthropic', env)).toBe('sk-ant');
    expect(resolveApiKey('openai', env)).toBe('sk-oai');
    expect(resolveApiKey('google', env)).toBe('sk-gem');
  });

  it('ignores the plain provider vars — only the BUNSEN_ form is delivered to a scorer', () => {
    expect(() => resolveApiKey('openai', { OPENAI_API_KEY: 'sk-oai' })).toThrow(
      /BUNSEN_OPENAI_API_KEY is not set/,
    );
  });

  it('throws naming the missing variable, per provider', () => {
    expect(() => resolveApiKey('anthropic', {})).toThrow(/BUNSEN_ANTHROPIC_API_KEY is not set/);
    expect(() => resolveApiKey('google', {})).toThrow(/BUNSEN_GEMINI_API_KEY is not set/);
    // An empty value is as missing as an absent one.
    expect(() => resolveApiKey('google', { BUNSEN_GEMINI_API_KEY: '' })).toThrow(
      /BUNSEN_GEMINI_API_KEY is not set/,
    );
  });
});

describe('createModel', () => {
  it('builds an Anthropic model with the explicit key', () => {
    const model = createModel('anthropic/claude-sonnet-5-5', { apiKey: 'sk-ant' });
    expect(providers.anthropic.factory).toHaveBeenCalledWith({ apiKey: 'sk-ant', headers: undefined });
    expect(providers.anthropic.provider).toHaveBeenCalledWith('claude-sonnet-5-5');
    expect(model).toEqual({ tag: 'anthropic', modelId: 'claude-sonnet-5-5' });
    expect(providers.openai.factory).not.toHaveBeenCalled();
    expect(providers.google.factory).not.toHaveBeenCalled();
  });

  it('builds an OpenAI model with the explicit key', () => {
    const model = createModel('openai/gpt-5.6', { apiKey: 'sk-oai' });
    expect(providers.openai.factory).toHaveBeenCalledWith({ apiKey: 'sk-oai', headers: undefined });
    expect(providers.openai.provider).toHaveBeenCalledWith('gpt-5.6');
    expect(model).toEqual({ tag: 'openai', modelId: 'gpt-5.6' });
  });

  it('builds a Google model with the explicit key (never GOOGLE_GENERATIVE_AI_API_KEY)', () => {
    const model = createModel('google/gemini-3.1-pro-preview', { apiKey: 'sk-gem' });
    expect(providers.google.factory).toHaveBeenCalledWith({ apiKey: 'sk-gem', headers: undefined });
    expect(providers.google.provider).toHaveBeenCalledWith('gemini-3.1-pro-preview');
    expect(model).toEqual({ tag: 'google', modelId: 'gemini-3.1-pro-preview' });
  });

  it('passes trace-attribution headers through to every provider', () => {
    const headers = { 'X-Bunsen-Source': 'scorer:x' };
    createModel('anthropic/claude-sonnet-5-5', { apiKey: 'sk-ant', headers });
    createModel('openai/gpt-5.6', { apiKey: 'sk-oai', headers });
    createModel('google/gemini-3.1-pro-preview', { apiKey: 'sk-gem', headers });
    expect(providers.anthropic.factory).toHaveBeenCalledWith({ apiKey: 'sk-ant', headers });
    expect(providers.openai.factory).toHaveBeenCalledWith({ apiKey: 'sk-oai', headers });
    expect(providers.google.factory).toHaveBeenCalledWith({ apiKey: 'sk-gem', headers });
  });

  it('accepts an already-parsed reference', () => {
    createModel(parseModelRef('anthropic/claude-opus-5-5'), { apiKey: 'sk-ant' });
    expect(providers.anthropic.provider).toHaveBeenCalledWith('claude-opus-5-5');
  });

  it('throws on a bare model id rather than guessing a provider', () => {
    expect(() => createModel('claude-sonnet-5-5', { apiKey: 'sk-ant' })).toThrow(ScorerModelRefError);
    expect(providers.anthropic.factory).not.toHaveBeenCalled();
  });
});
