const fg = { color: "var(--fg)" } as const;

const rungs = [
  {
    name: "script",
    cost: "· $0",
    body: (
      <>
        Run the tests, grep the output — exit code is the score. Free,
        deterministic, and the gate that short-circuits everything below it.
      </>
    ),
  },
  {
    name: "judge",
    cost: "· ~$0.05",
    body: (
      <>
        One LLM call over the diff — or the logs, or the agent&apos;s own traces.
        A score with explicit reasoning.
      </>
    ),
  },
  {
    name: "agent",
    cost: "· ~$0.10+",
    body: (
      <>
        A tool-using loop: <span className="mono" style={fg}>run_command</span>,{" "}
        <span className="mono" style={fg}>read_file</span>, read the agent&apos;s
        trace turns. It explores, runs things, and cites what it found.
      </>
    ),
  },
  {
    name: "browser-agent",
    cost: "· ~$0.15+",
    body: (
      <>
        Drives a real Chromium via Playwright — clicks, screenshots, and verifies
        a built UI actually works.
      </>
    ),
  },
  {
    name: "aggregate",
    cost: "· $0",
    body: (
      <>
        Pure math over the other scores — all-pass gates, weighted means,
        min/max. No LLM call.
      </>
    ),
  },
];

export function DeepEvals() {
  return (
    <section className="band" id="evals">
      <div className="wrap">
        <div className="eyebrow">Deep evals</div>
        <h2 className="sec">Agentic evals that investigate — not just pass/fail.</h2>
        <p className="sec-lead">
          A traditional eval grades a fixed input → output. Bunsen grades the{" "}
          <strong style={fg}>agent</strong> — model, harness, and scaffolding —
          by giving it a real task and investigating the result. Its scorers
          run a spectrum: from $0 deterministic checks to AI agents that explore
          the workspace, drive a browser, and read the run&apos;s own traces,
          each citing its evidence.
        </p>

        <div className="ladder">
          {rungs.map((rung) => (
            <div className="rung" key={rung.name}>
              <div className="name">
                {rung.name} <span className="cost">{rung.cost}</span>
              </div>
              <p>{rung.body}</p>
            </div>
          ))}
        </div>
        <p className="gatecallout">
          Cheap checks gate the expensive ones — a{" "}
          <span className="mono">$0</span> script short-circuits a{" "}
          <span className="mono">$0.15</span> browser agent, so you only pay for
          judgment where it matters. Skipped is recorded as skipped, never a fake
          zero.
        </p>
      </div>
    </section>
  );
}
