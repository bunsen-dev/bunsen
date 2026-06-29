import { minimalExperimentYaml, fileTree, installCommands } from '@/components/code-blocks';

const fg = { color: 'var(--fg)' } as const;

// Act 3 (now-you-try): how little it takes to start, after selling breadth + depth.
// Install first, then create your first experiment — a folder with a task and a
// rubric, then `bn run`. No agent.yaml on the homepage — agents are "already wired
// up; bring your own → docs / bn skills install".
export function SetupExperiment() {
  return (
    <section className="band" id="start">
      <div className="wrap">
        <div className="eyebrow">Get started</div>
        <h2 className="sec">Maximum power, minimum setup.</h2>
        <p className="sec-lead">
          Install the CLI, scaffold a project with the frontier coding agents already wired up, then
          write your first experiment — a folder with a task and a rubric. Every run is fully
          instrumented — traces, artifacts, diffs, and cost — captured automatically, with zero
          changes to the agent.
        </p>

        <div className="setupstep">
          <div className="setnum">1 · install</div>
          {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
          <div className="cmdlist" dangerouslySetInnerHTML={{ __html: installCommands }} />
          <p className="cmdnote">
            Node 22+ and Docker — run <span className="mono">bn doctor</span> to verify your
            environment. <span className="mono">claude-code</span>,{' '}
            <span className="mono">codex-cli</span>, and <span className="mono">gemini-cli</span>{' '}
            ship ready; bringing your own agent is ~10 lines of YAML — start from a bundled one, or
            run <span className="mono">bn skills install</span> and let your agent write it. See the{' '}
            <a href="/docs">docs</a>.
          </p>
        </div>

        <div className="setupstep">
          <div className="setnum">2 · create your first experiment</div>
          <div className="stepc wide first">
            <div className="hd">
              <h3>An experiment is just a folder.</h3>
              <p>
                An{' '}
                <span className="mono" style={fg}>
                  experiment.yaml
                </span>
                , optional verifier scripts your rubric calls, and a workspace seeded into the
                container. That&apos;s the whole thing.
              </p>
              {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
              <div className="tree" dangerouslySetInnerHTML={{ __html: fileTree }} />
            </div>
            <pre dangerouslySetInnerHTML={{ __html: minimalExperimentYaml }} />
          </div>

          <p className="cmdnote">
            Even this starter rubric pairs a deterministic check with a{' '}
            <span className="mono">browser-agent</span>. For the full range of agentic scorers, see{' '}
            <a href="#deep">Deep by default ↓</a>.
          </p>
        </div>
      </div>
    </section>
  );
}
