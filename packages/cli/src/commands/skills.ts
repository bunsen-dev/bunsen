// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `bn skills install | list | uninstall`.
 *
 * Bunsen ships a set of portable `SKILL.md` "Agent Skills" — model-invoked
 * instruction packs that help a user author experiments, write scorers, debug
 * runs, and plug in agents from their own coding agent. Because `SKILL.md` is an
 * open standard, the same files are discovered natively by Claude Code, Codex,
 * Cursor, Gemini CLI, and Copilot — there is no Claude-only vehicle here.
 *
 * The skills are bundled inside `@bunsen-dev/cli` (under `dist/assets/skills/`, the
 * same `getAssetDir()` plumbing the platform bundles use), so they are
 * version-matched to the CLI the user already has. This command copies them into
 * each client's discovery directory:
 *   - Claude Code: `~/.claude/skills/`        (`.claude/skills/` with --project)
 *   - Codex:       `~/.agents/skills/`        (`.agents/skills/` with --project)
 *
 * Installs are idempotent (a re-install replaces the bunsen-* skill dirs and
 * leaves any other skills untouched) and stamped with the CLI version so
 * `bn skills list` can flag drift after a CLI upgrade.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { getAssetDir } from '@bunsen-dev/runtime';
import { BunsenCliError } from '../errors.js';
import { CLI_VERSION } from '../version.js';
import { isMachineFormat, renderMachine, resolveFormat } from '../format.js';

export type SkillClient = 'claude' | 'codex';
type Scope = 'user' | 'project';

interface SkillsOptions {
  claude?: boolean;
  codex?: boolean;
  all?: boolean;
  project?: boolean;
  format?: string;
}

interface ClientMeta {
  label: string;
  /** Discovery subdir relative to the scope root (home for user, cwd for project). */
  subdir: string;
  /** Home-relative marker dirs whose presence implies the client is installed. */
  detect: string[];
}

const CLIENTS: Record<SkillClient, ClientMeta> = {
  claude: { label: 'Claude Code', subdir: path.join('.claude', 'skills'), detect: ['.claude'] },
  codex: { label: 'Codex', subdir: path.join('.agents', 'skills'), detect: ['.codex', '.agents'] },
};

const STAMP_FILE = '.bunsen-skills.json';

interface Stamp {
  cliVersion: string;
  skills: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Resolve the directory the bundled `SKILL.md` skills live in. */
export function bundledSkillsDir(): string {
  const override = process.env.BUNSEN_SKILLS_DIR;
  if (override && override.trim()) return override;
  return path.join(getAssetDir(), 'skills');
}

/** Names of every bundled skill (a subdir containing a `SKILL.md`), sorted. */
export function listBundledSkills(sourceDir: string): string[] {
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(sourceDir, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();
}

/** Absolute skills directory for a client at a given scope. */
export function clientSkillsDir(
  client: SkillClient,
  scope: Scope,
  cwd: string,
  home: string,
): string {
  const root = scope === 'project' ? cwd : home;
  return path.join(root, CLIENTS[client].subdir);
}

/** Detect which clients appear installed under `home` (presence of a marker dir). */
export function detectClients(home: string): SkillClient[] {
  return (Object.keys(CLIENTS) as SkillClient[]).filter((client) =>
    CLIENTS[client].detect.some((marker) => fs.existsSync(path.join(home, marker))),
  );
}

function readStamp(skillsDir: string): Stamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(skillsDir, STAMP_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.skills)) {
      return { cliVersion: String(parsed.cliVersion ?? ''), skills: parsed.skills.map(String) };
    }
  } catch {
    /* not installed */
  }
  return null;
}

/** Read what's installed at `skillsDir`: stamped version + which skills are present. */
export function installedSkillsAt(
  skillsDir: string,
): { cliVersion: string; skills: string[]; present: string[] } | null {
  const stamp = readStamp(skillsDir);
  if (!stamp) return null;
  const present = stamp.skills.filter((s) => fs.existsSync(path.join(skillsDir, s, 'SKILL.md')));
  return { cliVersion: stamp.cliVersion, skills: stamp.skills, present };
}

/** Outcome of an install into one client directory. */
export interface InstallResult {
  /** Skills now installed. */
  skills: string[];
  /** The CLI version stamped by a prior install here, or null if this is fresh. */
  previousVersion: string | null;
  /** `installed` (fresh), `updated` (prior stamp differs), `reinstalled` (same version). */
  status: 'installed' | 'updated' | 'reinstalled';
}

/** Copy every bundled skill into `skillsDir` (replacing prior copies) and stamp it. */
export function installSkillsInto(
  sourceDir: string,
  skillsDir: string,
  version: string,
): InstallResult {
  const skills = listBundledSkills(sourceDir);
  if (skills.length === 0) {
    throw new BunsenCliError(
      'skills_assets_missing',
      `No bundled skills found at ${sourceDir}.`,
      {
        details: {
          hint: 'This is a packaging error — the CLI build should populate dist/assets/skills/.',
        },
      },
    );
  }
  // Read the prior stamp BEFORE overwriting so we can report install vs update.
  const previousVersion = readStamp(skillsDir)?.cliVersion ?? null;

  fs.mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) {
    const dest = path.join(skillsDir, skill);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(sourceDir, skill), dest, { recursive: true });
  }
  const stamp: Stamp = { cliVersion: version, skills };
  fs.writeFileSync(path.join(skillsDir, STAMP_FILE), JSON.stringify(stamp, null, 2) + '\n');

  const status =
    previousVersion == null ? 'installed' : previousVersion !== version ? 'updated' : 'reinstalled';
  return { skills, previousVersion, status };
}

/** Remove bundled skill dirs (and the stamp) from `skillsDir`. Returns removed names. */
export function uninstallSkillsFrom(skillsDir: string, candidateSkills: string[]): string[] {
  const stamp = readStamp(skillsDir);
  const names = new Set<string>([...candidateSkills, ...(stamp?.skills ?? [])]);
  const removed: string[] = [];
  for (const name of [...names].sort()) {
    const dir = path.join(skillsDir, name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  fs.rmSync(path.join(skillsDir, STAMP_FILE), { force: true });
  return removed;
}

// ---------------------------------------------------------------------------
// Client resolution
// ---------------------------------------------------------------------------

/** Which clients to install for: explicit flags, else auto-detect, else both. */
function resolveInstallClients(options: SkillsOptions): { clients: SkillClient[]; autodetected: boolean } {
  if (options.all) return { clients: ['claude', 'codex'], autodetected: false };
  const explicit: SkillClient[] = [];
  if (options.claude) explicit.push('claude');
  if (options.codex) explicit.push('codex');
  if (explicit.length) return { clients: explicit, autodetected: false };

  const detected = detectClients(os.homedir());
  if (detected.length) return { clients: detected, autodetected: true };
  // No client detected: install for both so the files are ready when one shows up.
  return { clients: ['claude', 'codex'], autodetected: false };
}

/** For list/uninstall: explicit flags else all known clients. */
function resolveTargetClients(options: SkillsOptions): SkillClient[] {
  if (options.all) return ['claude', 'codex'];
  const explicit: SkillClient[] = [];
  if (options.claude) explicit.push('claude');
  if (options.codex) explicit.push('codex');
  return explicit.length ? explicit : ['claude', 'codex'];
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function skillsInstallCommand(options: SkillsOptions): Promise<void> {
  const format = resolveFormat(options);
  const scope: Scope = options.project ? 'project' : 'user';
  const cwd = process.cwd();
  const home = os.homedir();
  const sourceDir = bundledSkillsDir();
  const { clients, autodetected } = resolveInstallClients(options);

  const installs = clients.map((client) => {
    const dir = clientSkillsDir(client, scope, cwd, home);
    const { skills, previousVersion, status } = installSkillsInto(sourceDir, dir, CLI_VERSION);
    return { client, label: CLIENTS[client].label, dir, skills, previousVersion, status };
  });

  if (isMachineFormat(format)) {
    process.stdout.write(
      renderMachine({ scope, cliVersion: CLI_VERSION, installs }, format),
    );
    return;
  }

  for (const install of installs) {
    const head =
      install.status === 'updated'
        ? `✓ Updated ${install.label}: v${install.previousVersion} → v${CLI_VERSION} (${install.skills.length} skill(s))`
        : install.status === 'reinstalled'
          ? `✓ Reinstalled ${install.skills.length} skill(s) for ${install.label} (already v${CLI_VERSION})`
          : `✓ Installed ${install.skills.length} skill(s) for ${install.label}`;
    console.log(chalk.green(head));
    console.log(chalk.dim(`  ${install.dir}`));
    // List the skills on a first install; an update/reinstall just states the transition.
    if (install.status === 'installed') {
      for (const skill of install.skills) console.log(chalk.dim(`    + ${skill}`));
    }
  }
  if (autodetected) {
    console.log();
    console.log(
      chalk.dim('Installed for detected clients. Use --claude / --codex / --all to choose.'),
    );
  }
  console.log();
  console.log(chalk.dim('Tip: mention the skills in your CLAUDE.md / AGENTS.md so the agent reaches for them, e.g.'));
  console.log(chalk.dim('  "Use the bunsen-* skills (bn skills) to author experiments, scorers, and agents."'));
}

export async function skillsListCommand(options: SkillsOptions): Promise<void> {
  const format = resolveFormat(options);
  const scope: Scope = options.project ? 'project' : 'user';
  const cwd = process.cwd();
  const home = os.homedir();
  const clients = resolveTargetClients(options);

  const entries = clients.map((client) => {
    const dir = clientSkillsDir(client, scope, cwd, home);
    const installed = installedSkillsAt(dir);
    return {
      client,
      label: CLIENTS[client].label,
      dir,
      installed: installed?.present ?? [],
      installedVersion: installed?.cliVersion ?? null,
      currentVersion: CLI_VERSION,
      drift: installed != null && installed.cliVersion !== CLI_VERSION,
    };
  });

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine({ scope, entries }, format));
    return;
  }

  for (const entry of entries) {
    if (entry.installed.length === 0) {
      console.log(`${chalk.bold(entry.label)} ${chalk.dim('— not installed')}`);
      console.log(chalk.dim(`  ${entry.dir}`));
      continue;
    }
    const versionNote = entry.drift
      ? chalk.yellow(`v${entry.installedVersion} (CLI is v${entry.currentVersion} — run \`bn skills install\` to refresh)`)
      : chalk.dim(`v${entry.installedVersion}`);
    console.log(`${chalk.bold(entry.label)} ${versionNote}`);
    console.log(chalk.dim(`  ${entry.dir}`));
    for (const skill of entry.installed) console.log(chalk.dim(`    • ${skill}`));
  }
}

export async function skillsUninstallCommand(options: SkillsOptions): Promise<void> {
  const format = resolveFormat(options);
  const scope: Scope = options.project ? 'project' : 'user';
  const cwd = process.cwd();
  const home = os.homedir();
  const clients = resolveTargetClients(options);
  const candidates = listBundledSkills(bundledSkillsDir());

  const removals = clients.map((client) => {
    const dir = clientSkillsDir(client, scope, cwd, home);
    const removed = fs.existsSync(dir) ? uninstallSkillsFrom(dir, candidates) : [];
    return { client, label: CLIENTS[client].label, dir, removed };
  });

  if (isMachineFormat(format)) {
    process.stdout.write(renderMachine({ scope, removals }, format));
    return;
  }

  for (const removal of removals) {
    if (removal.removed.length === 0) {
      console.log(`${chalk.bold(removal.label)} ${chalk.dim('— nothing to remove')}`);
      continue;
    }
    console.log(chalk.green(`✓ Removed ${removal.removed.length} skill(s) from ${removal.label}`));
    console.log(chalk.dim(`  ${removal.dir}`));
    for (const skill of removal.removed) console.log(chalk.dim(`    - ${skill}`));
  }
}
