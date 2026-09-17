import { describe, it, expect } from 'bun:test';
import {
  PLATFORM_KEY_SOURCES,
  PROVIDER_LABELS,
  resolvePlatformKeys,
  platformKeyHint,
  scorerExecKeyEnv,
  buildMissingScorerKeysError,
  type PlatformKeys,
} from './platform-keys.js';
import type { ScorerProvider } from '@bunsen-dev/types';
import type { ScorerProviderRequirement } from './evaluation-coordinator.js';

describe('resolvePlatformKeys', () => {
  it('resolves nothing from an empty env', () => {
    expect(resolvePlatformKeys({})).toEqual({});
  });

  it('prefers the BUNSEN_ form over the plain provider var', () => {
    const keys = resolvePlatformKeys({
      BUNSEN_ANTHROPIC_API_KEY: 'platform-key',
      ANTHROPIC_API_KEY: 'agent-key',
    });
    expect(keys.anthropic).toEqual({
      provider: 'anthropic',
      value: 'platform-key',
      source: 'BUNSEN_ANTHROPIC_API_KEY',
    });
  });

  it('falls back through the google chain in declared order', () => {
    expect(resolvePlatformKeys({ GOOGLE_API_KEY: 'g' }).google?.source).toBe('GOOGLE_API_KEY');
    expect(
      resolvePlatformKeys({ GEMINI_API_KEY: 'g1', GOOGLE_API_KEY: 'g2' }).google,
    ).toEqual({ provider: 'google', value: 'g1', source: 'GEMINI_API_KEY' });
    expect(
      resolvePlatformKeys({
        BUNSEN_GEMINI_API_KEY: 'g0',
        GEMINI_API_KEY: 'g1',
        GOOGLE_API_KEY: 'g2',
      }).google?.source,
    ).toBe('BUNSEN_GEMINI_API_KEY');
  });

  it('ignores an empty value and keeps looking', () => {
    const keys = resolvePlatformKeys({ BUNSEN_OPENAI_API_KEY: '', OPENAI_API_KEY: 'real' });
    expect(keys.openai).toEqual({
      provider: 'openai',
      value: 'real',
      source: 'OPENAI_API_KEY',
    });
  });

  it('leaves a provider unresolved when every source is empty', () => {
    expect(resolvePlatformKeys({ OPENAI_API_KEY: '', BUNSEN_OPENAI_API_KEY: '' }).openai)
      .toBeUndefined();
  });

  it('resolves all three providers independently', () => {
    const keys = resolvePlatformKeys({
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      GEMINI_API_KEY: 'g',
    });
    expect(Object.keys(keys).sort()).toEqual(['anthropic', 'google', 'openai']);
    expect(keys.anthropic?.value).toBe('a');
    expect(keys.openai?.value).toBe('o');
    expect(keys.google?.value).toBe('g');
  });

  it('never treats an unrelated env var as a key', () => {
    expect(resolvePlatformKeys({ ANTHROPIC_BASE_URL: 'https://x', MY_API_KEY: 'k' })).toEqual({});
  });
});

describe('platformKeyHint', () => {
  it('leads with the plain provider var, then the BUNSEN_ override', () => {
    expect(platformKeyHint('openai')).toBe('set OPENAI_API_KEY or BUNSEN_OPENAI_API_KEY');
    expect(platformKeyHint('anthropic')).toBe(
      'set ANTHROPIC_API_KEY or BUNSEN_ANTHROPIC_API_KEY',
    );
    expect(platformKeyHint('google')).toBe(
      'set GEMINI_API_KEY or GOOGLE_API_KEY or BUNSEN_GEMINI_API_KEY',
    );
  });

  it('names every source the resolver actually consults', () => {
    for (const provider of ['anthropic', 'openai', 'google'] as ScorerProvider[]) {
      const hint = platformKeyHint(provider);
      for (const source of PLATFORM_KEY_SOURCES[provider]) {
        expect(hint).toContain(source);
      }
    }
  });
});

describe('scorerExecKeyEnv', () => {
  const keys: PlatformKeys = {
    anthropic: { provider: 'anthropic', value: 'a-key', source: 'ANTHROPIC_API_KEY' },
    openai: { provider: 'openai', value: 'o-key', source: 'OPENAI_API_KEY' },
    google: { provider: 'google', value: 'g-key', source: 'GOOGLE_API_KEY' },
  };

  it('returns exactly one variable, under the name the bundle reads', () => {
    expect(scorerExecKeyEnv('anthropic', keys)).toEqual({ BUNSEN_ANTHROPIC_API_KEY: 'a-key' });
    expect(scorerExecKeyEnv('openai', keys)).toEqual({ BUNSEN_OPENAI_API_KEY: 'o-key' });
    // Google's platform var is BUNSEN_GEMINI_API_KEY, not BUNSEN_GOOGLE_API_KEY.
    expect(scorerExecKeyEnv('google', keys)).toEqual({ BUNSEN_GEMINI_API_KEY: 'g-key' });
  });

  it('never leaks a sibling provider key into the exec env', () => {
    const env = scorerExecKeyEnv('openai', keys);
    expect(Object.keys(env)).toHaveLength(1);
    expect(Object.values(env)).not.toContain('a-key');
    expect(Object.values(env)).not.toContain('g-key');
  });

  it('throws, naming the provider and the fix, when the key is unresolved', () => {
    expect(() => scorerExecKeyEnv('openai', { anthropic: keys.anthropic })).toThrow(
      /No OpenAI API key is available for the scorer \(set OPENAI_API_KEY or BUNSEN_OPENAI_API_KEY\)/,
    );
  });
});

describe('buildMissingScorerKeysError', () => {
  const req = (
    over: Partial<ScorerProviderRequirement> = {},
  ): ScorerProviderRequirement => ({
    id: 'cheat-check',
    type: 'agent',
    weight: 0,
    model: 'openai/gpt-5.5',
    ...over,
  });

  it('names the provider, the env vars, and every criterion behind it', () => {
    const err = buildMissingScorerKeysError(
      new Map([
        [
          'openai' as ScorerProvider,
          [req(), req({ id: 'report', type: 'report', weight: 0 })],
        ],
      ]),
    );
    expect(err.message).toBe(
      [
        'Evaluation needs an OpenAI API key (set OPENAI_API_KEY or BUNSEN_OPENAI_API_KEY):',
        "  criterion 'cheat-check' (type: agent, weight: 0, model: openai/gpt-5.5)",
        '  report (model: openai/gpt-5.5)',
      ].join('\n'),
    );
  });

  it('emits one block per missing provider, separated by a blank line', () => {
    const err = buildMissingScorerKeysError(
      new Map<ScorerProvider, ScorerProviderRequirement[]>([
        ['openai', [req()]],
        [
          'google',
          [req({ id: 'ui-check', type: 'browser-agent', weight: 2, model: 'google/gemini-2.5-pro' })],
        ],
      ]),
    );
    expect(err.message).toBe(
      [
        'Evaluation needs an OpenAI API key (set OPENAI_API_KEY or BUNSEN_OPENAI_API_KEY):',
        "  criterion 'cheat-check' (type: agent, weight: 0, model: openai/gpt-5.5)",
        '',
        'Evaluation needs a Google (Gemini) API key (set GEMINI_API_KEY or GOOGLE_API_KEY or BUNSEN_GEMINI_API_KEY):',
        "  criterion 'ui-check' (type: browser-agent, weight: 2, model: google/gemini-2.5-pro)",
      ].join('\n'),
    );
  });

  it('orders blocks by provider, not by map insertion order', () => {
    const err = buildMissingScorerKeysError(
      new Map<ScorerProvider, ScorerProviderRequirement[]>([
        ['google', [req({ model: 'google/gemini-2.5-pro' })]],
        ['anthropic', [req({ model: 'anthropic/claude-sonnet-4-6' })]],
      ]),
    );
    const lines = err.message.split('\n').filter((l) => l.startsWith('Evaluation needs'));
    expect(lines[0]).toContain(PROVIDER_LABELS.anthropic);
    expect(lines[1]).toContain(PROVIDER_LABELS.google);
  });

  it('uses the right article for each provider label', () => {
    const one = (provider: ScorerProvider, model: string) =>
      buildMissingScorerKeysError(
        new Map([[provider, [req({ model })]]]),
      ).message.split('\n')[0];
    expect(one('anthropic', 'anthropic/claude-sonnet-4-6')).toStartWith(
      'Evaluation needs an Anthropic API key',
    );
    expect(one('openai', 'openai/gpt-5.5')).toStartWith('Evaluation needs an OpenAI API key');
    expect(one('google', 'google/gemini-2.5-pro')).toStartWith(
      'Evaluation needs a Google (Gemini) API key',
    );
  });
});
