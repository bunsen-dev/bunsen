import { rubricYaml } from "@/components/code-blocks";

const fg = { color: "var(--fg)" } as const;

// The scorer ladder — the vocabulary the rubric above draws from. Cost lives only
// on the at-scale matrix (Act 1), not here, so these are framed by what they do.
const rungs = [
  {
    name: "script",
    body: (
      <>
        Run the tests, grep the output — anything you can do in code; the exit
        code is the score. Deterministic, and the gate that short-circuits
        everything below it.
      </>
    ),
  },
  {
    name: "judge",
    body: (
      <>
        One LLM call over the diff — or the logs, or the agent&apos;s own traces.
        A score with explicit reasoning.
      </>
    ),
  },
  {
    name: "agent",
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
    body: (
      <>
        Drives a real Chromium via Playwright — clicks, screenshots, and verifies
        a built UI actually works.
      </>
    ),
  },
  {
    name: "aggregate",
    body: (
      <>
        Pure math over the other scores — all-pass gates, weighted means,
        min/max. No LLM call.
      </>
    ),
  },
];

// Act 2 (depth): how expressive the eval system is. One real rubric where each
// criterion is a different kind of scorer, then the ladder it draws from, then the
// gating story. Grades the agent by investigating the result, not asserting a fixed output.
export function DeepByDefault() {
  return (
    <section className="band" id="deep">
      <div className="wrap">
        <div className="eyebrow">Agentic scoring</div>
        <h2 className="sec">Deep by default.</h2>
        <p className="sec-lead">
          <strong style={fg}>
            Agentic scorers — agents that investigate and evaluate the artifacts
            produced by a task — are the heart of Bunsen&apos;s eval system.
          </strong>{" "}
          Bunsen grades the agent by giving it a real task and digging into what
          it produced. Scorers run a spectrum: from deterministic checks to AI
          agents that explore the workspace, drive a browser, and read the
          run&apos;s own traces, each citing its evidence. Because agentic
          scorers are expensive, Bunsen lets you gate them behind{" "}
          <span className="mono">$0</span> script scorers — paying for deep
          judgment only where it&apos;s warranted.
        </p>

        <div className="stepc first">
          <div className="hd">
            <div className="num">one rubric · five kinds of scorer</div>
            <h3>The gcal-clone rubric</h3>
            <p>
              A gate, an <strong style={fg}>agent</strong> that audits the code
              for security holes, two browser-agents — one drags an event, one
              checks the layout across breakpoints — and a math roll-up. One
              folder; a whole eval stack.
            </p>
          </div>
          {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
          <pre dangerouslySetInnerHTML={{ __html: rubricYaml }} />
        </div>

        <div className="ladder">
          {rungs.map((rung) => (
            <div className="rung" key={rung.name}>
              <div className="name">{rung.name}</div>
              <p>{rung.body}</p>
            </div>
          ))}
        </div>
        <p className="gatecallout">
          Cheap checks gate the expensive ones — a deterministic{" "}
          <span className="mono">script</span> short-circuits a{" "}
          <span className="mono">browser-agent</span>, so you only spend judgment
          where it matters. Skipped is recorded as skipped, never a fake zero.
        </p>
      </div>
    </section>
  );
}
