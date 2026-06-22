// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Human-score command - Interactively score a run with human judgment
 */

import * as path from 'node:path';
import chalk from 'chalk';
import { createRl, prompt, confirm, confirmDefaultYes } from './helpers/prompt.js';
import {
  loadRunManifest,
  loadEvaluationResult,
  loadExperiment,
  saveHumanScores,
  loadHumanScores,
  getRunDir,
  refreshRunManifest,
} from '@bunsen-dev/runtime';
import type {
  HumanScores,
  HumanCriterionScore,
  AllowedScores,
} from '@bunsen-dev/types';
import type { ResolvedExperiment } from '@bunsen-dev/runtime';

interface HumanScoreOptions {
  criterion?: string;
  /** Discard any existing human scores before re-scoring. */
  reset?: boolean;
}

/** Scorer types that should be reviewed by humans (LLM-based scoring) */
const HUMAN_REVIEWABLE_TYPES = new Set(['judge', 'agent', 'browser-agent', undefined]);

/** Scorer types to skip (automated/mechanical scoring) */
const SKIP_SCORER_TYPES = new Set(['script', 'aggregate']);

function formatAllowedScores(scores: AllowedScores | undefined): string {
  if (!scores) return '0-1 (any decimal)';

  if (Array.isArray(scores)) {
    return scores.join(', ');
  }

  // Labeled scores: { 0: "none", 0.5: "partial", 1: "full" }
  return Object.entries(scores)
    .map(([value, label]) => `${value} (${label})`)
    .join(', ');
}

function getAllowedScoreValues(scores: AllowedScores | undefined): number[] | null {
  if (!scores) return null;
  if (Array.isArray(scores)) return scores;
  return Object.keys(scores).map(Number);
}

function validateScore(input: string, allowedScores: AllowedScores | undefined): number | null {
  const num = parseFloat(input);
  if (isNaN(num)) return null;

  const allowed = getAllowedScoreValues(allowedScores);
  if (allowed) {
    // Must be one of the allowed values
    const match = allowed.find((v) => Math.abs(v - num) < 0.001);
    if (match === undefined) return null;
    return match;
  }

  // Must be in 0-1 range
  if (num < 0 || num > 1) return null;
  return num;
}

function formatScore(score: number | null): string {
  if (score === null) return 'N/A';
  return score.toFixed(2);
}

export async function humanScoreCommand(
  runId: string,
  options: HumanScoreOptions
): Promise<void> {
  try {
    const manifest = loadRunManifest(runId);
    if (!manifest) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(1);
    }
    const evaluation = loadEvaluationResult(runId);

    if (!evaluation) {
      console.error(chalk.red('No scores found for this run. Run evaluation first.'));
      process.exit(1);
    }

    // Try to load experiment for rubric instructions
    let experiment: ResolvedExperiment | undefined;
    const experimentPath = manifest.experiment.path;
    if (experimentPath) {
      try {
        experiment = loadExperiment(experimentPath);
      } catch {
        console.log(
          chalk.yellow(
            `Warning: Could not load experiment config at ${experimentPath}. Scorer instructions will not be shown.`
          )
        );
      }
    }

    // Check for existing human scores. `--reset` discards them silently and
    // re-scores from scratch; otherwise we ask for confirmation before
    // overwriting.
    const existingScoresOnDisk = loadHumanScores(runId);
    const existingScores = options.reset ? undefined : existingScoresOnDisk;
    if (existingScoresOnDisk && !options.reset) {
      console.log(
        chalk.yellow(`Human scores already exist for this run (scored by ${existingScoresOnDisk.scoredBy} at ${existingScoresOnDisk.scoredAt}).`)
      );
      const proceed = await confirm('Update scores? [y/N] ');
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    } else if (existingScoresOnDisk && options.reset) {
      console.log(chalk.dim('Resetting: existing human scores will be replaced.'));
    }

    // Filter to LLM-reviewable criteria
    let reviewableCriteria = evaluation.criteria.filter((c) => {
      if (c.status === 'skipped') return false;
      if (SKIP_SCORER_TYPES.has(c.scorerType!)) return false;
      return HUMAN_REVIEWABLE_TYPES.has(c.scorerType);
    });

    // Apply --criterion filter
    if (options.criterion) {
      reviewableCriteria = reviewableCriteria.filter(
        (c) => c.id.toLowerCase() === options.criterion!.toLowerCase()
      );
      if (reviewableCriteria.length === 0) {
        const available = evaluation.criteria
          .filter((c) => !SKIP_SCORER_TYPES.has(c.scorerType!))
          .map((c) => c.id);
        console.error(chalk.red(`Criterion "${options.criterion}" not found.`));
        if (available.length > 0) {
          console.log(chalk.dim(`Available LLM-scored criteria: ${available.join(', ')}`));
        }
        process.exit(1);
      }
    }

    if (reviewableCriteria.length === 0) {
      console.log(chalk.dim('No LLM-scored criteria to review in this run.'));
      console.log(
        chalk.dim(
          'This run only has code-based or aggregate scoring, which is deterministic and does not need human review.'
        )
      );
      return;
    }

    // Show run context
    console.log();
    console.log(chalk.bold(`Human Scoring: ${manifest.experiment.id}`));
    console.log(
      chalk.dim(
        `Run ${runId} | Agent: ${manifest.agent.id}${manifest.agent.variant ? ` (${manifest.agent.variant})` : ''}`
      )
    );
    console.log(chalk.dim('═'.repeat(60)));

    // Show recommended commands for reviewing run context
    console.log();
    console.log(chalk.cyan('Recommended commands for context:'));
    console.log(chalk.dim(`  bn runs diff ${runId}      View workspace diff`));
    console.log(chalk.dim(`  bn runs show ${runId}      View run details`));
    console.log(chalk.dim(`  bn runs logs ${runId}      View agent logs`));
    console.log(chalk.dim(`  bn runs export ${runId}    Export workspace to disk`));

    // Score each criterion
    const rl = createRl();
    const scoredCriteria: HumanCriterionScore[] = [];

    // If updating, build a map of existing scores for pre-population
    const existingMap = new Map<string, HumanCriterionScore>();
    if (existingScores) {
      for (const c of existingScores.criteria) {
        existingMap.set(c.criterion, c);
      }
    }

    for (let i = 0; i < reviewableCriteria.length; i++) {
      const criterion = reviewableCriteria[i];
      const existing = existingMap.get(criterion.id);

      // Find the rubric criterion for instructions
      const rubricCriterion = experiment?.evaluation.criteria.find(
        (r) => r.id === criterion.id,
      );
      const rubricInstructions =
        rubricCriterion &&
        (rubricCriterion.type === 'judge' ||
          rubricCriterion.type === 'agent' ||
          rubricCriterion.type === 'browser-agent')
          ? rubricCriterion.instructions
          : undefined;

      console.log();
      console.log(chalk.dim('─'.repeat(60)));
      console.log(
        chalk.bold(`Criterion ${i + 1}/${reviewableCriteria.length}: ${criterion.id}`)
      );

      // Show instructions if available
      if (rubricInstructions) {
        console.log();
        console.log(chalk.cyan('Instructions:'));
        console.log(chalk.dim(`  ${rubricInstructions.replace(/\n/g, '\n  ')}`));
      }

      // Show LLM score and summary
      console.log();
      console.log(`LLM Score: ${chalk.bold(formatScore(criterion.score))}`);
      console.log(`LLM Summary: ${chalk.dim(criterion.summary)}`);

      // Show existing human score if updating
      if (existing) {
        console.log(
          `Previous human score: ${chalk.yellow(formatScore(existing.humanScore))}${existing.notes ? ` (${existing.notes})` : ''}`
        );
      }

      // Show screenshots if any
      if (criterion.screenshots && criterion.screenshots.length > 0) {
        const runDir = getRunDir(runId);
        console.log();
        console.log(chalk.cyan('Screenshots:'));
        for (const s of criterion.screenshots) {
          console.log(`  ${path.join(runDir, s)}`);
        }
      }

      // Prompt for score
      console.log();
      console.log(chalk.dim(`Allowed scores: ${formatAllowedScores(criterion.allowedScores)}`));

      let score: number | null = null;
      let skipped = false;

      while (score === null && !skipped) {
        const defaultHint = existing ? ` [${existing.humanScore}]` : '';
        const answer = await prompt(rl, `Your score${defaultHint} (or 's' to skip): `);

        if (answer.toLowerCase() === 's' || answer === '') {
          if (answer === '' && existing) {
            // Empty input with existing score = keep existing
            score = existing.humanScore;
          } else {
            skipped = true;
          }
        } else {
          score = validateScore(answer, criterion.allowedScores);
          if (score === null) {
            console.log(
              chalk.red(
                `Invalid score. ${criterion.allowedScores ? `Must be one of: ${formatAllowedScores(criterion.allowedScores)}` : 'Must be a number between 0 and 1.'}`
              )
            );
          }
        }
      }

      if (skipped) {
        console.log(chalk.dim('  Skipped'));
        continue;
      }

      // Prompt for notes
      const existingNotes = existing?.notes || '';
      const notesHint = existingNotes ? ` [${existingNotes}]` : '';
      const notes = await prompt(rl, `Notes (optional${notesHint}): `);
      const finalNotes = notes || existingNotes || undefined;

      scoredCriteria.push({
        criterion: criterion.id,
        humanScore: score!,
        llmScore: criterion.score,
        notes: finalNotes,
        allowedScores: criterion.allowedScores,
      });
    }

    rl.close();

    if (scoredCriteria.length === 0) {
      console.log(chalk.dim('\nNo criteria were scored. Nothing to save.'));
      return;
    }

    // Show summary
    console.log();
    console.log(chalk.dim('─'.repeat(60)));
    console.log(chalk.bold('Summary'));
    console.log();

    const criterionWidth = Math.max(20, ...scoredCriteria.map((c) => c.criterion.length));
    console.log(
      chalk.bold(
        `${'Criterion'.padEnd(criterionWidth + 2)}${'Human'.padEnd(8)}${'LLM'.padEnd(8)}Delta`
      )
    );

    for (const c of scoredCriteria) {
      const delta = c.llmScore !== null ? c.humanScore - c.llmScore : null;
      const deltaStr =
        delta !== null
          ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
          : 'N/A';
      const deltaColor =
        delta !== null ? (Math.abs(delta) > 0.2 ? chalk.red : chalk.dim) : chalk.dim;

      console.log(
        `${c.criterion.padEnd(criterionWidth + 2)}${formatScore(c.humanScore).padEnd(8)}${formatScore(c.llmScore).padEnd(8)}${deltaColor(deltaStr)}`
      );
    }

    // Confirm save (default yes)
    console.log();
    const saveConfirm = await confirmDefaultYes('Save these scores? [Y/n] ');
    if (!saveConfirm) {
      console.log('Cancelled. Scores not saved.');
      return;
    }

    const humanScores: HumanScores = {
      criteria: scoredCriteria,
      scoredBy: 'human',
      scoredAt: new Date().toISOString(),
    };

    saveHumanScores(runId, humanScores);
    try {
      refreshRunManifest(runId);
    } catch {
      // best-effort — bn rebuild-index recovers if the manifest/index write hiccups
    }

    console.log(chalk.green(`\nHuman scores saved to ${getRunDir(runId)}/evaluation/human.json`));
    console.log(chalk.dim('Run `bn eval calibrate` to compare human vs LLM scores across runs.'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
