// Type surface for gen-skill-reference.mjs (consumed by the CLI test that
// asserts the generated skill references stay in sync with the schemas).

/** Build every reference: absolute output path → generated Markdown content. */
export function buildAll(): Map<string, string>;

/** Write every reference to disk. Returns the repo-relative paths written. */
export function writeAll(): string[];

/** Return the repo-relative paths of references that are stale or missing. */
export function checkAll(): string[];
