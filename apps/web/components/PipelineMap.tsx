// The "Through-Line": a slim map of the Bunsen pipeline placed directly under
// the hero. It picks up where the RunBar leaves off — the RunBar shows only the
// inputs (experiment x agent); this shows what one keystroke produces, how it's
// evaluated, and that the whole thing is a LOOP an agent can drive on its own.
//
//   run -> artifacts -> deep evals -> analyze --(loop back, agent-driven)--> run
//
// Each cell: a mono label (.pk) + a visual, then prose in the page's sans voice
// (.pdesc = primary line, .psub = secondary detail). The eval cell is a teaser,
// not a legend — the full scorer ladder lives in the Deep Evals section (#evals);
// the analyze cell sells the real payoff: meta-analysis -> insight -> iterate (#lab).

export function PipelineMap() {
  return (
    <section className="pipemap" aria-label="The Bunsen research loop: run, artifacts, deep evals, analyze">
      <div className="wrap">
        <div className="pipe-grid">
          {/* 1 · run — a miniature of the RunBar command above */}
          <a className="pcell run" href="#start">
            <div className="pk">run</div>
            <div className="pline">
              <span className="verb">bn run</span>
              <span className="pchip exp">exp</span>
              <span className="pdot">×</span>
              <span className="pchip agt">agt</span>
            </div>
            <div className="pdesc">Any experiment × any agent.</div>
          </a>

          <span className="parrow" aria-hidden="true">→</span>

          {/* 2 · artifacts — everything captured from one run (the net-new beat) */}
          <a className="pcell arts" href="#start">
            <div className="pk">artifacts</div>
            <div className="ptags">
              <i>diff</i>
              <i>logs</i>
              <i>trace</i>
              <i>cost</i>
              <i>terminal</i>
              <i>screenshots</i>
              <i>video</i>
            </div>
            <div className="pdesc">Captured automatically — no instrumentation.</div>
          </a>

          <span className="parrow" aria-hidden="true">→</span>

          {/* 3 · deep evals — scorers that are themselves agents, gated by a $0 script */}
          <a className="pcell evals" href="#evals">
            <div className="pk">deep evals</div>
            <div className="spectrum" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
            <div className="pdesc">Agents that browse, run tests, and read traces.</div>
            <div className="psub">A free pass/fail script can gate the costly agentic scorers.</div>
          </a>

          <span className="parrow" aria-hidden="true">→</span>

          {/* 4 · analyze — meta-analysis -> insight -> iterate */}
          <a className="pcell analyze" href="#lab">
            <div className="pk">analyze</div>
            <div className="pana">
              <span className="pmini" aria-hidden="true">
                <b />
                <b />
                <b />
                <b />
                <b />
                <b />
                <b />
                <b />
                <b />
              </span>
              <span className="pmini-arrow" aria-hidden="true">→</span>
              <span className="preport">insights</span>
            </div>
            <div className="pdesc">Meta-analysis across many runs.</div>
            <div className="psub">Surfaces what works, and why.</div>
          </a>
        </div>

        {/* the loop — analyze feeds the next run; an agent can drive the whole cycle */}
        <div className="ploop">
          <span className="ploop-label">
            <span className="ploop-glyph" aria-hidden="true">
              ↻
            </span>
            An agent can drive the whole loop.
          </span>
        </div>

        <p className="pcap">
          Insights from each run sharpen the next — runs in, research out.
        </p>
      </div>
    </section>
  );
}
