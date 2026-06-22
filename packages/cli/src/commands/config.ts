// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn config show|validate` — inspect and validate `bunsen.config.yaml`.
 *
 * Both commands share the same loader, which is the project's single
 * source of truth (`loadProject` from @bunsen-dev/runtime).
 */

import chalk from 'chalk';
import yaml from 'js-yaml';
import { loadProject, type ProjectConfigWarning } from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';

interface ConfigShowOptions {
  format?: string;
}

function printWarnings(warnings: ProjectConfigWarning[]): void {
  for (const w of warnings) {
    const prefix = chalk.yellow(`Warning [${w.code}]:`);
    const path = w.path ? chalk.dim(` (at ${w.path})`) : '';
    process.stderr.write(`${prefix} ${w.message}${path}\n`);
  }
}

export async function configShowCommand(options: ConfigShowOptions): Promise<void> {
  const format = resolveFormat(options);
  const project = loadProject(process.cwd());

  if (isMachineFormat(format)) {
    process.stdout.write(
      renderMachine(
        {
          root: project.root,
          configPath: project.configPath ?? null,
          storage: project.storage,
          config: project.config,
          warnings: project.warnings,
        },
        format,
      ),
    );
    return;
  }

  console.log(chalk.bold('Bunsen project'));
  console.log(`  Root:        ${project.root}`);
  console.log(`  Config:      ${project.configPath ?? chalk.dim('(none — using defaults)')}`);
  console.log(`  Storage:     ${project.storage.root}`);
  console.log(chalk.dim(`    runs:    ${project.storage.runs}`));
  console.log(chalk.dim(`    cache:   ${project.storage.cache}`));
  console.log(chalk.dim(`    suites:  ${project.storage.suites}`));
  console.log(chalk.dim(`    index:   ${project.storage.indexDb}`));

  console.log();
  console.log(chalk.bold('Resolved config'));
  console.log(yaml.dump(project.config, { lineWidth: 100, noRefs: true }));
  printWarnings(project.warnings);
}

export async function configValidateCommand(): Promise<void> {
  const project = loadProject(process.cwd());
  if (!project.configPath) {
    console.log(chalk.dim('No bunsen.config.yaml found; using v1 defaults — nothing to validate.'));
    return;
  }
  printWarnings(project.warnings);
  console.log(chalk.green(`✓ ${project.configPath} is valid.`));
}
