export function Pillars() {
  return (
    <section className="band" id="what">
      <div className="wrap">
        <div className="eyebrow">How it works</div>
        <h2 className="sec">From agent to evidence.</h2>
        <div className="pillars">
          <div className="pillar">
            <div className="tag">ANY AGENT</div>
            <h3>Bring any agent</h3>
            <p>
              Claude Code, Codex, Gemini, and the Claude SDK ship ready — or add your own (Pi,
              OpenCode, your in-house agent) in ~10 lines of YAML pointing at a command. No SDK, no
              wrapper class.
            </p>
          </div>
          <div className="pillar">
            <div className="tag">ANY EXPERIMENT</div>
            <h3>Run it in a container</h3>
            <p>
              Any task you can run in Docker. Drop the files the agent works on in{' '}
              <span className="mono">workspace/</span>, write the prompt and a rubric, and Bunsen
              instruments the run for you — every API call, diff, log, and cost, captured with zero
              changes to the agent.
            </p>
          </div>
          <div className="pillar">
            <div className="tag">DEEP EVALS</div>
            <h3>Score it with AI</h3>
            <p>
              Scorers from deterministic checks up to AI agents that run your tests, drive a real
              browser, and read the run&apos;s own traces. The whole ladder, out of the box.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
