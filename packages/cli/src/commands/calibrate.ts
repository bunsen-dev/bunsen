// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Calibrate command - Compare human scores to LLM scores
 */

import chalk from 'chalk';
import {
  listRuns,
  loadRunManifest,
  loadEvaluationResult,
  loadHumanScores,
  computeCalibration,
} from '@bunsen-dev/runtime';
import type { RunScorePair } from '@bunsen-dev/runtime';
import { resolveFormat, isMachineFormat, renderMachine } from '../format.js';
import { parsePositiveInt } from './helpers/parse-positive-int.js';

interface CalibrateOptions {
  experiment?: string;
  last?: string;
  format?: string;
}

export async function calibrateCommand(
  runIds: string[],
  options: CalibrateOptions
): Promise<void> {
  const format = resolveFormat(options);
  try {
    let candidateIds: string[] = runIds;

    if (candidateIds.length === 0) {
      const allRuns = listRuns();
      let filtered = allRuns;

      if (options.experiment) {
        filtered = filtered.filter((m) => m.experiment.id === options.experiment);
      }

      if (options.last) {
        const limit = parsePositiveInt(options.last, '--last', 'calibrate_bad_count');
        filtered = filtered.slice(0, limit);
      }

      candidateIds = filtered.map((m) => m.run_id);
    }

    // Build RunScorePair array from runs that have both evaluation/result.json and evaluation/human.json
    const pairs: RunScorePair[] = [];

    for (const id of candidateIds) {
      const evaluation = loadEvaluationResult(id);
      const humanScores = loadHumanScores(id);
      if (!evaluation || !humanScores) continue;

      const manifest = loadRunManifest(id);
      if (!manifest) continue;
      pairs.push({
        runId: id,
        experimentId: manifest.experiment.id,
        humanScores,
        evaluationResult: evaluation,
      });
    }

    if (pairs.length === 0) {
      if (isMachineFormat(format)) {
        process.stdout.write(renderMachine({ runCount: 0, criteria: [], byScorerType: {} }, format));
        return;
      }
      console.log(chalk.dim('No runs with both LLM and human scores found.'));
      console.log(chalk.dim('Use `bn eval human <run-id>` to add human scores to a run.'));
      return;
    }

    // Compute calibration
    const result = computeCalibration(pairs);

    if (isMachineFormat(format)) {
      process.stdout.write(renderMachine(result, format));
      return;
    }

    // Display
    console.log();
    console.log(chalk.bold(`Calibration Report (${result.runCount} run${result.runCount !== 1 ? 's' : ''})`));

    // Show which runs
    console.log(
      chalk.dim(
        `Runs: ${pairs.map((p) => `${p.runId} (${p.experimentId})`).join(', ')}`
      )
    );
    console.log(chalk.dim('═'.repeat(65)));

    // Per-criterion table
    if (result.criteria.length > 0) {
      console.log();
      console.log(chalk.bold('Per-Criterion Analysis (sorted by error)'));
      console.log(chalk.dim('─'.repeat(65)));

      const nameWidth = Math.max(22, ...result.criteria.map((c) => c.criterion.length));
      console.log(
        chalk.bold(
          `${'Criterion'.padEnd(nameWidth + 2)}${'MAE'.padEnd(8)}${'Bias'.padEnd(10)}${'Samples'.padEnd(10)}Type`
        )
      );

      for (const c of result.criteria) {
        const biasStr = `${c.meanSignedError >= 0 ? '+' : ''}${c.meanSignedError.toFixed(2)}`;
        const biasColor =
          Math.abs(c.meanSignedError) > 0.2
            ? c.meanSignedError > 0
              ? chalk.cyan // LLM under-scores
              : chalk.red // LLM over-scores
            : chalk.dim;

        const maeColor = c.meanAbsoluteError > 0.3 ? chalk.red : c.meanAbsoluteError > 0.15 ? chalk.yellow : chalk.dim;

        console.log(
          `${c.criterion.padEnd(nameWidth + 2)}${maeColor(c.meanAbsoluteError.toFixed(2).padEnd(8))}${biasColor(biasStr.padEnd(10))}${String(c.count).padEnd(10)}${chalk.dim(c.scorerType ?? '')}`
        );
      }
    }

    // Per scorer-type breakdown
    const types = Object.keys(result.byScorerType);
    if (types.length > 0) {
      console.log();
      console.log(chalk.bold('By Scorer Type'));
      console.log(chalk.dim('─'.repeat(65)));

      console.log(
        chalk.bold(
          `${'Type'.padEnd(16)}${'MAE'.padEnd(8)}${'Bias'.padEnd(10)}Scores`
        )
      );

      for (const type of types) {
        const data = result.byScorerType[type];
        const biasStr = `${data.meanSignedError >= 0 ? '+' : ''}${data.meanSignedError.toFixed(2)}`;

        console.log(
          `${type.padEnd(16)}${data.mae.toFixed(2).padEnd(8)}${biasStr.padEnd(10)}${data.count}`
        );
      }
    }

    // Overall summary
    console.log();
    console.log(chalk.bold('Overall'));
    console.log(chalk.dim('─'.repeat(65)));

    const overallBias = result.overallMeanSignedError;
    const biasExplanation =
      Math.abs(overallBias) < 0.05
        ? 'well calibrated'
        : overallBias > 0
          ? 'LLM tends to under-score'
          : 'LLM tends to over-score';

    console.log(`Mean Absolute Error:   ${result.overallMAE.toFixed(2)}`);
    console.log(
      `Mean Signed Error:     ${overallBias >= 0 ? '+' : ''}${overallBias.toFixed(2)} (${biasExplanation})`
    );

    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }
}
