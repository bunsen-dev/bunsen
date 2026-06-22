import { suiteCommand } from "@/components/code-blocks";

const fg = { color: "var(--fg)" } as const;
const accent = { color: "var(--accent)" } as const;

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

export function AtScale() {
  return (
    <section className="band" id="scale">
      <div className="wrap">
        <div className="eyebrow">At scale</div>
        <h2 className="sec">One experiment, or a whole benchmark.</h2>
        <p className="sec-lead">
          Add a suite at a pinned commit and point any agent at it — Bunsen&apos;s
          port of Terminal Bench 1.0 is <strong style={fg}>66 real-world tasks</strong>{" "}
          across nine categories, scored entirely by code, no API key to
          evaluate. Bring
          your own too: bug fixes on real repos, zero-to-one builds, sysadmin,
          security, ML. Then sweep agents across all of them.
        </p>

        {/* Static, build-time, author-controlled markup — see components/code-blocks.ts */}
        <div
          className="tbcmd"
          dangerouslySetInnerHTML={{ __html: suiteCommand }}
        />

        <div className="cats">
          {categories.map((cat) => (
            <span className="cat" key={cat.label}>
              <b>{cat.label}</b>
              <span className="n">{cat.n}</span>
            </span>
          ))}
        </div>

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
            <span className="mono">investigation seeds, not verdicts</span> — the
            same sweep also caught a cost-accounting bug in Bunsen before any
            number shipped.
          </div>
        </div>
      </div>
    </section>
  );
}
