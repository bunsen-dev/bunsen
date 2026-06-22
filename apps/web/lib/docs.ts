import "server-only";

import fs from "node:fs";
import path from "node:path";

import { REPO_SLUG } from "@/lib/site";
import { DOCS_NAV, DOCS_EXCLUDED, type NavGroup } from "@/lib/docs-nav";

/**
 * Build-time access to the repo-root `docs/*.md` files that back the in-app
 * `/docs` route. Everything here runs at build (SSG) — no runtime fs access.
 *
 * The set of published pages is `docs/*.md` minus `DOCS_EXCLUDED`; their
 * grouping/ordering/labels come from `DOCS_NAV` (see `lib/docs-nav.ts`).
 */

export type DocMeta = {
  /** URL slug, e.g. "scorers" (lowercased filename without extension). */
  slug: string;
  /** Source filename, e.g. "SCORERS.md". */
  file: string;
  /** First H1 in the file, e.g. "Bunsen Scorers". */
  title: string;
};

/**
 * Walk up from cwd to find the repo-root `docs/` dir (build runs from apps/web).
 * Lazy + memoized so the filesystem access happens at build time on demand, not
 * at module load — keeps it out of the route's runtime trace.
 */
let docsDirCache: string | null = null;
function hasMarkdown(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return false;
  }
}
function docsDir(): string {
  if (docsDirCache) return docsDirCache;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docs");
    if (hasMarkdown(candidate)) {
      docsDirCache = candidate;
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate a docs/ directory with markdown from ${process.cwd()}`);
}

export function fileToSlug(file: string): string {
  // Pretty kebab slugs decoupled from the on-disk filename casing: the docs use
  // a SCREAMING_SNAKE convention (EXPERIMENT_YAML.md) but the URL should read
  // /docs/experiment-yaml. Underscores → hyphens; `rewriteHref` applies the same
  // mapping so cross-doc `.md` links still resolve.
  return file
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/_/g, "-");
}

/** Pull the first `# Heading` out of a markdown string, stripping backticks. */
export function extractTitle(markdown: string, fallback: string): string {
  // Ignore `# ` lines inside fenced code blocks (e.g. shell comments) so a
  // leading code block can't masquerade as the title.
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "");
  const match = prose.match(/^#\s+(.+?)\s*$/m);
  if (!match) return fallback;
  return match[1].replace(/`/g, "").trim();
}

export type DocEntry = { meta: DocMeta; content: string };

// Read + parse every doc once; getAllDocs/getDoc/docSlugs all derive from this.
let entriesCache: DocEntry[] | null = null;
let metaCache: DocMeta[] | null = null;
let slugSetCache: Set<string> | null = null;

const excludedLower = new Set(DOCS_EXCLUDED.map((f) => f.toLowerCase()));

function loadDocs(): DocEntry[] {
  if (entriesCache) return entriesCache;
  const dir = docsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => !excludedLower.has(f.toLowerCase()));
  entriesCache = files
    .map((file) => {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      const meta: DocMeta = {
        slug: fileToSlug(file),
        file,
        title: extractTitle(content, file.replace(/\.md$/i, "")),
      };
      return { meta, content };
    })
    .sort((a, b) => a.meta.title.localeCompare(b.meta.title));
  return entriesCache;
}

export function getAllDocs(): DocMeta[] {
  metaCache ??= loadDocs().map((d) => d.meta);
  return metaCache;
}

export function getDoc(slug: string): DocEntry | null {
  return loadDocs().find((d) => d.meta.slug === slug) ?? null;
}

export function docSlugs(): Set<string> {
  slugSetCache ??= new Set(loadDocs().map((d) => d.meta.slug));
  return slugSetCache;
}

/** Source filenames of every published doc (excludes `DOCS_EXCLUDED`). */
export function docFiles(): string[] {
  return loadDocs().map((d) => d.meta.file);
}

export type NavGroupResolved = {
  group: string;
  blurb: string;
  items: { slug: string; title: string; file: string }[];
};

/**
 * Resolve `DOCS_NAV` against the docs actually present on disk: each manifest
 * entry becomes a `{ slug, title }` the sidebar/overview render. Entries whose
 * file is missing are dropped (the `docs.test.ts` guard fails the build before
 * that can happen in practice, but we stay defensive at render time).
 */
export function getNavGroups(): NavGroupResolved[] {
  const byFile = new Map(loadDocs().map((d) => [d.meta.file, d.meta]));
  return DOCS_NAV.map((g: NavGroup) => ({
    group: g.group,
    blurb: g.blurb,
    items: g.items
      .map((it) => {
        const meta = byFile.get(it.file);
        return meta ? { slug: meta.slug, title: it.title, file: it.file } : null;
      })
      .filter((x): x is { slug: string; title: string; file: string } => x !== null),
  })).filter((g) => g.items.length > 0);
}

const REPO_BLOB = `https://github.com/${REPO_SLUG}/blob/main`;

/**
 * Rewrite a link found inside a doc to something that resolves on the site:
 * - cross-doc `./SCORERS.md` / `ENVIRONMENT.md#gate` → `/docs/scorers[#gate]`
 * - any other repo-relative path (`../README.md`, `../packages/...`) → GitHub blob
 * - absolute http(s)/mailto/in-page anchors → unchanged
 */
export function rewriteHref(href: string | undefined, slugs: Set<string>): string {
  if (!href) return "#";
  if (/^(https?:|mailto:|#)/i.test(href)) return href;

  const [pathPart, hash] = href.split("#");
  const anchor = hash ? `#${hash}` : "";

  const mdMatch = pathPart.match(/([^/]+)\.md$/i);
  if (mdMatch) {
    // Same filename → slug mapping as fileToSlug (underscores → hyphens).
    const slug = mdMatch[1].toLowerCase().replace(/_/g, "-");
    if (slugs.has(slug)) return `/docs/${slug}${anchor}`;
  }

  const clean = pathPart.replace(/^(\.\.?\/)+/, "");
  return `${REPO_BLOB}/${clean}${anchor}`;
}
