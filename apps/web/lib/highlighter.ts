import "server-only";

import { createHighlighter, type Highlighter } from "shiki";

/**
 * A single Shiki highlighter, created once at build time. react-markdown renders
 * synchronously, so we resolve this promise in the (async) docs page and hand the
 * ready highlighter to the Markdown component, whose `pre` renderer calls the
 * synchronous `codeToHtml`. Output is plain HTML + inline styles — zero client JS.
 */

const THEME = "github-dark";

// Languages actually used across docs/*.md (see `grep '^```' docs/*.md`), plus a
// couple of common extras. Unloaded languages fall back to plain text.
const LANGS = [
  "yaml",
  "bash",
  "json",
  "typescript",
  "javascript",
  "python",
  "markdown",
  "diff",
] as const;

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  yml: "yaml",
  py: "python",
  md: "markdown",
};

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: [...LANGS] });
  return highlighterPromise;
}

// The loaded set is fixed once the (singleton) highlighter resolves, so compute
// it once rather than on every fenced block.
let loadedLangs: Set<string> | null = null;

/** Synchronously highlight a fenced block; unknown languages render as plain text. */
export function highlight(hl: Highlighter, code: string, lang?: string): string {
  loadedLangs ??= new Set(hl.getLoadedLanguages());
  let resolved = lang ? (ALIASES[lang] ?? lang) : "text";
  if (resolved !== "text" && !loadedLangs.has(resolved)) resolved = "text";
  return hl.codeToHtml(code, { lang: resolved, theme: THEME });
}
