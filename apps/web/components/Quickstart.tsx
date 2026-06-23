import { quickstartCommands } from "@/components/code-blocks";

export function Quickstart() {
  return (
    <section className="band" id="start">
      <div className="wrap">
        <div className="eyebrow">Quickstart</div>
        <h2 className="sec">Maximum power, zero setup.</h2>
        <p className="sec-lead">
          Install the CLI, scaffold a project with the frontier coding agents
          already wired up, and point one at a real benchmark task. Every run is
          fully instrumented — traces, artifacts, diffs, and cost, captured
          automatically.
        </p>

        {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
        <div
          className="cmdlist"
          dangerouslySetInnerHTML={{ __html: quickstartCommands }}
        />

        <p className="cmdnote">
          Node 22+ and Docker — run <span className="mono">bn doctor</span> to
          verify your environment. <span className="mono">claude-code</span> reads{" "}
          <span className="mono">ANTHROPIC_API_KEY</span> from{" "}
          <span className="mono">.env</span>; swap in{" "}
          <span className="mono">OPENAI_API_KEY</span> for{" "}
          <span className="mono">codex-cli</span> or{" "}
          <span className="mono">GEMINI_API_KEY</span> for{" "}
          <span className="mono">gemini-cli</span>. The CLI installs from npm
          today and is moving to a single standalone binary.
        </p>
      </div>
    </section>
  );
}
