// Illustrative mix for the "try any combination" animation.
//   - Experiments: a real shipping benchmark (terminal-bench), two starred aspirational
//     benchmarks (program-bench, mle-bench), and self-authored custom work (gcal-clone,
//     play-tetris, your-experiment).
//   - Agents: shipping frontier CLIs (claude-code, codex-cli, gemini-cli), two starred
//     aspirational agents (opencode, pi), and bring-your-own.
//   - A trailing "*" marks anything not bundled yet (third-party suites/agents). It
//     renders as a superscript star explained by the footnote. Real, shipping items sit
//     in the resting frame (index 0) so the default visible state is honest; self-authored
//     custom experiments aren't starred (you write those — see the Quickstart).
//   - program-bench/sqlite is a real ProgramBench task (reconstruct SQLite from its
//     binary; arXiv 2605.03546); mle-bench is a different domain (ML) and container-native.
const experiments = [
  "terminal-bench/build-linux-kernel",
  "gcal-clone",
  "program-bench/sqlite*",
  "play-tetris",
  "mle-bench/spaceship-titanic*",
  "your-experiment",
  "terminal-bench/build-linux-kernel",
];

const agents = [
  "claude-code",
  "codex-cli",
  "gemini-cli",
  "opencode*",
  "pi*",
  "your-agent",
  "claude-code",
];

function RotItem({ name }: { name: string }) {
  if (name.endsWith("*")) {
    return (
      <li>
        {name.slice(0, -1)}
        <sup className="aspir">*</sup>
      </li>
    );
  }
  return <li>{name}</li>;
}

export function RunBar() {
  return (
    <div className="runbar" aria-label="Animated example command">
      <div className="runline">
        <span className="pfx">$</span>
        <span className="verb">bn run</span>
        <span className="chip exp">
          <span className="rot exp">
            <ul>
              {experiments.map((name, i) => (
                <RotItem key={i} name={name} />
              ))}
            </ul>
          </span>
        </span>
        <span className="chip agt">
          <span className="rot agt">
            <ul>
              {agents.map((name, i) => (
                <RotItem key={i} name={name} />
              ))}
            </ul>
          </span>
        </span>
      </div>
      <div className="runcap">
        <b>If you can run it, Bunsen can test it.</b> Swap one argument to compare
        across models <em>and</em> harnesses.
      </div>
      <div className="runfoot">
        <span className="star">*</span> Coming soon — add any benchmark via{" "}
        <span className="mono">bn suites add</span>, or any agent in ~10 lines of
        YAML.
      </div>
    </div>
  );
}
