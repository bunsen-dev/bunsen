# Trust Model

**Running an experiment, agent, or suite means running its author's code on your machine.**

Bunsen's whole job is to take an environment and an agent, put them together, let the agent loose, and
capture what happens. That is inherently the execution of code you did not write — the agent's code, the
experiment author's setup and scoring code, and whatever the agent itself decides to do at runtime. Bunsen
runs that code in a Docker container, but the container is an **accepted trust boundary, not a security
sandbox**. This document is honest about where code runs, what the container does and does not isolate, and
what a saved run can leak — so you can decide what you're comfortable running and what's safe to share.

The maintainer's stance is explicit: **Bunsen will not try to make local LLM/agent execution 100% safe, and
does not claim to.** Treat it the way you'd treat `git clone && make` on an unfamiliar repo, or `npx
some-package` — *use at your own risk, within legal bounds.* Run things you trust, or run untrusted things on
a machine you're willing to lose.

## Where code executes

### Inside the container

When you `bn run`, the following all execute inside the run's Docker container:

- **The agent under test.** Whatever the agent's `entrypoint` invokes, plus everything the agent does at
  runtime (writes files, runs shell commands, makes network calls). This is the point of the tool.
- **`workspace.setup` and `install.*` steps.** `experiment.yaml`'s `workspace.setup[]`, and an agent's
  `install.deps` / `install.build` / `install.configure`, are author-supplied shell commands run during
  image prep and run setup.
- **Dockerfiles.** Experiments may ship a `Dockerfile` (see [The Environment Model](./ENVIRONMENT.md)).
  Building it runs arbitrary author-controlled build steps.
- **Script criteria and verifiers.** A `script` criterion's `run:` command, plus anything under the
  experiment's `verifiers/` directory, executes during evaluation. By default scorers run in a **separate
  scorer container**; with `evaluation.container: agent` they run in the agent's own container. Either way
  this is author code — same trust posture as the agent under test. See
  [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md) and [Scorers & Evaluation](./SCORERS.md).

### On the host (outside any container)

A few things run on your host machine, not in a container. These matter more because the host has no
container boundary at all:

- **Agent-source resolution.** Loading an agent from a `git`, `npm`, or `binary` source shells out on the
  host to fetch it. This path is hardened so author-controlled strings can't be turned into host command
  execution, and npm install scripts are disabled (`--ignore-scripts`) — but it still runs `git`/`npm`/`curl`
  on your host, so only resolve agents from sources you trust.
- **`bn runs export`.** Extracting a workspace writes/reads a tar archive and applies a patch on the host.
- **Container Node runtime fetch.** For a custom / non-bunsen base image, Bunsen fetches its own Node
  binary on first use (cached per-user), then mounts it **read-only** at `/bunsen/runtime/node`. The
  download is gated on a sha256 pinned in the repo (`node-runtime-manifest.json`, anchored to nodejs.org's
  signed `SHASUMS256.txt`), so you get exactly the audited bytes or a hard failure — a malicious agent can't
  swap the platform-tool runtime, and the URL is https-pinned. Set `BUNSEN_NODE_OFFLINE=1` to forbid the
  fetch entirely (reproducible / air-gapped), or pre-seed it with `BUNSEN_NODE_RUNTIME_DIR`.

## The real container posture

The container provides *isolation of the filesystem and process namespace by default* — that's real, and
there is **no known escape vector**: no `--privileged`, no Docker-socket mount, no added Linux capabilities
(`CapAdd`), the agent runs as the **non-root `bunsen` user** by default (experiments opt into root with
`environment.user: root`), and workspace/output mounts are read-only or read-write exactly as intended.

What the container does **not** do — and why "sandbox" oversells it:

| Aspect | Reality |
|--------|---------|
| Linux capabilities | Docker's **default** capability set. No extra `CapDrop`. |
| Privilege escalation | `no-new-privileges` **is** set, so a non-root process can't escalate via setuid/setgid binaries. Tasks that need root should run as root (`environment.user: root`) rather than `sudo` from the non-root user. |
| Seccomp | Docker's **default** profile only. No custom hardening profile. |
| Resource limits | **None.** No memory, CPU, or PID limits — a runaway agent can exhaust host resources. |
| Network egress | **Open.** The agent container is on the default bridge network with full outbound internet, plus a `host.docker.internal` host-gateway entry pointing back at your host. |
| Secrets | **Your real provider API keys are injected into the agent container** by default (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` via `defaults.passEnv`). The agent under test — and any code it runs — can read them and exfiltrate them over the open network. |

Net: the container stops accidental host-filesystem damage and keeps runs reproducible. It does **not**
contain a deliberately hostile agent that wants to phone home, mine your keys, or burn your CPU. If that's a
concern, run on a disposable/throwaway host or VM and pass only throwaway API keys.

### Hardening you can apply yourself

- Run on a disposable VM or a machine you don't mind reimaging.
- Use scoped, low-limit, revocable API keys rather than your primary ones, and trim `defaults.passEnv` so
  you don't inject keys an experiment doesn't need into the agent container.
- For agent build steps that don't need the network, set `network: none` so those steps run
  with no outbound access. See [The Environment Model](./ENVIRONMENT.md) and
  [experiment.yaml Reference](./EXPERIMENT_YAML.md) for where this is configured.

> **Platform agents vs. the agent under test.** The orchestrator, supervisor, and scorer (the *platform
> agents*) make their own model calls using a separate `BUNSEN_ANTHROPIC_API_KEY`, distinct from the
> provider keys passed to the agent under test via `defaults.passEnv`. Scoping each independently lets you,
> for example, give the agent under test only a throwaway key while keeping the evaluation key elsewhere.

## Sharing runs safely

**A run directory (`.bunsen/runs/<id>/`) can contain secrets and full prompt/workspace content. Scrub
before you share one.**

What's in a run dir and what it can leak:

- **`agent-script.sh` / `launcher.sh`** hold your plaintext API keys as `export KEY="value"` lines. Bunsen
  scrubs these from the run dir on normal completion **and** synchronously on Ctrl-C / `SIGTERM`, so a
  cleanly finished or canceled run shouldn't contain them. A hard kill (`SIGKILL`) or power loss can still
  leave them behind — check before sharing.
- **`logs.txt`, `artifacts/recording.cast` (raw terminal bytes), and `orchestration/result.json`** capture
  whatever the agent printed and received. If a key was passed on the agent's command line, or the agent
  echoed a secret, it lands here. These are **not** scrubbed.
- **There is no automatic redaction.** Review and scrub a run dir manually before publishing or attaching it
  to a bug report.

### Scrubbing a run directory before sharing

There's no one-button redactor, so do a manual pass over `.bunsen/runs/<id>/` first:

```bash
# 1. Confirm the secret-bearing launch scripts are gone (they should be, after a clean run).
ls .bunsen/runs/<id>/agent-script.sh .bunsen/runs/<id>/launcher.sh 2>/dev/null

# 2. Grep the run dir for anything that looks like a key before you share it.
grep -rIn -E 'sk-|api[_-]?key|ANTHROPIC|OPENAI|GEMINI|Authorization' .bunsen/runs/<id>/

# 3. Delete or edit any file that contains a secret — typically logs.txt,
#    artifacts/recording.cast, traces/agent.jsonl, and orchestration/result.json.
```

Pay special attention to `logs.txt`, the terminal recording, and the captured traces, since those reflect
exactly what the agent printed and exchanged with the model. See
[Run Manifest & Events](./RUN_MANIFEST.md) for the full layout of a run directory.

## AI traces: bodies are captured, auth headers are not

Captured AI traces (`traces/agent.jsonl`) persist the **full request and response bodies** of every model
call the trace-capture proxy sees: prompts, system prompts, tool definitions, and model output. Bodies are
normalized across providers so traces have a consistent shape regardless of which model the agent under test
called. They do **not** contain auth headers — the proxy reads request headers only to route the call and
never serializes them into the trace, so `x-api-key` / `Authorization` never hit disk.

Practical consequence: a trace **will not leak your API key**, but it **will leak prompt and workspace
content** — anything the agent sent to or received from the model, which routinely includes file contents,
task details, and intermediate reasoning. Treat traces as sensitive payload data, not as credentials. See
[Run Manifest & Events](./RUN_MANIFEST.md) for where traces live in a run directory.

## Summary

- Running an experiment/agent/suite = running its author's code.
- The container is a reproducibility and accident boundary, **not** a security sandbox: default caps/seccomp,
  no resource limits, open egress, your keys inside.
- No known escape vector, non-root by default — but a hostile agent inside the container can still exfiltrate
  keys and data over the open network.
- Run dirs and traces can contain secrets and full prompt/workspace content; there is no automatic
  redaction, so scrub manually before sharing.
- For untrusted code, use a disposable host and throwaway, scoped API keys.
