#!/usr/bin/env node
// Publish the canonical JSON schemas at schemas.bunsen.dev.
//
// Copies packages/types/schemas/<name>.v1.json → apps/web/public/ so the
// landing-page deploy serves them as static assets at the site root (e.g.
// /experiment.v1.json). schemas.bunsen.dev is a plain domain alias of the same
// project, so https://schemas.bunsen.dev/experiment.v1.json resolves to the same
// file (no rewrite). The copies are generated (gitignored) — packages/types is
// the single source of truth, so the served bytes are the canonical bytes by
// construction; they cannot drift.
//
//   node scripts/sync-schemas.mjs            # copy into public/ (build/dev)
//   node scripts/sync-schemas.mjs --check    # CI guard: validate, copy nothing
//
// --check fails if any schema is missing, is invalid JSON, or has a $id that
// doesn't match its frozen URL (a schema change must become v2, never an in-place
// edit), and — if a served copy exists — that it byte-matches canonical.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAMES = ["project", "suite", "experiment", "agent"];
const HOST = "https://schemas.bunsen.dev";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", ".."); // apps/web/scripts → repo root
const SRC = path.join(repoRoot, "packages/types/schemas");
const DEST = path.join(here, "..", "public"); // served at the site root

const check = process.argv.includes("--check");
const problems = [];

for (const name of NAMES) {
  const file = `${name}.v1.json`;
  const srcPath = path.join(SRC, file);

  if (!fs.existsSync(srcPath)) {
    problems.push(`missing canonical schema: packages/types/schemas/${file}`);
    continue;
  }

  const raw = fs.readFileSync(srcPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    problems.push(`invalid JSON in ${file}: ${err.message}`);
    continue;
  }

  const expectedId = `${HOST}/${file}`;
  if (parsed.$id !== expectedId) {
    problems.push(`$id mismatch in ${file}: got ${JSON.stringify(parsed.$id)}, expected ${expectedId}`);
    continue;
  }

  if (check) {
    const destPath = path.join(DEST, file);
    if (fs.existsSync(destPath) && fs.readFileSync(destPath, "utf8") !== raw) {
      problems.push(`served copy drifted from canonical: public/${file}`);
    }
  } else {
    fs.mkdirSync(DEST, { recursive: true });
    fs.writeFileSync(path.join(DEST, file), raw);
  }
}

if (problems.length > 0) {
  console.error("schema sync FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  check
    ? `schema check OK — ${NAMES.length} schemas present, valid, $ids frozen at ${HOST}`
    : `synced ${NAMES.length} schemas → apps/web/public/`,
);
