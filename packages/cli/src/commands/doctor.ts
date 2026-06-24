// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
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
  loadProject,
  ProjectConfigError,
  MITMPROXY_IMAGE,
} from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { EXIT_CODES } from '../exit-codes.js';

interface DoctorOptions {
  format?: string;
}

type Severity = 'ok' | 'warn' | 'fail';

interface CheckResult {
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
  checks.push(checkContainerImages());
  checks.push(await checkProcps());
  checks.push(checkGit());
  checks.push(checkProject());
  checks.push(checkStorage());
  checks.push(checkApiKeys());

  const overallStatus: Severity = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';

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

function checkContainerImages(): CheckResult {
  // Bunsen pulls container images on demand — it does not ship them in the
  // binary. The honest companion to "the binary installed but first run needs
  // Docker": the proxy sidecar (pinned) and any experiment base image are
  // fetched on the first run that needs them.
  return {
    id: 'container_images',
    label: 'Container images',
    status: 'ok',
    detail: `proxy sidecar pinned to ${MITMPROXY_IMAGE}`,
    hint: 'Pulled on demand: the first run that captures traces pulls this image, and the first run of an experiment pulls its base image — allow network + time on that initial run.',
    data: { mitmproxyImage: MITMPROXY_IMAGE },
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

function checkApiKeys(): CheckResult {
  const keys: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) keys.push('ANTHROPIC_API_KEY');
  if (process.env.OPENAI_API_KEY) keys.push('OPENAI_API_KEY');
  if (process.env.GEMINI_API_KEY) keys.push('GEMINI_API_KEY');
  if (process.env.BUNSEN_ANTHROPIC_API_KEY) keys.push('BUNSEN_ANTHROPIC_API_KEY');

  if (keys.length === 0) {
    return {
      id: 'api_keys',
      label: 'AI API keys',
      status: 'warn',
      detail: 'No ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / BUNSEN_ANTHROPIC_API_KEY set',
      hint: 'Required for LLM scorers and the starter agents (claude-code, codex-cli, gemini-cli). Add to `.env` or export in your shell.',
    };
  }
  return {
    id: 'api_keys',
    label: 'AI API keys',
    status: 'ok',
    detail: `present: ${keys.join(', ')}`,
  };
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
