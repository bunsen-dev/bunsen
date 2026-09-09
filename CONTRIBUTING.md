# Contributing to Bunsen

Thanks for your interest in improving Bunsen! Contributions of all kinds are welcome — bug reports, fixes,
docs, new experiments, and features.

## License

Bunsen is open source under [Apache-2.0](./LICENSE).
By contributing, you agree that your contributions are licensed under Apache-2.0 (§5).
There is no Contributor License Agreement or DCO sign-off requirement.

## Development setup

Bunsen is a pnpm monorepo (Node ≥ 22, pnpm ≥ 8). Docker is required to actually run experiments.

```bash
pnpm install        # install workspace dependencies
pnpm build          # build all packages
pnpm test           # run the full test suite
pnpm typecheck      # type-check
pnpm lint           # lint
```

The `bn` CLI loads env files declared in `defaults.envFiles` of `bunsen.config.yaml` at startup, so put
your `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` in a local `.env` (gitignored). See the
[README](./README.md) and the docs under [`docs/`](./docs/) for architecture and usage.

## How we work

- **Add tests** alongside any change that adds or changes functionality.
- **Update docs** — README and the relevant files in `docs/` — when behavior changes.
- **Formatting** is handled by Prettier (`.prettierrc`); run `pnpm lint` before pushing.
- **Source headers:** owned source files carry an SPDX header
  (`SPDX-License-Identifier: Apache-2.0`). Run
  `node scripts/add-spdx-headers.mjs --apply` to tag new files (it's idempotent).
- **Coordination** happens through focused issues and PRs. Some development checkouts may include private
  planning folders, but contributors should not rely on them.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; explain the "why" in the PR description.
3. Make sure `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass.
4. A maintainer will review. Be patient — this is a small project.

## Community standards

All participation is covered by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting bugs / security

- **Bugs:** open a GitHub issue with steps to reproduce.
- **Security:** please do not file public issues for vulnerabilities; see [SECURITY.md](./SECURITY.md).
  Note Bunsen's trust model (running an experiment runs its author's code) — see
  [docs/TRUST_MODEL.md](./docs/TRUST_MODEL.md).
