import { describe, it, expect, vi } from 'bun:test';
import type { CheckResult } from './doctor.js';

// The `@bunsen-dev/runtime` barrel drags in Docker/git/project machinery that a
// unit test has no business touching, so it is stubbed here — but the two
// pieces `checkPlatformKeys` is actually about (the host key resolver and the
// default scorer model) are the REAL implementations, loaded straight from the
// runtime's build output. Resolving them by runtime URL rather than a static
// relative import keeps the CLI's `rootDir: ./src` typecheck happy.
const runtimeDist = (file: string) => import(new URL(`../../../runtime/dist/${file}`, import.meta.url).href);

const platformKeys = await runtimeDist('platform-keys.js');
const { DEFAULT_SCORER_MODEL } = await runtimeDist('evaluation-coordinator.js');

vi.mock('@bunsen-dev/runtime', () => ({
  PROVIDER_LABELS: platformKeys.PROVIDER_LABELS,
  PLATFORM_KEY_SOURCES: platformKeys.PLATFORM_KEY_SOURCES,
  platformKeyHint: platformKeys.platformKeyHint,
  resolvePlatformKeys: platformKeys.resolvePlatformKeys,
  DEFAULT_SCORER_MODEL,
  // Unused by the checks under test; present so the module graph resolves.
  isDockerAvailable: async () => false,
  getDockerInfo: async () => ({}),
  isGitAvailable: () => false,
  imageExists: async () => false,
  loadProject: () => ({ root: '/tmp', storage: { root: '/tmp' } }),
  ProjectConfigError: class ProjectConfigError extends Error {},
  MITMPROXY_IMAGE: 'mitmproxy:test',
}));

const { checkPlatformKeys, rollUpStatus } = await import('./doctor.js');

function byId(rows: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

describe('checkPlatformKeys', () => {
  it('reports one row per provider, in a stable order', () => {
    const rows = checkPlatformKeys({});
    expect(rows.map((r) => r.id)).toEqual([
      'api_key_anthropic',
      'api_key_openai',
      'api_key_google',
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      'Anthropic API key',
      'OpenAI API key',
      'Google (Gemini) API key',
    ]);
  });

  it('with no keys set: Anthropic warns, the optional providers stay ok', () => {
    const rows = checkPlatformKeys({});
    const m = byId(rows);

    expect(m.api_key_anthropic.status).toBe('warn');
    expect(m.api_key_anthropic.detail).toBe('not set');
    expect(m.api_key_anthropic.hint).toContain('anthropic/claude-opus-5-5');
    expect(m.api_key_anthropic.hint).toContain('bn agents infer-invoke');
    expect(m.api_key_anthropic.hint).toContain(
      'set ANTHROPIC_API_KEY or BUNSEN_ANTHROPIC_API_KEY',
    );
    expect(m.api_key_anthropic.data).toEqual({ provider: 'anthropic', source: null });

    expect(m.api_key_openai.status).toBe('ok');
    expect(m.api_key_openai.detail).toBe('not set (only needed for openai/… scorer models)');
    expect(m.api_key_openai.hint).toContain('OPENAI_API_KEY');

    expect(m.api_key_google.status).toBe('ok');
    expect(m.api_key_google.detail).toBe('not set (only needed for google/… scorer models)');
    expect(m.api_key_google.hint).toContain('GEMINI_API_KEY');

    // Only the Anthropic row contributes; a missing optional provider must not
    // degrade the report.
    expect(rollUpStatus(rows)).toBe('warn');
  });

  it('with only the Anthropic key set: every row is ok', () => {
    const rows = checkPlatformKeys({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const m = byId(rows);

    expect(m.api_key_anthropic.status).toBe('ok');
    expect(m.api_key_anthropic.detail).toBe('present via ANTHROPIC_API_KEY');
    expect(m.api_key_anthropic.data).toEqual({
      provider: 'anthropic',
      source: 'ANTHROPIC_API_KEY',
    });
    expect(m.api_key_anthropic.hint).toBeUndefined();

    expect(m.api_key_openai.status).toBe('ok');
    expect(m.api_key_google.status).toBe('ok');
    expect(rollUpStatus(rows)).toBe('ok');
  });

  it('with all three keys set: every row names the var that satisfied it', () => {
    const rows = checkPlatformKeys({
      BUNSEN_ANTHROPIC_API_KEY: 'sk-ant-platform',
      ANTHROPIC_API_KEY: 'sk-ant-agent',
      OPENAI_API_KEY: 'sk-openai',
      GOOGLE_API_KEY: 'goog',
    });
    const m = byId(rows);

    expect(rows.every((r) => r.status === 'ok')).toBe(true);
    expect(rollUpStatus(rows)).toBe('ok');

    // BUNSEN_-prefixed wins over the plain var.
    expect(m.api_key_anthropic.detail).toBe('present via BUNSEN_ANTHROPIC_API_KEY');
    expect(m.api_key_anthropic.data).toEqual({
      provider: 'anthropic',
      source: 'BUNSEN_ANTHROPIC_API_KEY',
    });
    expect(m.api_key_openai.detail).toBe('present via OPENAI_API_KEY');
    // GOOGLE_API_KEY is the last fallback for the google provider.
    expect(m.api_key_google.detail).toBe('present via GOOGLE_API_KEY');
  });

  it('ignores empty-string keys', () => {
    const m = byId(checkPlatformKeys({ OPENAI_API_KEY: '', BUNSEN_OPENAI_API_KEY: 'sk-real' }));
    expect(m.api_key_openai.detail).toBe('present via BUNSEN_OPENAI_API_KEY');
  });

  it('never emits a `fail` row — a missing key is never fatal', () => {
    expect(checkPlatformKeys({}).some((r) => r.status === 'fail')).toBe(false);
  });
});

describe('rollUpStatus', () => {
  const row = (status: CheckResult['status']): CheckResult => ({ id: status, label: status, status });

  it('takes the worst status', () => {
    expect(rollUpStatus([row('ok'), row('ok')])).toBe('ok');
    expect(rollUpStatus([row('ok'), row('warn')])).toBe('warn');
    expect(rollUpStatus([row('warn'), row('fail')])).toBe('fail');
    expect(rollUpStatus([])).toBe('ok');
  });
});
