// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn experiments validate` and `bn agents validate`.
 *
 * Both commands wrap `loadExperiment` / `loadAgent`, which already run schema
 * and cross-resource validation.
 *
 * `bn experiments validate --fix` additionally derives kebab-case `id`s for
 * criteria that have a `title` but no `id`, writes the YAML back, then
 * re-validates. The transform is idempotent: criteria that already have an
 * `id` are left alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import chalk from 'chalk';
import {
  loadExperiment,
  loadAgent,
  validateCriteriaGraph,
  resolveExperiment,
  resolveAgent,
  describeSearchedLocations,
  findAllExperiments,
  findAllAgents,
  ExperimentConfigError,
  AgentConfigError,
} from '@bunsen-dev/runtime';
import { EXIT_CODES } from '../exit-codes.js';

interface ValidateOptions {
  all?: boolean;
  fix?: boolean;
}

interface AgentValidateOptions {
  all?: boolean;
}

interface ValidationFailure {
  resource: string;
  message: string;
}

interface FixReport {
  changed: boolean;
  notes: string[];
}

export async function experimentsValidateCommand(
  name: string | undefined,
  options: ValidateOptions,
): Promise<void> {
  const cwd = process.cwd();

  try {
    if (!name || options.all) {
      const paths = findAllExperiments();
      if (paths.length === 0) {
        console.log(chalk.dim('No experiments found.'));
        return;
      }
      runBatch(
        paths,
        cwd,
        'experiment',
        options.fix === true,
        (p) => {
          const exp = loadExperiment(p);
          validateCriteriaGraph(exp);
        },
        (p) => fixExperimentFile(experimentYamlPath(p)),
      );
      return;
    }

    const result = resolveExperiment(name);
    if (!result) {
      console.error(chalk.red(`Experiment not found: ${name}`));
      console.error(chalk.dim(describeSearchedLocations('experiment')));
      process.exit(EXIT_CODES.VALIDATION);
    }

    const yamlPath = experimentYamlPath(result.path);
    if (options.fix) {
      const report = fixExperimentFile(yamlPath);
      if (report.changed) {
        console.log(chalk.cyan(`✎ ${path.relative(cwd, yamlPath)} — applied fixes:`));
        for (const note of report.notes) console.log(chalk.dim(`    ${note}`));
      }
    }

    const exp = loadExperiment(result.path);
    validateCriteriaGraph(exp);
    console.log(chalk.green(`✓ ${exp.name} — valid (${path.relative(cwd, result.path)})`));
  } catch (error) {
    handleValidationError(error);
  }
}

export async function agentsValidateCommand(
  name: string | undefined,
  options: AgentValidateOptions,
): Promise<void> {
  const cwd = process.cwd();

  try {
    if (!name || options.all) {
      const paths = findAllAgents();
      if (paths.length === 0) {
        console.log(chalk.dim('No agents found.'));
        return;
      }
      runBatch(paths, cwd, 'agent', false, (p) => {
        loadAgent(p);
      });
      return;
    }

    const result = resolveAgent(name);
    if (!result) {
      console.error(chalk.red(`Agent not found: ${name}`));
      console.error(chalk.dim(describeSearchedLocations('agent')));
      process.exit(EXIT_CODES.VALIDATION);
    }

    const agent = loadAgent(result.path);
    console.log(chalk.green(`✓ ${agent.name} — valid (${path.relative(cwd, result.path)})`));
  } catch (error) {
    handleValidationError(error);
  }
}

function runBatch(
  paths: string[],
  cwd: string,
  kind: 'experiment' | 'agent',
  fix: boolean,
  validate: (p: string) => void,
  applyFix?: (p: string) => FixReport,
): void {
  const failures: ValidationFailure[] = [];
  let okCount = 0;
  let fixedCount = 0;

  for (const p of paths) {
    const rel = path.relative(cwd, p);
    if (fix && applyFix) {
      try {
        const report = applyFix(p);
        if (report.changed) {
          console.log(chalk.cyan(`✎ ${rel} — applied fixes`));
          for (const note of report.notes) console.log(chalk.dim(`    ${note}`));
          fixedCount += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`✗ ${rel} (fix failed)`));
        console.log(chalk.dim(`    ${message}`));
        failures.push({ resource: rel, message });
        continue;
      }
    }

    try {
      validate(p);
      console.log(chalk.green(`✓ ${rel}`));
      okCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`✗ ${rel}`));
      console.log(chalk.dim(`    ${message}`));
      failures.push({ resource: rel, message });
    }
  }

  console.log();
  const fixSummary = fix ? `, ${chalk.cyan(fixedCount)} fixed` : '';
  console.log(
    `${chalk.green(okCount)} valid, ${chalk.red(failures.length)} failed${fixSummary} (${paths.length} total ${kind}${paths.length === 1 ? '' : 's'}).`,
  );
  if (failures.length > 0) {
    process.exit(EXIT_CODES.VALIDATION);
  }
}

function handleValidationError(error: unknown): never {
  if (error instanceof ExperimentConfigError || error instanceof AgentConfigError) {
    console.error(chalk.red(`✗ ${error.message}`));
    process.exit(EXIT_CODES.VALIDATION);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(`Error: ${message}`));
  process.exit(EXIT_CODES.GENERIC);
}

// ---------------------------------------------------------------------------
// --fix transform (idempotent)
// ---------------------------------------------------------------------------

export function fixExperimentFile(filePath: string): FixReport {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
  const notes: string[] = [];
  if (!isRecord(raw)) return { changed: false, notes };

  let changed = false;

  if (isRecord(raw.evaluation) && Array.isArray(raw.evaluation.criteria)) {
    const seen = new Set<string>();
    for (const criterion of raw.evaluation.criteria) {
      if (!isRecord(criterion)) continue;
      const id = typeof criterion.id === 'string' ? criterion.id : '';
      if (id) {
        seen.add(id);
        continue;
      }
      const title = typeof criterion.title === 'string' ? criterion.title : '';
      if (!title) continue;
      const slug = slugify(title);
      let candidate = slug;
      let suffix = 2;
      while (seen.has(candidate)) {
        candidate = `${slug}-${suffix++}`;
      }
      criterion.id = candidate;
      seen.add(candidate);
      notes.push(`derived id from title: "${title}" → ${candidate}`);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: 100, noRefs: true }));
  }
  return { changed, notes };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'criterion';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function experimentYamlPath(dirOrFile: string): string {
  return dirOrFile.endsWith('experiment.yaml') ? dirOrFile : path.join(dirOrFile, 'experiment.yaml');
}
