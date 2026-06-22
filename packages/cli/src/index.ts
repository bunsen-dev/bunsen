// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * @bunsen-dev/cli — noun-grouped command tree.
 *
 * Top-level commands are the resource nouns (`experiments`, `agents`,
 * `runs`, `eval`, `suites`, `index`, `cache`, `config`); `run` stays as
 * the primary verb. See the CLI reference table in `README.md`.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadProjectEnv, loadRunManifest, cancelRun } from '@bunsen-dev/runtime';

// Load .env from project root early, before any commands run
// This makes ANTHROPIC_API_KEY and other project-level vars available
loadProjectEnv();

import { runCommand } from './commands/run.js';
import { runsCommand } from './commands/runs.js';
import { showCommand } from './commands/show.js';
import { scoresCommand } from './commands/scores.js';
import { reportCommand } from './commands/report.js';
import { logsCommand } from './commands/logs.js';
import { tracesCommand } from './commands/traces.js';
import { costCommand } from './commands/cost.js';
import { diffCommand } from './commands/diff.js';
import { compareCommand } from './commands/compare.js';
import { listCommand } from './commands/list.js';
import { infoCommand } from './commands/info.js';
import { newCommand } from './commands/new.js';
import { openCommand } from './commands/open.js';
import { cleanCommand } from './commands/clean.js';
import { humanScoreCommand } from './commands/human-score.js';
import { calibrateCommand } from './commands/calibrate.js';
import { exportCommand } from './commands/export.js';
import { buildAgentCommand } from './commands/build-agent.js';
import { cacheListCommand, cacheCleanCommand } from './commands/cache.js';
import { rebuildIndexCommand } from './commands/rebuild-index.js';
import { indexStatusCommand } from './commands/index-status.js';
import { configShowCommand, configValidateCommand } from './commands/config.js';
import {
  experimentsValidateCommand,
  agentsValidateCommand,
} from './commands/validate.js';
import {
  suitesAddCommand,
  suitesListCommand,
  suitesUpdateCommand,
  suitesRemoveCommand,
  suitesInfoCommand,
} from './commands/suites.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { publishRunCommand, publishReportCommand } from './commands/publish.js';
import {
  skillsInstallCommand,
  skillsListCommand,
  skillsUninstallCommand,
} from './commands/skills.js';
import { wrapCommand } from './errors.js';
import { EXIT_CODES } from './exit-codes.js';
import { CLI_VERSION } from './version.js';

export const program = new Command();

program
  .name('bn')
  .description('Bunsen — a general-purpose experiment runner for agentic systems')
  .version(CLI_VERSION)
  .exitOverride((err) => {
    // Map Commander's parsing errors to the exit-code contract documented in
    // the "Exit Codes" section of README.md. Help/version exits are always
    // success.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(EXIT_CODES.SUCCESS);
    }
    process.exit(EXIT_CODES.USAGE);
  })
  .showHelpAfterError();

// Helper to collect multiple option values into an array
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// ---------------------------------------------------------------------------
// bn run — primary verb (stays top-level)
// ---------------------------------------------------------------------------

program
  .command('run')
  .description('Run an experiment with an agent')
  .argument('<experiment>', 'Experiment name or path (with optional :variant)')
  .argument('[agent]', 'Agent name or path (with optional :variant)')
  .option('--agent <agent>', 'Agent name (alternative to positional argument)')
  .option('--agent-variant <name>', 'Override agent variant')
  .option('--experiment-variant <name>', 'Override experiment variant')
  .option('--model <id>', "Model id for the agent (sets the agent's declared model env var, overriding any variant)")
  .option('-e, --env <VAR=value>', 'Set environment variable (can be repeated)', collect, [])
  .option('--env-file <path>', 'Load environment from file (can be repeated)', collect, [])
  .option('--pass-env <VAR>', 'Pass a host env var through to the run (can be repeated)', collect, [])
  .option('--platform <platform>', 'Execution platform (linux/amd64 or linux/arm64)')
  .option('--timeout <duration>', 'Execution timeout (e.g. 900000ms, 15m)', '900000')
  .option('--skip-eval', 'Skip evaluation phase')
  .option('--skip-traces', 'Skip AI API trace capture')
  .option('--record', 'Enable terminal recording via tmux + asciinema')
  .option('--terminal-size <cols>x<rows>', 'Terminal size for recording (default: 120x40)', '120x40')
  .option('--rebuild-agent', 'Rebuild install.build artifacts (bypass build cache)')
  .option('--remote', 'Reserved for future remote execution')
  .option('--dry-run', 'Print the resolved run plan and exit')
  .option('--format <format>', 'Output format for --dry-run (text|json|yaml)', 'text')
  .option('-v, --verbose', 'Show verbose output')
  .option('--debug-keep-container', 'Keep container running after completion for debugging')
  .option('--export-workspace', 'Export workspace as tar.gz after run')
  .action(runCommand);

// ---------------------------------------------------------------------------
// bn experiments
// ---------------------------------------------------------------------------

const experimentsCommand = program
  .command('experiments')
  .description('Inspect and validate experiments');

experimentsCommand
  .command('list')
  .description('List available experiments')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action((options: { format?: string }) => listCommand('experiments', options));

experimentsCommand
  .command('show')
  .description('Show details about an experiment')
  .argument('<name>', 'Experiment name')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(infoCommand);

experimentsCommand
  .command('validate')
  .description('Validate experiment YAML (schema + cross-resource checks)')
  .argument('[name]', 'Experiment name (defaults to all when omitted)')
  .option('--all', 'Validate every experiment found in the project')
  .option('--fix', 'Rewrite YAML in place to derive missing criterion ids from titles')
  .action(experimentsValidateCommand);

// ---------------------------------------------------------------------------
// bn agents
// ---------------------------------------------------------------------------

const agentsCommand = program
  .command('agents')
  .description('Inspect, validate, and prebuild agents');

agentsCommand
  .command('list')
  .description('List available agents')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action((options: { format?: string }) => listCommand('agents', options));

agentsCommand
  .command('show')
  .description('Show details about an agent')
  .argument('<name>', 'Agent name')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(infoCommand);

agentsCommand
  .command('validate')
  .description('Validate agent YAML')
  .argument('[name]', 'Agent name (defaults to all when omitted)')
  .option('--all', 'Validate every agent found in the project')
  .action(agentsValidateCommand);

agentsCommand
  .command('build')
  .description('Build and cache install.build artifacts for an agent')
  .argument('<agent>', 'Agent name/path (optionally with :variant)')
  .option('--rebuild', 'Bypass build cache and rebuild artifacts')
  .option('--platform <platform>', 'Build platform (linux/amd64 or linux/arm64)')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(buildAgentCommand);

// ---------------------------------------------------------------------------
// bn suites
// ---------------------------------------------------------------------------

const suitesCommand = program
  .command('suites')
  .description('Manage git-cloned benchmark suites');

suitesCommand
  .command('list')
  .description('List configured suites and their cache status')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(suitesListCommand);

suitesCommand
  .command('add')
  .description('Clone a suite from a git URL and register it in bunsen.config.yaml')
  .argument('<git-url>', 'Suite repository URL (HTTPS or SSH)')
  .option('--ref <ref>', 'Pin to a branch, tag, or commit SHA')
  .option('--as <alias>', 'Local alias for unqualified `bn run <alias>/<exp>` resolution')
  .action(suitesAddCommand);

suitesCommand
  .command('update')
  .description('Refresh a suite cache to the configured ref (or branch tip)')
  .argument('[suite-id]', 'Suite id, alias, or GitHub short form')
  .option('--all', 'Update every configured suite')
  .action(suitesUpdateCommand);

suitesCommand
  .command('remove')
  .description('Unregister a suite and delete its cache')
  .argument('<suite-id>', 'Suite id, alias, or GitHub short form')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(suitesRemoveCommand);

suitesCommand
  .command('info')
  .description('Show details about a configured suite')
  .argument('<suite-id>', 'Suite id, alias, or GitHub short form')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(suitesInfoCommand);

// ---------------------------------------------------------------------------
// bn runs
// ---------------------------------------------------------------------------

const runsGroup = program
  .command('runs')
  .description('Inspect and manage runs');

runsGroup
  .command('list')
  .description('List runs')
  .option('-e, --experiment <name>', 'Filter by experiment')
  .option('-a, --agent <name>', 'Filter by agent')
  .option('-n, --last <count>', 'Show last N runs', '10')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .option('--ids-only', 'Output only run IDs (space-separated)')
  .action(runsCommand);

runsGroup
  .command('show')
  .description('Show run summary')
  .argument('<run-id>', 'Run ID')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(showCommand);

runsGroup
  .command('logs')
  .description('Show logs for a run')
  .argument('<run-id>', 'Run ID')
  .action(logsCommand);

runsGroup
  .command('diff')
  .description('Show workspace changes from a run')
  .argument('<run-id>', 'Run ID')
  .option('--include-lockfiles', 'Include lockfile changes in output')
  .action(diffCommand);

runsGroup
  .command('traces')
  .description('Show AI traces for a run')
  .argument('<run-id>', 'Run ID')
  .option('--full', 'Show full request/response bodies')
  .action(tracesCommand);

runsGroup
  .command('compare')
  .description('Compare runs side by side (default: newest run per agent)')
  .argument('[run-ids...]', 'Explicit run IDs (overrides filters)')
  .option('-e, --experiment <name>', 'Filter by experiment (comma-separated axes in --matrix)')
  .option('-a, --agent <name>', 'Filter by agent (id or id:variant; comma-separated in --matrix)')
  .option('--since <date>', 'Only runs started on/after this date (e.g. 2026-05-26)')
  .option('-n, --last <count>', 'Take the N most-recent matching runs (no per-agent dedup)')
  .option(
    '--annotate <field>',
    'Add a manifest field as a row (repeatable; e.g. cost-source, started-at, run-id)',
    (value: string, prev: string[] = []) => prev.concat(value),
  )
  .option('--matrix', 'Render a 2D experiments × agents score matrix')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(compareCommand);

runsGroup
  .command('cost')
  .description('Show cost breakdown for a run')
  .argument('<run-id>', 'Run ID')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(costCommand);

runsGroup
  .command('open')
  .description('Open run in web viewer')
  .argument('[run-id]', 'Run ID (defaults to most recent)')
  .option('-p, --port <port>', 'Port for the viewer server', '3456')
  .action(openCommand);

runsGroup
  .command('export')
  .description('Extract workspace from a completed run')
  .argument('<run-id>', 'Run ID to export')
  .option('-o, --output <path>', 'Output directory (default: temp directory)')
  .option('--install', 'Run npm/pip install after extraction')
  .action(exportCommand);

// `bn runs cancel` stops every container labeled with the run's id, removes
// the per-run network, and flips the manifest to `canceled`. If a foreground
// `bn run` still owns the run, the executor's catch path notices the
// canceled manifest and surfaces a clean `RunCanceledError` instead of the
// dockerode 409 fallout from the now-stopped container.
runsGroup
  .command('cancel')
  .description('Cancel a run: stop its containers and mark the manifest canceled')
  .argument('<run-id>', 'Run ID')
  .action(async (runId: string) => {
    const manifest = loadRunManifest(runId);
    if (!manifest) {
      console.error(chalk.red(`Run not found: ${runId}`));
      process.exit(EXIT_CODES.GENERIC);
    }
    if (manifest.status !== 'pending' && manifest.status !== 'running') {
      console.log(chalk.dim(`Run ${runId} is already ${manifest.status}; nothing to cancel.`));
      return;
    }
    try {
      const result = await cancelRun(runId);
      const parts: string[] = [];
      if (result.containersStopped > 0) {
        parts.push(`${result.containersStopped} container${result.containersStopped === 1 ? '' : 's'}`);
      }
      if (result.networksRemoved > 0) {
        parts.push(`${result.networksRemoved} network${result.networksRemoved === 1 ? '' : 's'}`);
      }
      const infraSummary = parts.length > 0 ? ` (stopped ${parts.join(' + ')})` : '';
      console.log(chalk.green(`Canceled run ${runId}${infraSummary}.`));
      for (const err of result.errors) {
        console.log(chalk.yellow(`  warning: ${err}`));
      }
    } catch (err) {
      console.error(chalk.red(`Failed to cancel run ${runId}: ${err instanceof Error ? err.message : err}`));
      process.exit(EXIT_CODES.GENERIC);
    }
  });

// ---------------------------------------------------------------------------
// bn eval
// ---------------------------------------------------------------------------

const evalCommand = program
  .command('eval')
  .description('Inspect, augment, and calibrate evaluation results');

evalCommand
  .command('show')
  .description('Show evaluator scores for a run')
  .argument('<run-id>', 'Run ID')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(scoresCommand);

evalCommand
  .command('report')
  .description('Show the evaluation report for a run')
  .argument('<run-id>', 'Run ID')
  .option('--save', 'Save report to evaluation/report.md in the run directory')
  .option('--open', 'Open report in system default markdown viewer')
  .action(reportCommand);

evalCommand
  .command('human')
  .description('Interactively score a run with human judgment')
  .argument('<run-id>', 'Run ID')
  .option('--reset', 'Discard any existing human scores before re-scoring')
  .option('--only <criterion>', 'Score only a specific criterion')
  .action((runId: string, options: { reset?: boolean; only?: string }) =>
    humanScoreCommand(runId, { criterion: options.only, reset: options.reset })
  );

evalCommand
  .command('calibrate')
  .description('Compare human scores to LLM scores')
  .argument('[run-ids...]', 'Run IDs to calibrate (default: all with human scores)')
  .option('-e, --experiment <name>', 'Filter by experiment')
  .option('-n, --last <count>', 'Limit to last N runs')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(calibrateCommand);

// ---------------------------------------------------------------------------
// bn index
// ---------------------------------------------------------------------------

const indexCommand = program
  .command('index')
  .description('Manage the SQLite run index');

indexCommand
  .command('rebuild')
  .description('Rebuild the SQLite run index from manifest.json files')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(rebuildIndexCommand);

indexCommand
  .command('status')
  .description('Show index location, schema version, and freshness')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(indexStatusCommand);

// ---------------------------------------------------------------------------
// bn config
// ---------------------------------------------------------------------------

const configCommand = program
  .command('config')
  .description('Inspect and validate the project configuration');

configCommand
  .command('show')
  .description('Print the resolved bunsen.config.yaml')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(configShowCommand);

configCommand
  .command('validate')
  .description('Validate bunsen.config.yaml')
  .action(configValidateCommand);

// ---------------------------------------------------------------------------
// bn cache
// ---------------------------------------------------------------------------

const cacheCommand = program
  .command('cache')
  .description('Manage local Bunsen build caches');

cacheCommand
  .command('list')
  .description('List build and deps cache entries')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(cacheListCommand);

cacheCommand
  .command('prune')
  .description('Remove all build and deps cache entries')
  .option('-f, --force', 'Skip confirmation prompt')
  .action((options: { force?: boolean }) => cacheCleanCommand(undefined, options));

cacheCommand
  .command('rm')
  .description('Remove a specific cache entry (build or deps)')
  .argument('<key>', 'Cache key to remove')
  .option('-f, --force', 'Skip confirmation prompt')
  .action((key: string, options: { force?: boolean }) => cacheCleanCommand(key, options));

// ---------------------------------------------------------------------------
// Cleanup of orphan containers — kept on its own; not part of the noun tree
// because it operates against Docker rather than a Bunsen resource.
// ---------------------------------------------------------------------------

program
  .command('clean')
  .description('Remove orphaned bunsen containers and networks')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--dry-run', 'Show what would be removed without removing')
  .action(cleanCommand);

// ---------------------------------------------------------------------------
// Authoring helper — `bn new <type> <name>` — not part of the resource nouns.
// ---------------------------------------------------------------------------

program
  .command('new')
  .description('Create a new experiment or agent')
  .argument('<type>', 'Type to create (experiment or agent)')
  .argument('<name>', 'Name for the new experiment or agent')
  .option('-t, --template <template>', 'Template to use')
  .action(newCommand);

// ---------------------------------------------------------------------------
// bn publish — reserved namespace for a future sharing surface. Subcommands
// exist so docs and external tooling can reference the eventual surface; both
// currently fail with a structured `not_implemented` error.
// ---------------------------------------------------------------------------

const publishCommand = program
  .command('publish')
  .description('Reserved: publish runs and reports in a future release');

publishCommand
  .command('run')
  .description('Reserved: publish a run for sharing in a future release')
  .argument('<run-id>', 'Run ID')
  .option('--visibility <visibility>', 'Publish visibility (public|unlisted)')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(
    wrapCommand(
      (
        runId: string,
        options: { visibility?: 'public' | 'unlisted'; format?: string },
      ) => {
        publishRunCommand(runId, options);
      },
    ),
  );

publishCommand
  .command('report')
  .description('Reserved: publish a report in a future release')
  .argument('<report-path>', 'Path to the report')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(
    wrapCommand((reportPath: string, _options: { format?: string }) => {
      publishReportCommand(reportPath);
    }),
  );

// ---------------------------------------------------------------------------
// bn doctor — environment diagnostics
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('Run environment diagnostics (Docker, git, project config, …)')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(doctorCommand);

// ---------------------------------------------------------------------------
// bn init — scaffold bunsen.config.yaml in the current directory
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Scaffold bunsen.config.yaml in the current directory')
  .option('-f, --force', 'Overwrite an existing bunsen.config.yaml')
  .option('--example', 'Also scaffold a tiny experiment + agent')
  .action(initCommand);

// ---------------------------------------------------------------------------
// bn skills — install the bundled cross-agent SKILL.md authoring skills into a
// coding agent's discovery dir (Claude Code / Codex). Skills ship inside the
// CLI, so they are version-matched to the `bn` the user already has.
// ---------------------------------------------------------------------------

const skillsCommand = program
  .command('skills')
  .description('Install Bunsen authoring skills into your coding agent (Claude Code, Codex)');

skillsCommand
  .command('install')
  .alias('update')
  .description('Install or update the bundled SKILL.md skills (re-run after a CLI upgrade to refresh)')
  .option('--claude', 'Install for Claude Code (~/.claude/skills)')
  .option('--codex', 'Install for Codex (~/.agents/skills)')
  .option('--all', 'Install for every supported client')
  .option('--project', 'Install into the current repo (.claude/skills, .agents/skills) instead of the user home')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(wrapCommand(skillsInstallCommand));

skillsCommand
  .command('list')
  .description('Show installed Bunsen skills per client and flag version drift')
  .option('--claude', 'Only Claude Code')
  .option('--codex', 'Only Codex')
  .option('--all', 'All clients (default)')
  .option('--project', 'Inspect repo-local skills instead of the user home')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(wrapCommand(skillsListCommand));

skillsCommand
  .command('uninstall')
  .description('Remove the installed Bunsen skills (leaves any non-Bunsen skills untouched)')
  .option('--claude', 'Only Claude Code')
  .option('--codex', 'Only Codex')
  .option('--all', 'All clients (default)')
  .option('--project', 'Remove repo-local skills instead of the user home')
  .option('--format <format>', 'Output format (text|json|yaml)', 'text')
  .action(wrapCommand(skillsUninstallCommand));
