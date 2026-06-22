const fg = { color: "var(--fg)" } as const;

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
          work: running the matrix produced the sweep above, and turning those
          runs into a cited write-up is what Bunsen did next.
        </p>

        <div className="proofcard">
          <span className="lab-tag">Real today · adversarially verified</span>
          <p>
            Given nothing but <span className="mono">46 run IDs</span> from a
            finished sweep — no hint of the tasks, the agents, or the scoring —
            Bunsen reconstructed the entire study and wrote it up, citing
            specific runs and traces that held up to an adversarial check at{" "}
            <span className="mono">zero discrepancies</span>. It even caught a
            cost-accounting bug in Bunsen itself, fixed before any number
            shipped. <strong style={fg}>Runs in, research out.</strong>
          </p>
        </div>

        <p className="vnote">
          <b>The trajectory · not a checkbox —</b> the productized meta-analysis
          feature (<span className="mono">bn report</span>) and a fully
          self-directed loop — Bunsen proposing its own questions — are where
          we&apos;re headed, not shipped features.
        </p>
      </div>
    </section>
  );
}
