/**
 * `bn doctor` — environment diagnostics.
 *
 * Surfaces every pre-run prerequisite the design doc lists. Each check
 * resolves to a `{ status, ... }` row; `--format json|yaml` returns the full
 * report so CI can gate on individual rows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import {
  isDockerAvailable,
  getDockerInfo,
  isGitAvailable,
  imageExists,
  loadProject,
  ProjectConfigError,
  MITMPROXY_IMAGE,
  PROVIDER_LABELS,
  platformKeyHint,
  resolvePlatformKeys,
  DEFAULT_SCORER_MODEL,
} from '@bunsen-dev/runtime';
import { SCORER_PROVIDERS, type ScorerProvider } from '@bunsen-dev/types';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { EXIT_CODES } from '../exit-codes.js';

interface DoctorOptions {
  format?: string;
}

export type Severity = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  label: string;
  status: Severity;
  detail?: string;
  hint?: string;
  data?: Record<string, unknown>;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  const format = resolveFormat(options);
  const checks: CheckResult[] = [];

  checks.push(await checkDocker());
  checks.push(await checkContainerImages());
  checks.push(await checkProcps());
  checks.push(checkGit());
  checks.push(checkProject());
  checks.push(checkStorage());
  checks.push(...checkPlatformKeys(process.env));

  const overallStatus = rollUpStatus(checks);

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine({ status: overallStatus, checks }, format));
  } else {
    renderText(overallStatus, checks);
  }

  if (overallStatus === 'fail') {
    process.exit(EXIT_CODES.GENERIC);
  }
  process.exit(EXIT_CODES.SUCCESS);
}

/** Worst row wins: any `fail` fails the report, otherwise any `warn` warns. */
export function rollUpStatus(checks: CheckResult[]): Severity {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

async function checkDocker(): Promise<CheckResult> {
  const reachable = await isDockerAvailable().catch(() => false);
  if (!reachable) {
    return {
      id: 'docker',
      label: 'Docker daemon',
      status: 'fail',
      detail: 'Docker is not reachable',
      hint: 'Install Docker Desktop or start the daemon. On macOS, Docker ships at /Applications/Docker.app — make sure /Applications/Docker.app/Contents/Resources/bin is on PATH.',
    };
  }
  try {
    const info = await getDockerInfo();
    return {
      id: 'docker',
      label: 'Docker daemon',
      status: 'ok',
      detail: `${info.version} (api ${info.apiVersion}, arch ${info.arch})`,
      data: info,
    };
  } catch (err) {
    return {
      id: 'docker',
      label: 'Docker daemon',
      status: 'warn',
      detail: `Docker reachable but version probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkContainerImages(): Promise<CheckResult> {
  // Bunsen pulls container images on demand — it does not ship them in the
  // binary. This reports whether the pinned proxy sidecar is already cached
  // locally, so the user knows whether their next trace-capturing run will spend
  // time pulling it (absence is normal on a fresh install, not a failure).
  const cached = await imageExists(MITMPROXY_IMAGE).catch(() => false);
  return {
    id: 'container_images',
    label: 'Container images',
    status: 'ok',
    detail: cached
      ? `proxy sidecar ${MITMPROXY_IMAGE} (cached)`
      : `proxy sidecar ${MITMPROXY_IMAGE} (will pull on first trace-capturing run)`,
    hint: cached
      ? undefined
      : 'The first run also pulls each experiment\'s base image — allow network + time on that initial run.',
    data: { mitmproxyImage: MITMPROXY_IMAGE, cached },
  };
}

async function checkProcps(): Promise<CheckResult> {
  // procps is checked inside containers, not on the host — but the host
  // generally has it. We probe the host PATH for `ps`/`pgrep` as a hint that
  // supervised mode (which relies on `procps` inside containers) is feasible.
  const found = which('ps');
  if (!found) {
    return {
      id: 'procps',
      label: 'procps (host)',
      status: 'warn',
      detail: '`ps` not found on host PATH',
      hint: 'Supervised mode requires procps inside the agent container; the experiment image must install it.',
    };
  }
  return {
    id: 'procps',
    label: 'procps (host)',
    status: 'ok',
    detail: found,
  };
}

function checkGit(): CheckResult {
  if (!isGitAvailable()) {
    return {
      id: 'git',
      label: 'git',
      status: 'fail',
      detail: 'git not on PATH',
      hint: '`bn suites …` requires git. Install git and try again.',
    };
  }
  let version = 'unknown';
  try {
    version = execSync('git --version', { encoding: 'utf-8' }).trim();
  } catch {
    // tolerated — version probe failure shouldn't downgrade the check.
  }
  return { id: 'git', label: 'git', status: 'ok', detail: version };
}

function checkProject(): CheckResult {
  try {
    const project = loadProject(process.cwd());
    return {
      id: 'project_config',
      label: 'Project config',
      status: 'ok',
      detail: project.configPath ? `valid (${path.relative(process.cwd(), project.configPath)})` : 'no bunsen.config.yaml; using v1 defaults',
      data: { configPath: project.configPath ?? null, root: project.root },
    };
  } catch (err) {
    if (err instanceof ProjectConfigError) {
      return {
        id: 'project_config',
        label: 'Project config',
        status: 'fail',
        detail: err.message,
        ...(err.path ? { hint: `at ${err.path}` } : {}),
      };
    }
    return {
      id: 'project_config',
      label: 'Project config',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkStorage(): CheckResult {
  try {
    const project = loadProject(process.cwd());
    const root = project.storage.root;
    fs.mkdirSync(root, { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return {
      id: 'storage',
      label: 'Storage',
      status: 'ok',
      detail: `writable: ${root}`,
    };
  } catch (err) {
    return {
      id: 'storage',
      label: 'Storage',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
      hint: 'Set `storage.root` in bunsen.config.yaml or fix directory permissions.',
    };
  }
}

/**
 * One row per scorer provider, from the same host-env resolution the runtime
 * uses (`resolvePlatformKeys`), so what `bn doctor` reports and what a run
 * actually accepts can't drift apart.
 *
 * Only Anthropic is load-bearing by default: it backs the default scorer
 * model, the supervisor, and `bn agents infer-invoke`. OpenAI and Google are
 * opt-in — a rubric only needs them if a criterion names an `openai/…` or
 * `google/…` model — so a missing one reports `ok` and must not drag the
 * overall status down to `warn`.
 *
 * Pure: takes the env, returns rows, never exits.
 */
export function checkPlatformKeys(env: NodeJS.ProcessEnv): CheckResult[] {
  const resolved = resolvePlatformKeys(env);

  return SCORER_PROVIDERS.map((provider: ScorerProvider): CheckResult => {
    const key = resolved[provider];
    const label = `${PROVIDER_LABELS[provider]} API key`;
    const id = `api_key_${provider}`;

    if (key) {
      return {
        id,
        label,
        status: 'ok',
        detail: `present via ${key.source}`,
        data: { provider, source: key.source },
      };
    }

    if (provider === 'anthropic') {
      return {
        id,
        label,
        status: 'warn',
        detail: 'not set',
        hint:
          `Needed for the default scorer model (${DEFAULT_SCORER_MODEL}), the supervisor, ` +
          `and \`bn agents infer-invoke\` — ${platformKeyHint(provider)}.`,
        data: { provider, source: null },
      };
    }

    return {
      id,
      label,
      status: 'ok',
      detail: `not set (only needed for ${provider}/… scorer models)`,
      hint: platformKeyHint(provider),
      data: { provider, source: null },
    };
  });
}

function which(binary: string): string | null {
  try {
    const out = execSync(process.platform === 'win32' ? `where ${binary}` : `command -v ${binary}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).find(Boolean);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function renderText(overall: Severity, checks: CheckResult[]): void {
  console.log();
  console.log(chalk.bold('Bunsen environment diagnostics'));
  console.log(chalk.dim('═'.repeat(60)));
  for (const check of checks) {
    const tag =
      check.status === 'ok' ? chalk.green('✓') :
      check.status === 'warn' ? chalk.yellow('!') :
      chalk.red('✗');
    const detail = check.detail ? `  ${chalk.dim(check.detail)}` : '';
    console.log(`${tag} ${chalk.bold(check.label)}${detail}`);
    if (check.hint) {
      console.log(chalk.dim(`    ↳ ${check.hint}`));
    }
  }
  console.log();
  const summary =
    overall === 'ok' ? chalk.green('All checks passed.') :
    overall === 'warn' ? chalk.yellow('Some checks reported warnings.') :
    chalk.red('Some checks failed — see above.');
  console.log(summary);
  console.log();
}
