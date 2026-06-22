import { experimentYaml, agentYaml, fileTree } from "@/components/code-blocks";

const fg = { color: "var(--fg)" } as const;

export function Quickstart() {
  return (
    <section className="band" id="start">
      <div className="wrap">
        <div className="eyebrow">Quickstart</div>
        <h2 className="sec">Two files to a real result.</h2>
        <p className="sec-lead">
          An experiment is a folder; an agent is a few lines pointing at your
          code. The rubric below puts the whole eval stack to work — a{" "}
          <span className="mono">$0</span> gate, an <strong style={fg}>agent</strong>{" "}
          that scans the code for security holes, two browser-agents — one drags
          an event, one checks the layout across breakpoints — and a math roll-up.
        </p>

        <div className="stepc wide first">
          <div className="hd">
            <div className="num">01 · the experiment</div>
            <h3>Define the experiment</h3>
            <p>
              An experiment is a challenge you point an agent at — here, “build a
              calendar app.” You&apos;re probing the <strong style={fg}>agent</strong>{" "}
              (model + harness), not a fixed input/output.
            </p>
            {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
            <div className="tree" dangerouslySetInnerHTML={{ __html: fileTree }} />
          </div>
          <pre dangerouslySetInnerHTML={{ __html: experimentYaml }} />
        </div>

        <div className="stepc wide">
          <div className="hd">
            <div className="num">02 · the agent</div>
            <h3>Bring an agent</h3>
            <p>
              Point at a command and a source — local, a git branch, npm, or a
              binary. No SDK, no wrapper class. Four frontier harnesses already
              ship ready.
            </p>
          </div>
          <pre dangerouslySetInnerHTML={{ __html: agentYaml }} />
        </div>

        <p className="runit">
          Install once: <span className="cmd">npm i -g @bunsen-dev/cli</span>{" "}
          &nbsp;—&nbsp; then run it: <span className="cmd">bn run</span>{" "}
          gcal-clone my-agent &nbsp;—&nbsp; or{" "}
          <span className="cmd">claude-code</span>,{" "}
          <span className="cmd">codex-cli</span>,{" "}
          <span className="cmd">gemini-cli</span>. Same command.
        </p>
        <p className="runit-note">
          Node 22+ and Docker. The CLI installs from npm today and is moving to a
          single standalone binary.
        </p>
      </div>
    </section>
  );
}
