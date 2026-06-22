#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Generate the `reference/*.md` field references bundled inside the Bunsen
 * authoring skills (`packages/cli/assets/skills/<skill>/reference/`).
 *
 * Why this exists — anti-staleness. The SKILL.md bodies stay *procedural* and
 * defer all field-name truth to these generated references, which are derived
 * directly from the JSON Schemas in `@bunsen-dev/types` (`packages/types/schemas/`).
 * Because the schemas are the same files `bn … validate` enforces, the
 * references cannot drift from the validator: a schema change that is not
 * accompanied by a regeneration is caught by `--check` (wired into the CLI
 * build, so the published artifact can never ship a stale reference).
 *
 * Output is a deterministic, fully-generic walk of the schema (every reachable
 * `$def` is rendered), so ANY field/enum/pattern change surfaces in the diff —
 * nothing is hand-curated, nothing can be silently missed.
 *
 *   node scripts/gen-skill-reference.mjs           # (re)write the references
 *   node scripts/gen-skill-reference.mjs --check    # exit 1 if any is stale
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const schemasDir = path.join(repoRoot, 'packages/types/schemas');
const skillsDir = path.join(repoRoot, 'packages/cli/assets/skills');

/**
 * Which references to emit. Each entry renders one schema (optionally rooted at
 * a `$def`, to scope a focused slice) into one skill's `reference/` directory.
 */
const REFERENCES = [
  {
    schemaId: 'experiment.v1',
    out: 'bunsen-new-experiment/reference/experiment-schema.md',
    title: 'experiment.yaml — field reference (v1)',
    rootName: 'experiment.yaml (top level)',
  },
  {
    schemaId: 'experiment.v1',
    out: 'bunsen-author-scorer/reference/criteria-schema.md',
    title: 'Evaluation criteria — field reference (v1)',
    rootRef: '#/$defs/evaluation',
    rootName: 'evaluation',
  },
  {
    schemaId: 'agent.v1',
    out: 'bunsen-new-agent/reference/agent-schema.md',
    title: 'agent.yaml — field reference (v1)',
    rootName: 'agent.yaml (top level)',
  },
];

// ---------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------

function readSchema(id) {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, `${id}.json`), 'utf8'));
}

function refName(ref) {
  return ref.split('/').pop();
}

function resolveLocalRef(schema, ref) {
  const parts = ref.replace(/^#\//, '').split('/');
  let node = schema;
  for (const part of parts) node = node?.[part];
  return node;
}

/** A short inline type descriptor for a property value or union member. */
function typeRef(node, enqueue) {
  if (!node || typeof node !== 'object') return 'any';
  if (node.$ref) {
    const name = refName(node.$ref);
    enqueue(name);
    return `\`${name}\``;
  }
  if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``;
  if (node.enum) return node.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' | ');
  if (node.oneOf) return node.oneOf.map((m) => unionMemberRef(m, enqueue)).join(' | ');
  if (node.anyOf) return node.anyOf.map((m) => unionMemberRef(m, enqueue)).join(' | ');
  const t = node.type;
  if (t === 'array') return `array of ${typeRef(node.items, enqueue)}`;
  if (t === 'object') {
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      const key = node.propertyNames ? keyTypeRef(node.propertyNames, enqueue) : 'string';
      return `map<${key}, ${typeRef(node.additionalProperties, enqueue)}>`;
    }
    return 'object';
  }
  if (Array.isArray(t)) return t.join(' | ');
  if (node.pattern) return 'string';
  return t || 'object';
}

function keyTypeRef(node, enqueue) {
  if (node.$ref) {
    enqueue(refName(node.$ref));
    return `\`${refName(node.$ref)}\``;
  }
  if (node.enum) return node.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' | ');
  return 'string';
}

function unionMemberRef(member, enqueue) {
  if (!member || typeof member !== 'object') return 'any';
  if (member.$ref) {
    enqueue(refName(member.$ref));
    return `\`${refName(member.$ref)}\``;
  }
  if (member.type === 'array') return `array of ${typeRef(member.items, enqueue)}`;
  if (member.type === 'object' && member.properties) {
    return `object { ${Object.keys(member.properties).join(', ')} }`;
  }
  return typeRef(member, enqueue);
}

/** Constraint notes (pattern/min/max/default) for a property value. */
function constraintNotes(node) {
  const notes = [];
  if (!node || typeof node !== 'object') return notes;
  if (node.pattern) notes.push(`pattern \`${node.pattern}\``);
  if (node.minLength != null) notes.push(`minLength ${node.minLength}`);
  if (node.maxLength != null) notes.push(`maxLength ${node.maxLength}`);
  if (node.minimum != null) notes.push(`min ${node.minimum}`);
  if (node.maximum != null) notes.push(`max ${node.maximum}`);
  if (node.minItems != null) notes.push(`minItems ${node.minItems}`);
  if (node.default !== undefined) notes.push(`default \`${JSON.stringify(node.default)}\``);
  return notes;
}

/** Render an object node's properties as a (possibly nested) bullet list. */
function renderProps(objNode, enqueue, indent) {
  const lines = [];
  const required = new Set(objNode.required || []);
  const props = objNode.properties || {};
  for (const [key, value] of Object.entries(props)) {
    const pad = '  '.repeat(indent);
    const reqMark = required.has(key) ? ' **(required)**' : '';
    const type = typeRef(value, enqueue);
    const notes = constraintNotes(value);
    const noteStr = notes.length ? ` — ${notes.join(', ')}` : '';
    lines.push(`${pad}- \`${key}\`: ${type}${reqMark}${noteStr}`);
    // Expand inline (non-$ref) nested objects so their fields are visible.
    if (value && value.type === 'object' && value.properties && !value.$ref) {
      lines.push(...renderProps(value, enqueue, indent + 1));
    }
    if (
      value &&
      value.type === 'array' &&
      value.items &&
      value.items.type === 'object' &&
      value.items.properties &&
      !value.items.$ref
    ) {
      lines.push(...renderProps(value.items, enqueue, indent + 1));
    }
  }
  if (objNode.additionalProperties === false) {
    lines.push(`${'  '.repeat(indent)}- _no other fields allowed_`);
  }
  return lines;
}

function isRequiredGroup(member) {
  const keys = Object.keys(member);
  return keys.length === 1 && keys[0] === 'required' && Array.isArray(member.required);
}

/** Render one named section (a `$def` or the root) as Markdown. */
function renderSection(name, node, schema, enqueue) {
  const lines = [`## ${name}`, ''];

  // Merge allOf members into a single object view.
  let view = node;
  if (node.allOf) {
    view = { type: 'object', required: [], properties: {} };
    const extendsNames = [];
    for (const member of node.allOf) {
      let resolved = member;
      if (member.$ref) {
        extendsNames.push(refName(member.$ref));
        enqueue(refName(member.$ref));
        resolved = resolveLocalRef(schema, member.$ref);
      }
      if (resolved.required) view.required.push(...resolved.required);
      if (resolved.properties) Object.assign(view.properties, resolved.properties);
      if (resolved.additionalProperties !== undefined) {
        view.additionalProperties = resolved.additionalProperties;
      }
    }
    if (extendsNames.length) {
      lines.push(`_Extends ${extendsNames.map((e) => `\`${e}\``).join(', ')}._`, '');
    }
  }

  const hasProps = view.properties && Object.keys(view.properties).length > 0;

  if (hasProps) {
    lines.push(...renderProps(view, enqueue, 0));
    if (Array.isArray(view.oneOf) && view.oneOf.every(isRequiredGroup)) {
      const groups = view.oneOf
        .map((m) => m.required.map((f) => `\`${f}\``).join(' + '))
        .join('  —or—  ');
      lines.push('', `Requires exactly one of: ${groups}.`);
    }
  } else if (Array.isArray(node.oneOf)) {
    lines.push('One of:');
    for (const member of node.oneOf) {
      lines.push(`- ${unionMemberRef(member, enqueue)}`);
    }
  } else if (node.type === 'array') {
    lines.push(`Array of ${typeRef(node.items, enqueue)}.`);
  } else if (node.enum) {
    lines.push(`String, one of: ${node.enum.map((v) => `\`${JSON.stringify(v)}\``).join(', ')}.`);
  } else {
    const notes = constraintNotes(node);
    const typ = node.type || 'value';
    lines.push(`${typ}${notes.length ? ` — ${notes.join(', ')}` : ''}.`);
  }

  lines.push('');
  return lines.join('\n');
}

/** Build the full Markdown reference for one REFERENCES entry. */
function buildReference(entry) {
  const schema = readSchema(entry.schemaId);
  const rootNode = entry.rootRef ? resolveLocalRef(schema, entry.rootRef) : schema;
  const rootName = entry.rootName;

  // BFS over $ref to find every reachable $def, but RENDER them in $defs file
  // order (filtered to the reachable set) for stable diffs.
  const reachable = new Set();
  const queue = [];
  const enqueue = (defName) => {
    if (!reachable.has(defName)) {
      reachable.add(defName);
      queue.push(defName);
    }
  };

  const sections = [renderSection(rootName, rootNode, schema, enqueue)];
  while (queue.length) {
    const defName = queue.shift();
    const defNode = schema.$defs?.[defName];
    if (!defNode) continue;
    renderSection(defName, defNode, schema, enqueue); // walk to enqueue deeper refs
  }

  const defOrder = Object.keys(schema.$defs || {}).filter((n) => reachable.has(n));
  const defSections = defOrder.map((n) => renderSection(n, schema.$defs[n], schema, enqueue));

  const header = [
    `<!-- Generated from https://schemas.bunsen.dev/${entry.schemaId}.json — do not edit by hand. -->`,
    '',
    `# ${entry.title}`,
    '',
    'Authoritative field list, generated from the JSON Schema your installed `bn` ships.',
    '`bn experiments validate` / `bn agents validate` is the oracle: if anything here',
    'disagrees with what `bn … validate` accepts, trust `bn`.',
    '',
    'Notation: `` `name`: type `` lists a field; **(required)** marks required fields;',
    'a `` `name` `` type links to its definition section below.',
    '',
  ].join('\n');

  return `${header}\n${[...sections, ...defSections].join('\n')}`.replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------------------
// Public surface (also imported by tests + the CLI build guard)
// ---------------------------------------------------------------------------

/** Returns a Map of absolute-path → generated content for every reference. */
export function buildAll() {
  const out = new Map();
  for (const entry of REFERENCES) {
    out.set(path.join(skillsDir, entry.out), buildReference(entry));
  }
  return out;
}

/** Write every reference to disk (creating reference/ dirs as needed). */
export function writeAll() {
  const built = buildAll();
  const written = [];
  for (const [filePath, content] of built) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    written.push(path.relative(repoRoot, filePath));
  }
  return written;
}

/** Returns the list of references that are stale or missing on disk. */
export function checkAll() {
  const built = buildAll();
  const stale = [];
  for (const [filePath, content] of built) {
    let current = null;
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch {
      /* missing */
    }
    if (current !== content) stale.push(path.relative(repoRoot, filePath));
  }
  return stale;
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const check = process.argv.includes('--check');
  if (check) {
    const stale = checkAll();
    if (stale.length) {
      console.error('✗ Skill reference is stale (schema changed without regeneration):');
      for (const f of stale) console.error(`    ${f}`);
      console.error('\n  Run `pnpm gen:skill-reference` and commit the result.');
      process.exit(1);
    }
    console.log('✓ Skill references are up to date.');
  } else {
    const written = writeAll();
    console.log(`✓ Wrote ${written.length} skill reference file(s):`);
    for (const f of written) console.log(`    ${f}`);
  }
}
