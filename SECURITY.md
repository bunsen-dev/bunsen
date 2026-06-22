# Security Policy

## Reporting a vulnerability

Please **do not file public GitHub issues for security vulnerabilities.**

- **Preferred:** use GitHub's private vulnerability reporting — the **Security** tab of this repository →
  **"Report a vulnerability"**.
- **Email:** `security@bunsen.dev`.

Bunsen is maintained by one person; reports are handled on a best-effort basis. You'll normally get an
acknowledgment within a few days. Please include reproduction steps and the impact you believe the issue
has.

## Scope — read the trust model first

Bunsen's security boundary is documented in **[docs/TRUST_MODEL.md](./docs/TRUST_MODEL.md)**. The short
version: **running an experiment, agent, or suite means running its author's code on your machine**, and
the Docker container is a *reproducibility and accident boundary, not a security sandbox* — it has open
network egress and your provider API keys inside it.

That means the following are **by design, not vulnerabilities**:

- An agent or experiment doing arbitrary things *inside* its container (including network access and use
  of the API keys you passed in).
- Secrets being visible inside the container or in saved run directories/traces — there is no automatic
  redaction; scrub before sharing (see "Sharing runs safely" in the trust model).

The following **are** in scope and we want to hear about them:

- Experiment/agent/suite **content causing code execution on the host** (outside the container) beyond
  what the trust model documents.
- **Container escape** vectors introduced by Bunsen's own container configuration (beyond Docker's
  documented limits).
- Bunsen **writing secrets where the trust model says it doesn't** (e.g. auth headers into traces), or
  leaking them into artifacts the docs describe as shareable.
- Classic vulnerabilities in Bunsen's own code (path traversal, injection, etc.).

## Supported versions

Only the latest release / `main` branch receives security fixes.
