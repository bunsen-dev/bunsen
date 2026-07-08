// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Package entry for `@bunsen-dev/agents`.
 *
 * The platform agents that run **inside containers** (scorer, supervisor,
 * gitignore-filter, proxy-bootstrap) are shipped as self-contained `.cjs`
 * bundles built directly from their `src/<name>/standalone.ts` entrypoints (see
 * `scripts/build-bundles.mjs`) — they are NOT imported through this entry.
 *
 * This entry exposes the one piece of `@bunsen-dev/agents` meant to be imported
 * as a normal module by host-side code (the CLI): the authoring-time
 * `entrypoint.invoke` scaffolder. It is inlined into the `bn` binary rather than
 * bundled into a container image.
 */

export {
  scaffoldInvokeTemplate,
  validateInvokeTemplate,
  scaffoldBasis,
  buildScaffoldSystemPrompt,
  buildScaffoldUserPrompt,
  DEFAULT_SCAFFOLD_MODEL,
  type ScaffoldInvokeInput,
  type ScaffoldInvokeResult,
  type ScaffoldBasis,
} from './scaffolder/scaffold.js';
