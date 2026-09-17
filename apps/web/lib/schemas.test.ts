import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The schemas published at schemas.bunsen.dev are served straight from
// packages/types/schemas (see scripts/sync-schemas.mjs). Their $ids are frozen —
// the URL never changes; pre-1.0 the v1 schema may still be tightened in place
// (called out in CHANGELOG), and a change needing a new $id becomes v2 — so this
// guards the same invariant the CI `check:schemas` job enforces.
const NAMES = ["project", "suite", "experiment", "agent"];

function canonical(name: string): { $id?: string } {
  const url = new URL(`../../../packages/types/schemas/${name}.v1.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("published JSON schemas", () => {
  for (const name of NAMES) {
    it(`${name}.v1.json has its frozen schemas.bunsen.dev $id`, () => {
      expect(canonical(name).$id).toBe(`https://schemas.bunsen.dev/${name}.v1.json`);
    });
  }
});
