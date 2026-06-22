---
name: Bug report
about: Something isn't working the way it should
title: "[bug] "
labels: bug
assignees: ""
---

## What happened

A clear description of the bug, and what you expected to happen instead.

## Reproduction

The exact command(s) you ran, ideally starting from a clean checkout:

```bash
bn run <experiment> <agent> ...
```

If it's tied to a specific run, include the run id and any relevant output from
`bn runs logs <run-id>` (scrub secrets and private workspace content first — see
[Trust & Safety](../../README.md#trust--safety)).

## Environment

- `bn` version (`bn --version`):
- OS / arch:
- Docker version (`docker --version`):
- `bn doctor` output (paste the summary, or note "all green"):
- Install method: `npm i -g @bunsen-dev/cli` / from-source checkout / `npx`

## Additional context

Anything else that helps — a minimal experiment/agent that reproduces it, a
screenshot from `bn runs open`, etc.
