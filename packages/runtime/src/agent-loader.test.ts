// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Tests for the v1 agent.yaml loader (parser, variant merge, install.source
 * override semantics, sha256 warning, legacy-field errors).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
import {
  parseAgentConfig,
  applyAgentVariant,
  loadAgent,
  parseAgentVariantSyntax,
  getAgentVariants,
  resolveModelSelection,
  AgentConfigError,
  type AgentWarning,
} from './agent-loader.js';
import type { AgentConfig } from '@bunsen-dev/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseYaml(extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    $schema: 'https://schemas.bunsen.dev/agent.v1.json',
    version: 'v1',
    name: 'demo-agent',
    description: 'A demo agent',
    install: { source: { type: 'local' } },
    entrypoint: { command: 'python', args: ['main.py'] },
    interaction: { mode: 'direct' },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// parseAgentConfig — happy path
// ---------------------------------------------------------------------------

describe('parseAgentConfig', () => {
  it('parses a minimal v1 agent', () => {
    const config = parseAgentConfig(baseYaml());
    expect(config.version).toBe('v1');
    expect(config.name).toBe('demo-agent');
    expect(config.install.source).toEqual({ type: 'local' });
    expect(config.entrypoint.command).toBe('python');
    expect(config.entrypoint.args).toEqual(['main.py']);
    expect(config.interaction.mode).toBe('direct');
  });

  it('parses install.build and install.configure', () => {
    const config = parseAgentConfig(
      baseYaml({
        install: {
          source: { type: 'local' },
          build: {
            image: 'ubuntu:22.04',
            run: ['echo hi', 'echo bye'],
            timeout: '10m',
            network: 'none',
            cacheSalt: 'v1',
          },
          configure: [{ run: 'mkdir -p ~/.agent', as: 'root', timeout: '2m' }],
        },
      }),
    );
    expect(config.install.build).toEqual({
      image: 'ubuntu:22.04',
      run: ['echo hi', 'echo bye'],
      timeout: '10m',
      network: 'none',
      cacheSalt: 'v1',
    });
    expect(config.install.configure).toEqual([
      { run: 'mkdir -p ~/.agent', as: 'root', timeout: '2m' },
    ]);
  });

  it('parses every install.source variant', () => {
    for (const source of [
      { type: 'local' },
      { type: 'git', repo: 'https://example.com/repo.git', ref: 'main' },
      { type: 'npm', package: '@example/agent', version: '^1.0' },
      {
        type: 'binary',
        url: 'https://example.com/bin',
        sha256: 'a'.repeat(64),
      },
    ]) {
      const config = parseAgentConfig(baseYaml({ install: { source } }));
      expect(config.install.source).toEqual(source);
    }
  });

  it('requires install.source.type', () => {
    expect(() => parseAgentConfig(baseYaml({ install: { source: {} } }))).toThrow(
      /install.source.type is required/,
    );
  });

  it('rejects unknown install.source.type', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ install: { source: { type: 'docker' } } })),
    ).toThrow(/install.source.type must be one of/);
  });

  it('requires git.repo on git source', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ install: { source: { type: 'git' } } })),
    ).toThrow(/install.source.repo/);
  });

  it('requires npm.package on npm source', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ install: { source: { type: 'npm' } } })),
    ).toThrow(/install.source.package/);
  });

  it('requires binary.url on binary source', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ install: { source: { type: 'binary' } } })),
    ).toThrow(/install.source.url/);
  });

  it('warns when binary source omits sha256', () => {
    const warnings: AgentWarning[] = [];
    parseAgentConfig(
      baseYaml({
        install: {
          source: { type: 'binary', url: 'https://example.com/bin' },
        },
      }),
      { onWarning: (w) => warnings.push(w) },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('agent.install.source.binary.sha256.missing');
  });

  it('does not warn when binary source provides sha256', () => {
    const warnings: AgentWarning[] = [];
    parseAgentConfig(
      baseYaml({
        install: {
          source: {
            type: 'binary',
            url: 'https://example.com/bin',
            sha256: 'b'.repeat(64),
          },
        },
      }),
      { onWarning: (w) => warnings.push(w) },
    );
    expect(warnings).toHaveLength(0);
  });

  it('rejects sha256 that is not 64 hex chars', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          install: {
            source: {
              type: 'binary',
              url: 'https://example.com/bin',
              sha256: 'notahash',
            },
          },
        }),
      ),
    ).toThrow(/sha256 must be a 64-character hex string/);
  });

  it('parses examples with prompt/invocation', () => {
    const config = parseAgentConfig(
      baseYaml({
        examples: [
          { prompt: 'Fix the bug', invocation: 'python main.py "Fix the bug"' },
        ],
      }),
    );
    expect(config.examples).toEqual([
      { prompt: 'Fix the bug', invocation: 'python main.py "Fix the bug"' },
    ]);
  });

  it('parses defaults.env', () => {
    const config = parseAgentConfig(
      baseYaml({ defaults: { env: { FOO: 'bar', BAZ: 'qux' } } }),
    );
    expect(config.defaults?.env).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('parses defaults.passEnv', () => {
    const config = parseAgentConfig(
      baseYaml({ defaults: { passEnv: ['HOME', 'PATH'] } }),
    );
    expect(config.defaults?.passEnv).toEqual(['HOME', 'PATH']);
  });

  it('rejects defaults.env with a reserved BUNSEN_ key', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ defaults: { env: { BUNSEN_X: 'y' } } })),
    ).toThrow(/reserved/);
  });

  it('rejects defaults.passEnv with a reserved BUNSEN_ entry', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ defaults: { passEnv: ['BUNSEN_RUN_ID'] } })),
    ).toThrow(/reserved/);
  });

  it('rejects duplicate defaults.passEnv entries', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ defaults: { passEnv: ['HOME', 'HOME'] } })),
    ).toThrow(/duplicate/);
  });

  it('parses interaction.mode supervised', () => {
    const config = parseAgentConfig(baseYaml({ interaction: { mode: 'supervised' } }));
    expect(config.interaction.mode).toBe('supervised');
  });
});

// ---------------------------------------------------------------------------
// Legacy schema rejection — structured migration errors
// ---------------------------------------------------------------------------

describe('parseAgentConfig legacy schema rejection', () => {
  it('rejects top-level `command` with a migration hint', () => {
    const raw = `name: old\ncommand: python main.py\n`;
    expect(() => parseAgentConfig(raw)).toThrow(/entrypoint.command/);
  });

  it('rejects top-level `args` with a migration hint', () => {
    const raw = `name: old\nargs: ["--foo"]\n`;
    expect(() => parseAgentConfig(raw)).toThrow(/entrypoint.args/);
  });

  it('rejects top-level `supervisor` with a migration hint', () => {
    const raw = `name: old\nsupervisor: true\n`;
    expect(() => parseAgentConfig(raw)).toThrow(/interaction.mode/);
  });

  it('rejects top-level `source` with a migration hint', () => {
    const raw = `name: old\nsource:\n  type: local\n`;
    expect(() => parseAgentConfig(raw)).toThrow(/install.source/);
  });

  it('rejects top-level `help_command` with a migration hint', () => {
    const raw = `name: old\nhelp_command: ./bin --help\n`;
    expect(() => parseAgentConfig(raw)).toThrow(/entrypoint.help/);
  });

  it('rejects the legacy top-level `runtime:` block with a migration hint', () => {
    const raw = baseYaml({ runtime: { requires: { runtimes: { node: '>=18' } } } });
    expect(() => parseAgentConfig(raw)).toThrow(/agents are sealed closures/);
    expect(() => parseAgentConfig(raw)).toThrow(/install\.deps/);
  });

  it('rejects legacy variant-level `runtime:` block with a migration hint', () => {
    const raw = baseYaml({
      variants: { v: { runtime: { requires: { runtimes: { node: '>=18' } } } } },
    });
    expect(() => parseAgentConfig(raw)).toThrow(/agents are sealed closures/);
  });

  it('rejects install.build.script (renamed to run)', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            build: { image: 'ubuntu', script: 'echo hi' },
          },
        }),
      ),
    ).toThrow(/install.build.run/);
  });

  it('rejects install.build.container (renamed to image)', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            build: { container: 'ubuntu', run: ['echo hi'] },
          },
        }),
      ),
    ).toThrow(/install.build.image/);
  });

  it('rejects install.build.cache_salt (renamed to cacheSalt)', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            build: { image: 'ubuntu', run: ['echo hi'], cache_salt: 'v1' },
          },
        }),
      ),
    ).toThrow(/install.build.cacheSalt/);
  });

  it('rejects legacy `examples[].command`/`context`', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          examples: [{ command: 'python main.py', context: 'when given a task' }],
        }),
      ),
    ).toThrow(/invocation.*prompt/);
  });

  it('rejects legacy variant.args / variant.env / variant.ref / variant.supervisor', () => {
    const legacyCases: Array<[Record<string, unknown>, RegExp]> = [
      [{ variants: { v1: { args: ['--x'] } } }, /entrypoint\.args/],
      [{ variants: { v1: { env: { FOO: 'bar' } } } }, /defaults\.env/],
      [{ variants: { v1: { ref: 'main' } } }, /install\.source\.ref/],
      [{ variants: { v1: { supervisor: true } } }, /interaction\.mode/],
    ];
    for (const [legacy, matcher] of legacyCases) {
      expect(() => parseAgentConfig(baseYaml(legacy))).toThrow(matcher);
    }
  });
});

// ---------------------------------------------------------------------------
// Variant merge semantics
// ---------------------------------------------------------------------------

describe('applyAgentVariant', () => {
  it('merges entrypoint.args (array replace)', () => {
    const base = parseAgentConfig(
      baseYaml({
        variants: {
          fast: {
            entrypoint: { args: ['--fast'] },
          },
        },
      }),
    );
    const merged = applyAgentVariant(base, 'fast');
    expect(merged.entrypoint.args).toEqual(['--fast']);
    expect(merged.variants).toBeUndefined();
  });

  it('merges defaults.env key-by-key', () => {
    const base = parseAgentConfig(
      baseYaml({
        defaults: { env: { FOO: '1', SHARED: 'base' } },
        variants: {
          v: { defaults: { env: { BAR: '2', SHARED: 'overlay' } } },
        },
      }),
    );
    const merged = applyAgentVariant(base, 'v');
    expect(merged.defaults?.env).toEqual({ FOO: '1', BAR: '2', SHARED: 'overlay' });
  });

  it('overrides interaction.mode', () => {
    const base = parseAgentConfig(
      baseYaml({
        interaction: { mode: 'supervised' },
        variants: { direct: { interaction: { mode: 'direct' } } },
      }),
    );
    expect(applyAgentVariant(base, 'direct').interaction.mode).toBe('direct');
  });

  it('partial install.source override patches the base git source ref', () => {
    const base = parseAgentConfig(
      baseYaml({
        install: {
          source: { type: 'git', repo: 'https://example.com/repo.git', ref: 'main' },
        },
        variants: {
          experimental: {
            install: { source: { ref: 'feature-branch' } },
          },
        },
      }),
    );
    const merged = applyAgentVariant(base, 'experimental');
    expect(merged.install.source).toEqual({
      type: 'git',
      repo: 'https://example.com/repo.git',
      ref: 'feature-branch',
    });
  });

  it('partial install.source override patches the base npm version', () => {
    const base = parseAgentConfig(
      baseYaml({
        install: { source: { type: 'npm', package: '@example/agent', version: '^1.0' } },
        variants: {
          next: { install: { source: { version: '^2.0' } } },
        },
      }),
    );
    const merged = applyAgentVariant(base, 'next');
    expect(merged.install.source).toEqual({
      type: 'npm',
      package: '@example/agent',
      version: '^2.0',
    });
  });

  it('full install.source override replaces the base', () => {
    const base = parseAgentConfig(
      baseYaml({
        install: { source: { type: 'local' } },
        variants: {
          from_git: {
            install: {
              source: { type: 'git', repo: 'https://example.com/r.git', ref: 'main' },
            },
          },
        },
      }),
    );
    const merged = applyAgentVariant(base, 'from_git');
    expect(merged.install.source).toEqual({
      type: 'git',
      repo: 'https://example.com/r.git',
      ref: 'main',
    });
  });

  it('rejects partial ref override on an npm base source', () => {
    const base = parseAgentConfig(
      baseYaml({
        install: { source: { type: 'npm', package: '@example/agent' } },
        variants: { v: { install: { source: { ref: 'main' } } } },
      }),
    );
    expect(() => applyAgentVariant(base, 'v')).toThrow(/ref.*does not apply to npm/);
  });

  it('rejects partial override on a local base source', () => {
    const base = parseAgentConfig(
      baseYaml({
        install: { source: { type: 'local' } },
        variants: { v: { install: { source: { ref: 'main' } } } },
      }),
    );
    expect(() => applyAgentVariant(base, 'v')).toThrow(/partial.*only applies to git\/npm/);
  });

  it('throws on unknown variant', () => {
    const base = parseAgentConfig(baseYaml());
    expect(() => applyAgentVariant(base, 'nope')).toThrow(/Unknown variant/);
  });

  describe('install.configure merge', () => {
    it('raw-array variant override replaces the base configure list (shorthand for mergeMode: replace)', () => {
      const base = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ run: 'base-1' }, { run: 'base-2' }],
          },
          variants: {
            v: { install: { configure: [{ run: 'variant-only' }] } },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([{ run: 'variant-only' }]);
    });

    it('mergeMode: append concatenates onto the base configure list', () => {
      const base = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ run: 'base-1' }, { run: 'base-2' }],
          },
          variants: {
            v: {
              install: {
                configure: {
                  mergeMode: 'append',
                  items: [{ run: 'extra' }],
                },
              },
            },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([
        { run: 'base-1' },
        { run: 'base-2' },
        { run: 'extra' },
      ]);
    });

    it('mergeMode: replace via wrapper replaces wholesale (same as raw array)', () => {
      const base = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ run: 'base-1' }],
          },
          variants: {
            v: {
              install: {
                configure: {
                  mergeMode: 'replace',
                  items: [{ run: 'variant-only' }],
                },
              },
            },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([{ run: 'variant-only' }]);
    });

    it('mergeMode: append against an undefined base configure returns just the variant items', () => {
      const base = parseAgentConfig(
        baseYaml({
          variants: {
            v: {
              install: {
                configure: {
                  mergeMode: 'append',
                  items: [{ run: 'only-thing' }],
                },
              },
            },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([{ run: 'only-thing' }]);
    });

    it('mergeMode: append with empty items leaves the base unchanged', () => {
      const base = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ run: 'base-1' }],
          },
          variants: {
            v: { install: { configure: { mergeMode: 'append', items: [] } } },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([{ run: 'base-1' }]);
    });

    it('rejects unknown mergeMode value', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            variants: {
              v: {
                install: {
                  configure: { mergeMode: 'prepend', items: [{ run: 'x' }] },
                },
              },
            },
          }),
        ),
      ).toThrow(/mergeMode must be 'append' or 'replace'/);
    });

    it('rejects mergeMode wrapper without items', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            variants: {
              v: { install: { configure: { mergeMode: 'append' } } },
            },
          }),
        ),
      ).toThrow(/items must be an array of steps/);
    });

    it('rejects unknown keys in mergeMode wrapper', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            variants: {
              v: {
                install: {
                  configure: {
                    mergeMode: 'append',
                    items: [{ run: 'x' }],
                    nope: true,
                  },
                },
              },
            },
          }),
        ),
      ).toThrow(/unknown_field|unrecognized|nope/i);
    });
  });

  describe('configure with writeFile steps', () => {
    it('appends a writeFile step on top of a base run step', () => {
      const base = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ run: 'mkdir -p /tmp/x' }],
          },
          variants: {
            v: {
              install: {
                configure: {
                  mergeMode: 'append',
                  items: [
                    {
                      writeFile: '$BUNSEN_AGENT_HOME/.claude/CLAUDE.md',
                      from: 'prompts/cautious.md',
                    },
                  ],
                },
              },
            },
          },
        }),
      );
      const merged = applyAgentVariant(base, 'v');
      expect(merged.install.configure).toEqual([
        { run: 'mkdir -p /tmp/x' },
        {
          writeFile: '$BUNSEN_AGENT_HOME/.claude/CLAUDE.md',
          from: 'prompts/cautious.md',
        },
      ]);
    });

    it('rejects a step that sets both run and writeFile', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            install: {
              source: { type: 'local' },
              configure: [{ run: 'echo', writeFile: '/tmp/x', content: 'y' }],
            },
          }),
        ),
      ).toThrow(/may set 'run' or 'writeFile', not both/);
    });

    it('rejects a step that sets neither run nor writeFile', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            install: { source: { type: 'local' }, configure: [{}] },
          }),
        ),
      ).toThrow(/must set either 'run' or 'writeFile'/);
    });

    it('rejects a writeFile step with both from and content', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            install: {
              source: { type: 'local' },
              configure: [{ writeFile: '/tmp/x', from: 'a.md', content: 'b' }],
            },
          }),
        ),
      ).toThrow(/must set 'from' or 'content', not both/);
    });

    it('rejects a writeFile step with neither from nor content', () => {
      expect(() =>
        parseAgentConfig(
          baseYaml({
            install: {
              source: { type: 'local' },
              configure: [{ writeFile: '/tmp/x' }],
            },
          }),
        ),
      ).toThrow(/must set either 'from'.*or 'content'/);
    });

    it('accepts inline content with backticks, $vars, EOF in body', () => {
      const tricky = '`true` $BUNSEN_AGENT_HOME\nEOF\nEOF\n';
      const config = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [{ writeFile: '/tmp/x', content: tricky }],
          },
        }),
      );
      expect(config.install.configure).toEqual([
        { writeFile: '/tmp/x', content: tricky },
      ]);
    });

    it('preserves as: root and timeout on a writeFile step', () => {
      const config = parseAgentConfig(
        baseYaml({
          install: {
            source: { type: 'local' },
            configure: [
              {
                writeFile: '/tmp/x',
                content: 'y',
                as: 'root',
                timeout: '30s',
              },
            ],
          },
        }),
      );
      expect(config.install.configure).toEqual([
        { writeFile: '/tmp/x', content: 'y', as: 'root', timeout: '30s' },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Directory loading + variant
// ---------------------------------------------------------------------------

describe('loadAgent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunsen-agent-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads agent.yaml from a directory', () => {
    const agentDir = path.join(tempDir, 'my-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), baseYaml());

    const agent = loadAgent(agentDir);
    expect(agent.name).toBe('demo-agent');
    expect(agent.path).toBe(agentDir);
    expect(agent.configPath).toBe(path.join(agentDir, 'agent.yaml'));
  });

  it('applies the selected variant when provided', () => {
    const agentDir = path.join(tempDir, 'my-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      path.join(agentDir, 'agent.yaml'),
      baseYaml({
        variants: {
          fast: {
            entrypoint: { args: ['--fast'] },
            defaults: { env: { MODE: 'fast' } },
          },
        },
      }),
    );
    const agent = loadAgent(agentDir, { variant: 'fast' });
    expect(agent.variant).toBe('fast');
    expect(agent.entrypoint.args).toEqual(['--fast']);
    expect(agent.defaults?.env).toEqual({ MODE: 'fast' });
  });

  it('throws a structured error when agent.yaml is missing', () => {
    const agentDir = path.join(tempDir, 'missing');
    fs.mkdirSync(agentDir);
    expect(() => loadAgent(agentDir)).toThrow(AgentConfigError);
  });
});

// ---------------------------------------------------------------------------
// parseAgentVariantSyntax
// ---------------------------------------------------------------------------

describe('parseAgentVariantSyntax', () => {
  it('parses agent without variant', () => {
    expect(parseAgentVariantSyntax('my-agent')).toEqual(['my-agent', undefined]);
  });
  it('parses agent with variant', () => {
    expect(parseAgentVariantSyntax('my-agent:fast')).toEqual(['my-agent', 'fast']);
  });
  it('preserves Windows drive letters', () => {
    expect(parseAgentVariantSyntax('C:\\path\\agent')).toEqual(['C:\\path\\agent', undefined]);
  });
  it('preserves URL-like specs', () => {
    expect(parseAgentVariantSyntax('http://example.com/agent')).toEqual([
      'http://example.com/agent',
      undefined,
    ]);
  });
  it('treats empty variant as no variant', () => {
    expect(parseAgentVariantSyntax('my-agent:')).toEqual(['my-agent:', undefined]);
  });
});

// ---------------------------------------------------------------------------
// getAgentVariants
// ---------------------------------------------------------------------------

describe('getAgentVariants', () => {
  it('returns empty when no variants declared', () => {
    const config = parseAgentConfig(baseYaml());
    expect(getAgentVariants(config)).toEqual([]);
  });
  it('returns the list of declared variant names', () => {
    const config = parseAgentConfig(
      baseYaml({
        variants: {
          a: { description: 'a' },
          b: { description: 'b' },
        },
      }),
    );
    expect(getAgentVariants(config).sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// model block
// ---------------------------------------------------------------------------

describe('model block', () => {
  it('parses env + default', () => {
    const config = parseAgentConfig(
      baseYaml({ model: { env: 'ANTHROPIC_MODEL', default: 'claude-sonnet-4-6' } }),
    );
    expect(config.model).toEqual({ env: 'ANTHROPIC_MODEL', default: 'claude-sonnet-4-6' });
  });

  it('parses env without a default', () => {
    const config = parseAgentConfig(baseYaml({ model: { env: 'CODEX_MODEL' } }));
    expect(config.model).toEqual({ env: 'CODEX_MODEL' });
  });

  it('omits model when not declared', () => {
    expect(parseAgentConfig(baseYaml()).model).toBeUndefined();
  });

  it('rejects a missing env', () => {
    expect(() => parseAgentConfig(baseYaml({ model: { default: 'x' } }))).toThrow(
      /model\.env/,
    );
  });

  it('rejects an env name that is not a valid env var', () => {
    expect(() => parseAgentConfig(baseYaml({ model: { env: 'not a var' } }))).toThrow(
      /valid environment variable/,
    );
  });

  it('rejects a reserved BUNSEN_ env name', () => {
    expect(() => parseAgentConfig(baseYaml({ model: { env: 'BUNSEN_MODEL' } }))).toThrow(
      /reserved/,
    );
  });

  it('rejects unknown keys in the model block', () => {
    expect(() =>
      parseAgentConfig(baseYaml({ model: { env: 'X', tier: 'pro' } })),
    ).toThrow(/unknown/i);
  });

  it('rejects model inside a variant overlay (model is base-only)', () => {
    expect(() =>
      parseAgentConfig(
        baseYaml({
          model: { env: 'X' },
          variants: { fancy: { model: { env: 'Y' } } },
        }),
      ),
    ).toThrow();
  });

  it('carries the model block through variant application', () => {
    const base = parseAgentConfig(
      baseYaml({
        model: { env: 'ANTHROPIC_MODEL', default: 'claude-sonnet-4-6' },
        variants: { headless: { interaction: { mode: 'direct' } } },
      }),
    );
    const resolved = applyAgentVariant(base, 'headless');
    expect(resolved.model).toEqual({ env: 'ANTHROPIC_MODEL', default: 'claude-sonnet-4-6' });
  });
});

// ---------------------------------------------------------------------------
// resolveModelSelection
// ---------------------------------------------------------------------------

describe('resolveModelSelection', () => {
  const withModel = parseAgentConfig(
    baseYaml({ model: { env: 'ANTHROPIC_MODEL', default: 'claude-sonnet-4-6' } }),
  );
  const noModel = parseAgentConfig(baseYaml());

  it('returns undefined for an agent with no model and no request', () => {
    expect(resolveModelSelection(noModel, undefined)).toBeUndefined();
  });

  it('throws when --model is requested but the agent declares none', () => {
    expect(() => resolveModelSelection(noModel, 'gpt-5.5')).toThrow(/does not support --model/);
  });

  it('resolves to the declared default when no override is given', () => {
    expect(resolveModelSelection(withModel, undefined)).toEqual({
      envName: 'ANTHROPIC_MODEL',
      defaultValue: 'claude-sonnet-4-6',
      value: 'claude-sonnet-4-6',
    });
  });

  it('lets an override win over the default', () => {
    const sel = resolveModelSelection(withModel, 'claude-opus-4-7');
    expect(sel).toEqual({
      envName: 'ANTHROPIC_MODEL',
      defaultValue: 'claude-sonnet-4-6',
      overrideValue: 'claude-opus-4-7',
      value: 'claude-opus-4-7',
    });
  });

  it('handles a model block with no default (override only)', () => {
    const agent = parseAgentConfig(baseYaml({ model: { env: 'CODEX_MODEL' } }));
    expect(resolveModelSelection(agent, undefined)).toEqual({ envName: 'CODEX_MODEL' });
    expect(resolveModelSelection(agent, 'gpt-5.5')).toEqual({
      envName: 'CODEX_MODEL',
      overrideValue: 'gpt-5.5',
      value: 'gpt-5.5',
    });
  });
});

// ---------------------------------------------------------------------------
// install.deps
// ---------------------------------------------------------------------------

describe('install.deps', () => {
  function depsYaml(deps: unknown): string {
    return baseYaml({
      install: {
        source: { type: 'local' },
        deps,
      },
    });
  }

  it('parses an inline dep with multiple targets', () => {
    const config = parseAgentConfig(
      depsYaml([
        {
          name: 'ripgrep',
          version: '14.1.1',
          image: 'alpine:3.19',
          provides: { binaries: ['rg'] },
          install: [
            {
              target: 'linux/amd64',
              run: ['echo amd64 > /output/bin/rg'],
            },
            {
              target: 'linux/arm64',
              run: ['echo arm64 > /output/bin/rg'],
            },
          ],
        },
      ]),
    );
    expect(config.install.deps).toHaveLength(1);
    const dep = config.install.deps![0];
    expect(dep.name).toBe('ripgrep');
    expect(dep.version).toBe('14.1.1');
    expect(dep.provides?.binaries).toEqual(['rg']);
    expect(dep.install).toHaveLength(2);
    expect(dep.install[0]).toEqual({
      target: 'linux/amd64',
      image: 'alpine:3.19',
      run: ['echo amd64 > /output/bin/rg'],
    });
  });

  it('inherits image from the dep when per-target image is omitted, but per-target overrides win', () => {
    const config = parseAgentConfig(
      depsYaml([
        {
          name: 'tool',
          image: 'alpine:3.19',
          install: [
            { target: 'linux/amd64', run: ['true'] },
            { target: 'linux/arm64', image: 'debian:bookworm-slim', run: ['true'] },
          ],
        },
      ]),
    );
    const dep = config.install.deps![0];
    expect(dep.image).toBe('alpine:3.19');
    expect(dep.install[0].image).toBe('alpine:3.19');
    expect(dep.install[1].image).toBe('debian:bookworm-slim');
  });

  it('requires an image at the dep or target level', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            install: [{ target: 'linux/amd64', run: ['true'] }],
          },
        ]),
      ),
    ).toThrow(/no build image specified/);
  });

  it('rejects unknown targets', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            image: 'alpine:3.19',
            install: [{ target: 'darwin/amd64', run: ['true'] }],
          },
        ]),
      ),
    ).toThrow(/target must be one of/);
  });

  it('rejects duplicate targets within a single dep', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            image: 'alpine:3.19',
            install: [
              { target: 'linux/amd64', run: ['echo a'] },
              { target: 'linux/amd64', run: ['echo b'] },
            ],
          },
        ]),
      ),
    ).toThrow(/duplicate entry for linux\/amd64/);
  });

  it('rejects duplicate dep names', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            image: 'alpine:3.19',
            install: [{ target: 'linux/amd64', run: ['true'] }],
          },
          {
            name: 'tool',
            image: 'alpine:3.19',
            install: [{ target: 'linux/amd64', run: ['true'] }],
          },
        ]),
      ),
    ).toThrow(/duplicate dep name/);
  });

  it('rejects binary names containing slashes', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            image: 'alpine:3.19',
            provides: { binaries: ['bin/rg'] },
            install: [{ target: 'linux/amd64', run: ['true'] }],
          },
        ]),
      ),
    ).toThrow(/must be a bare binary name/);
  });

  it('requires install entries', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'tool',
            image: 'alpine:3.19',
          },
        ]),
      ),
    ).toThrow(/install is required/);
  });

  it('resolves file references relative to agent.yaml', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deps-'));
    try {
      const depPath = path.join(tmp, 'rg.yaml');
      fs.writeFileSync(
        depPath,
        yaml.dump({
          name: 'ripgrep',
          version: '14.1.1',
          image: 'alpine:3.19',
          provides: { binaries: ['rg'] },
          install: [{ target: 'linux/amd64', run: ['true'] }],
        }),
      );
      const agentYamlPath = path.join(tmp, 'agent.yaml');
      fs.writeFileSync(
        agentYamlPath,
        baseYaml({
          install: {
            source: { type: 'local' },
            deps: [{ file: './rg.yaml' }],
          },
        }),
      );
      const agent = loadAgent(tmp);
      expect(agent.install.deps).toHaveLength(1);
      expect(agent.install.deps![0].name).toBe('ripgrep');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails with a clear error when a file reference is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deps-'));
    try {
      const agentYamlPath = path.join(tmp, 'agent.yaml');
      fs.writeFileSync(
        agentYamlPath,
        baseYaml({
          install: {
            source: { type: 'local' },
            deps: [{ file: './does-not-exist.yaml' }],
          },
        }),
      );
      expect(() => loadAgent(tmp)).toThrow(/dep file not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects nested file references', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deps-'));
    try {
      const inner = path.join(tmp, 'inner.yaml');
      fs.writeFileSync(inner, yaml.dump({ file: './something-else.yaml' }));
      const agentYamlPath = path.join(tmp, 'agent.yaml');
      fs.writeFileSync(
        agentYamlPath,
        baseYaml({
          install: {
            source: { type: 'local' },
            deps: [{ file: './inner.yaml' }],
          },
        }),
      );
      expect(() => loadAgent(tmp)).toThrow(/nested file references are not supported/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects file refs that mix file with inline fields', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([{ file: './x.yaml', name: 'oops' }]),
        { source: '/tmp/agent.yaml' },
      ),
    ).toThrow(/dep file reference must only contain 'file'/);
  });

  it('rejects file refs when no source path is provided', () => {
    expect(() =>
      parseAgentConfig(depsYaml([{ file: './x.yaml' }])),
    ).toThrow(/cannot resolve dep file reference/);
  });

  it('parses linkage + abi for closure deps', () => {
    const config = parseAgentConfig(
      depsYaml([
        {
          name: 'node',
          version: '20.12.1',
          image: 'debian:bookworm-slim',
          linkage: 'closure',
          abi: { libc: 'glibc', libc_version: '>=2.31' },
          install: [{ target: 'linux/amd64', run: ['echo placeholder'] }],
        },
      ]),
    );
    const dep = config.install.deps![0];
    expect(dep.linkage).toBe('closure');
    expect(dep.abi).toEqual({ libc: 'glibc', libc_version: '>=2.31' });
  });

  it('parses linkage: static with no abi', () => {
    const config = parseAgentConfig(
      depsYaml([
        {
          name: 'ripgrep',
          image: 'alpine:3.19',
          linkage: 'static',
          install: [{ target: 'linux/amd64', run: ['echo rg'] }],
        },
      ]),
    );
    expect(config.install.deps![0].linkage).toBe('static');
    expect(config.install.deps![0].abi).toBeUndefined();
  });

  it('parses linkage: dynamic with requires.libraries', () => {
    const config = parseAgentConfig(
      depsYaml([
        {
          name: 'psql',
          image: 'debian:bookworm-slim',
          linkage: 'dynamic',
          abi: { libc: 'glibc' },
          requires: {
            libraries: [{ name: 'libpq', version: '>=14' }],
          },
          install: [{ target: 'linux/amd64', run: ['echo psql'] }],
        },
      ]),
    );
    const dep = config.install.deps![0];
    expect(dep.linkage).toBe('dynamic');
    expect(dep.requires?.libraries).toEqual([{ name: 'libpq', version: '>=14' }]);
  });

  it('rejects linkage: closure without abi', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'node',
            image: 'debian:bookworm-slim',
            linkage: 'closure',
            install: [{ target: 'linux/amd64', run: ['echo placeholder'] }],
          },
        ]),
      ),
    ).toThrow(/linkage 'closure' requires an 'abi' block/);
  });

  it('rejects linkage: dynamic without abi', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'psql',
            image: 'debian:bookworm-slim',
            linkage: 'dynamic',
            install: [{ target: 'linux/amd64', run: ['echo psql'] }],
          },
        ]),
      ),
    ).toThrow(/linkage 'dynamic' requires an 'abi' block/);
  });

  it('rejects abi declared alongside linkage: static', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'rg',
            image: 'alpine:3.19',
            linkage: 'static',
            abi: { libc: 'musl' },
            install: [{ target: 'linux/amd64', run: ['echo rg'] }],
          },
        ]),
      ),
    ).toThrow(/static.*must not declare an 'abi'/);
  });

  it('rejects unknown linkage value', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'rg',
            image: 'alpine:3.19',
            linkage: 'shared',
            install: [{ target: 'linux/amd64', run: ['echo rg'] }],
          },
        ]),
      ),
    ).toThrow(/linkage must be one of/);
  });

  it('rejects unknown abi.libc value', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'node',
            image: 'debian:bookworm-slim',
            linkage: 'closure',
            abi: { libc: 'bionic' },
            install: [{ target: 'linux/amd64', run: ['echo n'] }],
          },
        ]),
      ),
    ).toThrow(/libc must be one of/);
  });

  it('rejects requires.libraries on a static dep', () => {
    expect(() =>
      parseAgentConfig(
        depsYaml([
          {
            name: 'rg',
            image: 'alpine:3.19',
            linkage: 'static',
            requires: { libraries: [{ name: 'libfoo' }] },
            install: [{ target: 'linux/amd64', run: ['echo rg'] }],
          },
        ]),
      ),
    ).toThrow(/static.*must not declare 'requires.libraries'/);
  });

  it('variants can override deps wholesale', () => {
    const config = parseAgentConfig(
      baseYaml({
        install: {
          source: { type: 'local' },
          deps: [
            {
              name: 'rg',
              image: 'alpine:3.19',
              install: [{ target: 'linux/amd64', run: ['echo base'] }],
            },
          ],
        },
        variants: {
          custom: {
            install: {
              deps: [
                {
                  name: 'rg',
                  image: 'alpine:3.19',
                  install: [{ target: 'linux/amd64', run: ['echo variant'] }],
                },
                {
                  name: 'jq',
                  image: 'alpine:3.19',
                  install: [{ target: 'linux/amd64', run: ['echo jq'] }],
                },
              ],
            },
          },
        },
      }),
    );
    const merged = applyAgentVariant(config, 'custom');
    expect(merged.install.deps).toHaveLength(2);
    expect(merged.install.deps![0].install[0].run[0]).toBe('echo variant');
    expect(merged.install.deps![1].name).toBe('jq');
  });
});

// ---------------------------------------------------------------------------
// Migration check: every in-repo example agent loads under the v1 parser.
// ---------------------------------------------------------------------------

describe('examples/agents migration', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const agentsDir = path.join(repoRoot, 'examples', 'agents');

  if (!fs.existsSync(agentsDir)) return;

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const yamlPath = path.join(agentsDir, entry.name, 'agent.yaml');
    if (!fs.existsSync(yamlPath)) continue;

    it(`loads examples/agents/${entry.name}`, () => {
      const agent = loadAgent(path.join(agentsDir, entry.name));
      expect(agent.version).toBe('v1');
      expect(agent.install.source.type).toBeDefined();
      // Every variant resolves cleanly.
      const cfgForVariants: AgentConfig = agent;
      for (const variantName of Object.keys(cfgForVariants.variants ?? {})) {
        expect(() => applyAgentVariant(cfgForVariants, variantName)).not.toThrow();
      }
    });
  }

  it('claude-code defaults to headless (direct print mode); headed restores supervised', () => {
    const base = loadAgent(path.join(agentsDir, 'claude-code'));
    // The base config IS the headless print-mode config — it resolves when no
    // variant is given, so a bare `claude-code` now runs headless by default.
    expect(base.interaction.mode).toBe('direct');
    expect(base.entrypoint.args).toContain('-p');
    // The old `headless`/`verbose` variant names are gone; `headed` is the
    // supervised opt-in.
    const variants = getAgentVariants(base);
    expect(variants).not.toContain('headless');
    expect(variants).not.toContain('verbose');
    expect(variants).toContain('headed');
    const headed = applyAgentVariant(base, 'headed');
    expect(headed.interaction.mode).toBe('supervised');
    expect(headed.entrypoint.args).toEqual(['--dangerously-skip-permissions']);
  });
});
