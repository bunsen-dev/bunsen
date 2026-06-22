---
name: Experiment proposal
about: Propose a new experiment (or suite task) for inclusion
title: "[experiment] "
labels: experiment
assignees: ""
---

> New to authoring experiments? Start with
> [docs/BRING_YOUR_OWN_TASK.md](../../docs/BRING_YOUR_OWN_TASK.md) and
> [docs/SCORERS.md](../../docs/SCORERS.md). For a whole external benchmark, see
> [docs/SUITES.md](../../docs/SUITES.md) — suites usually live in their own repo
> and are consumed via `bn suites add`, not added here.

## What does this experiment test?

The capability or failure mode you want to measure, and why it's worth a slot.
What separates a passing agent from a failing one?

## Task shape

- **Category:** bug-fix / zero-to-one / sysadmin / security / ML / web / other
- **Starting workspace:** synthetic, real PR checkout, or seeded artifact?
- **Difficulty / expected runtime:**

## Evaluation

How should a run be scored? Prefer deterministic `script` criteria where
possible; note where an LLM `judge`/`agent` scorer is genuinely needed.

```yaml
# rough sketch of evaluation.criteria
```

## Reproducibility & cost

- Any heavy setup that should be prebuilt into the image and seeded via
  `workspace.sources` rather than run live?
- External services, large downloads, or non-deterministic dependencies?
- Does scoring require an API key, or is it code-only?

## Licensing

Confirm the task content (and any seeded code/data) is yours to contribute, or
note its upstream source and license so we can attribute it correctly.
