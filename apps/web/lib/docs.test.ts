import { describe, it, expect } from "vitest";
import { extractTitle, fileToSlug, getAllDocs, getDoc, docFiles, getNavGroups, rewriteHref } from "./docs";
import { DOCS_NAV, DOCS_EXCLUDED } from "./docs-nav";

describe("fileToSlug", () => {
  it("lowercases, strips .md, and maps underscores to hyphens", () => {
    expect(fileToSlug("SCORERS.md")).toBe("scorers");
    expect(fileToSlug("HOW_IT_WORKS.md")).toBe("how-it-works");
    expect(fileToSlug("AGENT_CONTAINER_SCORING.md")).toBe("agent-container-scoring");
  });
});

describe("extractTitle", () => {
  it("returns the first H1, stripped of backticks", () => {
    expect(extractTitle("# Bunsen Scorers\n\nbody", "fallback")).toBe("Bunsen Scorers");
    expect(extractTitle("# `environment.user` — Running as Root\n", "fallback")).toBe(
      "environment.user — Running as Root",
    );
  });
  it("falls back when there is no H1", () => {
    expect(extractTitle("no heading here", "Fallback Title")).toBe("Fallback Title");
  });
  it("ignores `# ` lines inside fenced code blocks", () => {
    const md = "```bash\n# install deps\npnpm install\n```\n\n# Real Title\n\nbody";
    expect(extractTitle(md, "fallback")).toBe("Real Title");
  });
});

describe("rewriteHref", () => {
  const slugs = new Set(["scorers", "environment"]);

  it("leaves external, mailto, and anchor links untouched", () => {
    expect(rewriteHref("https://example.com", slugs)).toBe("https://example.com");
    expect(rewriteHref("mailto:hi@bunsen.dev", slugs)).toBe("mailto:hi@bunsen.dev");
    expect(rewriteHref("#gate", slugs)).toBe("#gate");
  });

  it("rewrites cross-doc .md links to /docs routes, preserving anchors", () => {
    expect(rewriteHref("./SCORERS.md", slugs)).toBe("/docs/scorers");
    expect(rewriteHref("ENVIRONMENT.md#install", slugs)).toBe("/docs/environment#install");
  });

  it("maps SCREAMING_SNAKE filenames to kebab slugs", () => {
    const s = new Set(["agent-yaml", "how-it-works"]);
    expect(rewriteHref("./AGENT_YAML.md", s)).toBe("/docs/agent-yaml");
    expect(rewriteHref("HOW_IT_WORKS.md#orchestrator", s)).toBe("/docs/how-it-works#orchestrator");
  });

  it("sends unknown .md and other repo-relative links to the GitHub blob", () => {
    expect(rewriteHref("../README.md", slugs)).toBe(
      "https://github.com/bunsen-dev/bunsen/blob/main/README.md",
    );
    expect(rewriteHref("../packages/types", slugs)).toBe(
      "https://github.com/bunsen-dev/bunsen/blob/main/packages/types",
    );
  });
});

describe("docs discovery (reads the real docs/ tree)", () => {
  it("finds the canonical docs with titles", () => {
    const docs = getAllDocs();
    expect(docs.length).toBeGreaterThan(3);
    const slugs = docs.map((d) => d.slug);
    expect(slugs).toContain("scorers");
    expect(slugs).toContain("environment");
  });

  it("loads a doc's content by slug", () => {
    const doc = getDoc("scorers");
    expect(doc).not.toBeNull();
    expect(doc?.meta.title.toLowerCase()).toContain("scorer");
    expect(doc?.content).toContain("#");
  });

  it("returns null for an unknown slug", () => {
    expect(getDoc("does-not-exist")).toBeNull();
  });

  it("excludes DOCS_EXCLUDED files from the published set", () => {
    const files = docFiles();
    for (const ex of DOCS_EXCLUDED) {
      expect(files).not.toContain(ex);
    }
  });
});

describe("docs nav manifest ⟷ docs/ consistency", () => {
  const manifestFiles = DOCS_NAV.flatMap((g) => g.items.map((i) => i.file));

  it("lists every manifest file exactly once", () => {
    const seen = new Set<string>();
    for (const f of manifestFiles) {
      expect(seen.has(f), `duplicate nav entry: ${f}`).toBe(false);
      seen.add(f);
    }
  });

  it("covers every published doc, and references no missing/excluded file", () => {
    const onDisk = new Set(docFiles());
    const inNav = new Set(manifestFiles);
    const excluded = new Set(DOCS_EXCLUDED);

    // Every published doc must be in the nav (nothing silently falls out).
    for (const f of onDisk) {
      expect(inNav.has(f), `docs/${f} is not in DOCS_NAV (lib/docs-nav.ts)`).toBe(true);
    }
    // Every nav entry must exist on disk and not be excluded.
    for (const f of inNav) {
      expect(onDisk.has(f), `DOCS_NAV references docs/${f} which does not exist (or is excluded)`).toBe(true);
      expect(excluded.has(f), `DOCS_NAV references excluded file ${f}`).toBe(false);
    }
  });

  it("resolves nav groups to non-empty rendered items", () => {
    const groups = getNavGroups();
    expect(groups.length).toBe(DOCS_NAV.length);
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    expect(groups[0].group).toBe("Start Here");
    expect(groups[0].items[0].slug).toBe("introduction");
  });
});
