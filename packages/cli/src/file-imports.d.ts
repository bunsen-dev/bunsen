// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// Bun's `import … with { type: 'file' }` yields the path to an embedded file
// (a real path on disk in dev, a handle into the binary's virtual FS under
// `bun build --compile`). The standalone-binary entrypoint imports the asset
// tarball this way; declare the shape so `tsc` accepts it without resolving the
// build-time artifact.
declare module '*.tar' {
  const path: string;
  export default path;
}
