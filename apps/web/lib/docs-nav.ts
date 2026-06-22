/**
 * Documentation information architecture: the ordered grouping that drives the
 * docs sidebar and the /docs overview. The markdown content still lives in the
 * repo-root `docs/*.md` files (see `lib/docs.ts`); this manifest only decides
 * how those files are grouped, ordered, and labeled in the nav.
 *
 * To add a doc: drop the `.md` file in `docs/` AND add it to a group here. The
 * `docs/*.md ⟷ manifest` consistency is enforced by a test in `docs.test.ts`,
 * so a doc can never silently fall out of the nav (or vice versa).
 *
 * `file` is the source filename (case-sensitive, matching `docs/`); `title` is
 * the nav label (overrides the file's H1 so labels stay short and consistent).
 */

export type NavItem = { file: string; title: string };
export type NavGroup = { group: string; blurb: string; items: NavItem[] };

/** Files that exist in `docs/` but are intentionally NOT published on the site. */
export const DOCS_EXCLUDED: readonly string[] = ["PLATFORM_TOOLS.md"];

export const DOCS_NAV: readonly NavGroup[] = [
  {
    group: "Start Here",
    blurb: "Orientation and the fastest path to a first run and result.",
    items: [
      { file: "INTRODUCTION.md", title: "Introduction" },
      { file: "GETTING_STARTED.md", title: "Getting Started" },
      { file: "RUN_TERMINAL_BENCH.md", title: "Run a Terminal Bench Task" },
      { file: "BRING_YOUR_OWN_TASK.md", title: "Bring Your Own Task" },
    ],
  },
  {
    group: "Concepts",
    blurb: "How a run is composed: experiments, agents, and the container.",
    items: [
      { file: "HOW_IT_WORKS.md", title: "How Bunsen Works" },
      { file: "ENVIRONMENT.md", title: "The Environment Model" },
      { file: "TRUST_MODEL.md", title: "Trust Model" },
    ],
  },
  {
    group: "Authoring",
    blurb: "Write the config files and recipes that define experiments and agents.",
    items: [
      { file: "EXPERIMENT_YAML.md", title: "experiment.yaml Reference" },
      { file: "AGENT_YAML.md", title: "agent.yaml Reference" },
      { file: "AGENT_DEPS_COOKBOOK.md", title: "Agent Dependencies Cookbook" },
      { file: "SYSTEM_PROMPTS.md", title: "System Prompts" },
      { file: "ENVIRONMENT_USER.md", title: "Running as Root" },
      { file: "SUPERVISOR.md", title: "Supervised Mode" },
      { file: "SKILLS.md", title: "Agent Skills" },
    ],
  },
  {
    group: "Evaluation",
    blurb: "Define scoring criteria and choose where and how scorers run.",
    items: [
      { file: "SCORERS.md", title: "Scorers & Evaluation" },
      { file: "AGENT_CONTAINER_SCORING.md", title: "Scoring in the Agent Container" },
      { file: "PROCESS_SURVIVAL.md", title: "Scoring Service Tasks" },
    ],
  },
  {
    group: "Suites",
    blurb: "Consume published benchmark suites and author your own.",
    items: [{ file: "SUITES.md", title: "Suites" }],
  },
  {
    group: "Reference",
    blurb: "Command, project-config, run-output, platform, and cost references.",
    items: [
      { file: "CLI.md", title: "CLI Reference" },
      { file: "PROJECT_CONFIG.md", title: "Project Configuration" },
      { file: "RUN_MANIFEST.md", title: "Run Manifest & Events" },
      { file: "EXPORT_WORKSPACE.md", title: "Exporting a Run's Workspace" },
      { file: "COST.md", title: "Cost Accounting" },
      { file: "PLATFORMS.md", title: "Platforms & Architecture" },
      { file: "PACKAGES.md", title: "Packages & Schemas" },
      { file: "GLOSSARY.md", title: "Glossary" },
    ],
  },
];
