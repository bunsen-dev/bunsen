const fg = { color: "var(--fg)" } as const;
const accent = { color: "var(--accent)" } as const;

export function TheLab() {
  return (
    <section className="band" id="lab">
      <div className="wrap">
        <div className="eyebrow">The idea</div>
        <h2 className="sec">Toward an autonomous research lab.</h2>
        <p className="lab-body">
          Bunsen runs on its own agents: inside every run, they{" "}
          <strong>
            drive the agent under test, read its traces, and score the result
          </strong>
          . The bigger goal is an autonomous lab that runs the whole research
          loop — proposing the questions, running the matrix, and writing up the
          findings. We&apos;re not there yet, but the last two steps already
          work: running the matrix produced the sweep below, and turning those
          runs into a cited write-up is what Bunsen did next.
        </p>

        <div className="matrix">
          <div className="mhd">
            A <b>real four-vendor sweep</b> — same 12 Terminal Bench tasks,
            code-scored apples-to-apples, the whole matrix driven from{" "}
            <span className="mono" style={accent}>
              bn
            </span>
            .
          </div>
          <table className="m">
            <thead>
              <tr>
                <th>Agent (model)</th>
                <th>Pass rate</th>
                <th>Cost / pass</th>
              </tr>
            </thead>
            <tbody>
              <tr className="win">
                <td>
                  <span className="mono">codex-cli</span> (gpt-5.5)
                </td>
                <td>
                  <span className="pass">92%</span> · 11/12
                </td>
                <td>
                  <span className="cheap">$0.31</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="mono">claude-code</span> (Opus 4.7)
                </td>
                <td>
                  <span className="pass">92%</span> · 11/12
                </td>
                <td>
                  <span className="mono">$1.66</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="mono">claude-sdk-agent</span> (Sonnet 4.5)
                </td>
                <td>60%</td>
                <td>
                  <span className="mono">$0.30</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="mono">gemini-cli</span> (2.5 Pro)
                </td>
                <td>58%</td>
                <td>
                  <span className="mono">$0.47</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="caveat">
            codex matched the top pass rate at roughly a fifth the cost per pass.
            One run per cell:{" "}
            <span className="mono">investigation seeds, not verdicts</span>.
          </div>
        </div>

        <div className="proofcard">
          <span className="lab-tag">Real today · adversarially verified</span>
          <p>
            Given nothing but <span className="mono">46 run IDs</span> from a
            finished sweep — no hint of the tasks, the agents, or the scoring —
            Bunsen reconstructed the entire study and wrote it up, citing
            specific runs and traces that held up to an adversarial check at{" "}
            <span className="mono">zero discrepancies</span>.{" "}
            <strong style={fg}>Runs in, research out.</strong>
          </p>
        </div>

        <p className="vnote">
          <b>Upcoming —</b> a productized meta-analysis command (
          <span className="mono">bn report</span>) and a fully self-directed loop
          where Bunsen proposes its own research questions.
        </p>
      </div>
    </section>
  );
}
