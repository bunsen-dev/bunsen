# Scoring Service Tasks

A *service task* asks the agent under test to start something that keeps running — an HTTP
server, a daemon, a database — and then scores whether that service is reachable. When you
score inside the agent's container (`evaluation.container: agent`), the scorer runs *after*
the agent finishes. The open question for service tasks is: does the service the agent
started survive long enough for the scorer to test it?

The short answer: it depends on **how the agent backgrounded the process** and **which agent
you ran**. This page gives you the rules and a per-agent reference so you can author service
tasks that score reliably.

See also: [Scoring in the Agent Container](./AGENT_CONTAINER_SCORING.md) for the
`evaluation.container: agent` model in general, and [Scorers & Evaluation](./SCORERS.md) for
authoring criteria.

## Per-agent reference

Different agent frameworks make different choices about how to clean up the processes their
tool calls spawn. This produces different observable behavior on identical service tasks,
even though the surrounding container architecture is the same. Use this table when
authoring service tasks and when interpreting cross-agent scores.

| Pattern | Codex CLI | Claude Code | Claude Agent SDK |
|---|---|---|---|
| `python server.py` (foreground) | Killed by tool-call timeout | Killed by tool-call timeout | Killed by tool-call timeout |
| `python server.py &` | Killed at tool-call return | Survives — orphaned to tini | Survives between tool calls; killed when the agent loop returns |
| `nohup python server.py &` | Killed at tool-call return (nohup does not help) | Survives — orphaned to tini | Same as Claude Code, then killed when the agent loop returns |
| `setsid python server.py &` | Survives — fresh process group | Survives | Survives — fresh session escapes cleanup |
| `nginx` / `sshd` / `--daemon` flag | Survives — daemon detaches itself | Survives | Survives |
| Claude Code's `run_in_background: true` | n/a | Survives between tool calls; killed at agent exit (use the `disable-background-tasks` variant to keep alive) | Killed when the agent loop returns; no escape hatch |

The most portable way for an agent to leave a service running is to fully detach it — a real
daemon flag, `setsid`, a process manager, or `systemd`. Plain `&` and `nohup ... &` are
enough for Claude Code but not for Codex CLI.

### Codex CLI: aggressive per-tool-call cleanup

Codex CLI cleans up at **every tool-call return**, not just at agent exit. Each shell tool
call runs in its own process group, and on tool-call timeout, cancellation, or completion
codex kills that whole group. The observable consequence:

- A child launched with `&` or `nohup ... &` is in the same process group as the calling
  shell, so codex takes it down — even between tool calls, before the agent has finished.
- A child that detaches into its own session (typically system daemons like nginx, sshd, or
  postgres, or anything launched with a `--daemon` flag) ends up in a fresh process group
  that codex never tracked, and survives.

Codex's session-based long-running-process tool does not change this — its sessions are
terminated when the agent exits.

### Claude Code: framework-managed background tasks, otherwise permissive

Claude Code's regular bash tool only signals the immediate child on completion. Anything
backgrounded with `&` orphans cleanly to `tini` and survives both between tool calls and
past agent exit. Most agent code that uses `python server.py & sleep 1` works fine.

The exception is its `Bash` tool's `run_in_background: true` parameter — a tracked-task
abstraction that Claude Code explicitly cleans up at session end. For service tasks where
`run_in_background: true` gets used, run the agent with the `disable-background-tasks`
variant so the cleanup path is skipped and tracked background tasks survive past agent exit:

```bash
bn run my-service-task claude-code:disable-background-tasks
```

This variant sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. See
[CLI Reference](./CLI.md) for the `<agent>[:variant]` syntax and
[System Prompts & Agent Config Files](./SYSTEM_PROMPTS.md) for how variants are declared.

### Claude Agent SDK: the strict version of Claude Code

The SDK agent runs the same `claude` binary, but its bundled CLI does not include the
`disable-background-tasks` code path. When the agent loop finishes, the SDK terminates the
CLI subprocess, which propagates and kills any background children. Plain `&` shell
backgrounding still survives between tool calls (same bash semantics as the raw CLI), but
everything dies when the agent loop returns. There is no escape-hatch variant — service
tasks where the daemon must outlive the agent should use `claude-code:disable-background-tasks`
instead.

## Why backgrounding behaves this way

Bunsen's agent container runs with Docker's `--init` flag, which makes `tini` PID 1. Each
agent tool call is a separate `docker exec` session:

```
PID 1: tini (via Docker --init)
  └─ PID 2: bash -c "sleep infinity"

Agent runs via: docker exec <container> bash -c "<agent-script>"
  └─ Creates a new process tree inside the container
  └─ When the exec session ends, orphaned children are reparented to tini (PID 1)
```

When an agent backgrounds a process and its tool call ends:

1. Bash forks the process into the background, then exits.
2. The process is orphaned and reparented to tini (PID 1).
3. Docker does **not** send signals to child processes when an exec session finishes.
4. Tini keeps the orphan alive, and subsequent `docker exec` sessions (scorers) can reach it.

That is why plain shell backgrounding survives under Claude Code. The cases that *don't*
survive are the ones where the agent framework actively tracks and kills the process — either
at tool-call return (Codex CLI's process-group kill) or at agent exit (Claude Code's managed
background tasks, the SDK's subprocess termination). This is the agent framework cleaning up
after itself, not a Docker behavior.

`--init` also matters for hygiene: without tini, the container's PID 1 is
`bash -c "sleep infinity"`, which adopts orphans but does not properly reap zombies, so they
accumulate over many exec sessions.

## Treat process survival as agent signal

Process survival is **agent behavior**, not platform behavior. The task says
"Create and run a server on port 3000." A competent agent should leave the server running in a
way that persists — using `setsid`, a daemon flag, a process manager, or `systemd`. An agent
that leans on a framework-managed background task (which gets cleaned up on exit) has failed
to properly daemonize the service.

That difference is meaningful benchmark signal:

- An agent that detaches its server demonstrates it can create persistent services.
- An agent whose server dies on exit demonstrates a gap in its understanding of process
  persistence.
- Different agents — or the same agent with different prompting — handle this differently, and
  that is exactly what a benchmark should measure.

Report service-task scores honestly under each agent and let the per-task pattern surface the
difference. Avoid papering over it with prompt hints or auto-daemonize wrappers in the task —
both bias the comparison.

This mirrors the "test after the agent exits" model used by suites like Terminal Bench, which
makes the same trade-off: if an agent backgrounds a process that dies on exit, the post-exit
tests fail for the same reason. It is a shared constraint of that model, not a Bunsen-specific
limitation.

## Implications for experiment design

**Package / filesystem tasks** — use `evaluation.container: agent` confidently. Installed
packages and system files are preserved, and these are the primary use case.

**Service tasks** — use `evaluation.container: agent` and accept that scores will vary based
on the agent's daemonization approach. This is valid benchmark signal. If you need consistent
pass/fail regardless of agent behavior, have a `script` criterion start the service explicitly
before checking it — but understand that this masks real agent capability differences.

When the service relies on a tracked background task under Claude Code, prefer running the
`claude-code:disable-background-tasks` variant over rewriting the task.

See also: [experiment.yaml Reference](./EXPERIMENT_YAML.md) for `evaluation.container` and
criterion authoring, and [Suites](./SUITES.md) for running tasks across agents.
