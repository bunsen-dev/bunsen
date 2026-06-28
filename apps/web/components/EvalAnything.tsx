import { suiteCommand } from "@/components/code-blocks";

const fg = { color: "var(--fg)" } as const;

const TB_REPO = "https://github.com/bunsen-dev/terminal-bench";
// In-repo example today (examples/experiments/games/battlesnake). Update this if
// BattlesnakeBench gets its own repo.
const BATTLESNAKE_REPO =
  "https://github.com/bunsen-dev/bunsen/tree/main/examples/experiments/games/battlesnake";

// The 66 Terminal Bench tasks by category (sums to 66) — the "code-scored at
// scale" backing for the Terminal Bench block.
const categories = [
  { label: "File ops & data", n: 8 },
  { label: "Software engineering", n: 10 },
  { label: "System administration", n: 9 },
  { label: "Debugging & deps", n: 7 },
  { label: "Security", n: 7 },
  { label: "ML & data science", n: 9 },
  { label: "Web & APIs", n: 6 },
  { label: "SWE-Bench", n: 4 },
  { label: "Other", n: 6 },
];

// Two real held-out-ladder runs shown side by side in the BattlesnakeBench block.
// GIFs are gifsicle-optimized exports of each run's auto-rendered replay.gif;
// win-rate is that bot's score against the hidden ladder (a representative game
// is shown, not necessarily a win). 442×534 native.
const battlesnakeRuns = [
  { agent: "claude-code", model: "Opus 4.8", winRate: "42%", gif: "/battlesnake-claude.gif" },
  { agent: "codex-cli", model: "gpt-5.5", winRate: "25%", gif: "/battlesnake-codex.gif" },
];

// Act 1 (breadth-first hook): Bunsen as a universal eval lab. The pitch up top,
// then two concrete examples — the Terminal Bench port (a whole code-scored
// benchmark) and BattlesnakeBench (a custom bench Claude Code authored with the
// bn CLI, shown as two real replays). The cross-agent sweep matrix lives under
// "Toward an autonomous research lab" — it's a research output, not a feature here.
export function EvalAnything() {
  return (
    <section className="band" id="anything">
      <div className="wrap">
        <div className="eyebrow">Eval anything</div>
        <h2 className="sec">If you can run it, Bunsen can eval it.</h2>
        <p className="sec-lead">
          Bunsen is a universal eval lab you can point at <em>any</em> task:{" "}
          <strong style={fg}>benchmarks</strong>,{" "}
          <strong style={fg}>zero-to-one product builds</strong>,{" "}
          <strong style={fg}>coding agents</strong>,{" "}
          <strong style={fg}>your own Claude Code customizations</strong>, and
          more. In fact, we&apos;ve ported{" "}
          <a href={TB_REPO} className="tblink">
            Terminal Bench 1.0
          </a>{" "}
          to Bunsen — and, as an example, we had Claude Code use the{" "}
          <span className="mono">bn</span> CLI to create{" "}
          <a href={BATTLESNAKE_REPO} className="tblink">
            BattlesnakeBench
          </a>
          , where models compete to create the best Battlesnake bot.
        </p>

        {/* Terminal Bench — a whole benchmark, code-scored */}
        <div className="benchblock">
          <div className="rtag">Benchmarks · Terminal Bench</div>
          <h3>A whole benchmark, code-scored.</h3>
          <p>
            The full canonical Terminal Bench 1.0 port runs in Bunsen —{" "}
            <strong style={fg}>66 real-world tasks across nine categories</strong>.
            We also ported Terminal Bench&apos;s deterministic scorers over as
            Bunsen scorers, so evaluating tasks costs nothing.{" "}
            <a href={TB_REPO} className="tblink">
              Browse the port →
            </a>
          </p>

          <div className="cats">
            {categories.map((cat) => (
              <span className="cat" key={cat.label}>
                <b>{cat.label}</b>
                <span className="n">{cat.n}</span>
              </span>
            ))}
          </div>

          {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
          <div className="tbcmd" dangerouslySetInnerHTML={{ __html: suiteCommand }} />
        </div>

        {/* BattlesnakeBench — two real replays side by side */}
        <div className="benchblock">
          <div className="rtag">Games · BattlesnakeBench</div>
          <h3>
            Seriously — eval <em>anything</em>.
          </h3>
          <p>
            Claude Code used the <span className="mono">bn</span> CLI to create{" "}
            <a href={BATTLESNAKE_REPO} className="tblink">
              BattlesnakeBench
            </a>{" "}
            — here are two models&apos; bots, each scored by{" "}
            win-rate<sup>*</sup> against a hidden, held-out ladder of reference
            snakes:
          </p>
          <div className="gifrow">
            {battlesnakeRuns.map((run) => (
              <figure className="gif-cell" key={run.agent}>
                {/* eslint-disable-next-line @next/next/no-img-element -- static asset, no client JS */}
                <img
                  src={run.gif}
                  alt={`${run.agent} BattlesnakeBench replay`}
                  width={442}
                  height={534}
                  loading="lazy"
                />
                <figcaption>
                  <b>{run.agent}</b>
                  <span>
                    {run.model} · {run.winRate} win-rate
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="benchnote">
            <sup>*</sup> Win-rate over 36 games per model (9 seeds × 4 hidden
            reference bots). The official engine spawns snakes
            nondeterministically, so a single run varies by ~±3% (1 SD) — the
            model ranking holds across repeated scorings. Each replay is one
            game, not the full ladder.
          </p>
        </div>
      </div>
    </section>
  );
}
