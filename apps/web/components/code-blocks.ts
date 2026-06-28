// Whitespace-sensitive, pre-highlighted terminal/code blocks for the landing page.
// Hand-maintained authored content (originally extracted from the landing design HTML).
// Rendered via dangerouslySetInnerHTML to preserve exact whitespace + highlight spans —
// when editing, keep these in sync with the real experiment.v1 schema + CLI shapes.

// Act 2 · Deep by default — the showcase rubric. One rubric, five kinds of scorer:
// a gate, an agent that audits the code, two browser-agents, and a math roll-up.
export const rubricYaml = `<span class="k">evaluation</span>:
  <span class="k">criteria</span>:
    - <span class="k">id</span>: builds         <span class="c"># gate — skip the rest unless it compiles</span>
      <span class="k">type</span>: script
      <span class="k">run</span>: bash /bunsen/verifiers/build.sh
      <span class="k">scores</span>: [0, 1]       <span class="c"># allowed values — omit for continuous 0–1</span>
      <span class="k">gate</span>: { <span class="k">ifBelow</span>: 1 }
    - <span class="k">id</span>: security       <span class="c"># an agent audits the source and cites file:line</span>
      <span class="k">type</span>: agent
      <span class="k">instructions</span>: <span class="s">Audit for injection / XSS — unsanitized titles, an unsafe ICS export.</span>
    - <span class="k">id</span>: drag-and-drop  <span class="c"># a browser-agent drives real Chromium</span>
      <span class="k">type</span>: browser-agent
      <span class="k">instructions</span>: Drag to create an event, move it to another day — does it stick?
    - <span class="k">id</span>: responsive     <span class="c"># graded 0 / .25 / .5 / .75 / 1, not pass/fail</span>
      <span class="k">type</span>: browser-agent
      <span class="k">scores</span>: [0, 0.25, 0.5, 0.75, 1]
      <span class="k">instructions</span>: Does the layout hold at 375 / 768 / 1280 px?
    - <span class="k">id</span>: overall        <span class="c"># pure-math roll-up, no LLM</span>
      <span class="k">type</span>: aggregate
      <span class="k">needs</span>: all
      <span class="k">aggregate</span>: { <span class="k">function</span>: weighted_average }`;

// Act 3 · Set up an experiment — the minimal experiment.yaml (deliberately tiny
// vs the showcase rubric above): a task, a workspace, and one $0 script criterion.
export const minimalExperimentYaml = `<span class="c">$schema</span>: …/experiment.v1.json
<span class="k">version</span>: v1
<span class="k">name</span>: gcal-clone
<span class="k">task</span>:
  <span class="k">prompt</span>: <span class="s">Build a calendar app in /workspace — month / week / day views.</span>
<span class="k">workspace</span>:
  <span class="k">sources</span>:
    - <span class="k">path</span>: ./workspace
<span class="k">evaluation</span>:
  <span class="k">criteria</span>:
    - <span class="k">id</span>: builds
      <span class="k">type</span>: script
      <span class="k">run</span>: bash /bunsen/verifiers/build.sh
      <span class="k">scores</span>: [0, 1]
    - <span class="k">id</span>: views
      <span class="k">type</span>: browser-agent
      <span class="k">instructions</span>: Make sure the month / week / day views work.`;

export const fileTree = `<span class="td">gcal-clone/</span>
├─ experiment.yaml   <span class="tc">experiment definition</span>
├─ <span class="td">verifiers/</span>        <span class="tc">optional deterministic scorers</span>
└─ <span class="td">workspace/</span>        <span class="tc">agent's working dir</span>
   └─ <span class="tc">any starting files you want to give the agent</span>`;

// Act 1 · Eval anything — a real Terminal Bench task running in Bunsen; the
// suite-add line is the quiet secondary point (it's a suite you can add yourself).
export const suiteCommand = `<span class="cmd">bn run</span> terminal-bench/crack-7z-hash claude-code   <span class="dim"># a real task — code-scored, no API key</span>
<span class="dim"># want it in your own project? bn suites add github.com/bunsen-dev/terminal-bench</span>`;

// Act 3 · Get started — step 1, install + scaffold. The `bn run` happens in step 2,
// against the experiment folder you just looked at.
export const installCommands = `<span class="cmd">curl -fsSL</span> https://bunsen.dev/install.sh | <span class="cmd">sh</span>   <span class="dim"># install the Bunsen CLI</span>
<span class="cmd">bn skills install</span>                              <span class="dim"># let your agent drive Bunsen for you</span>

<span class="cmd">mkdir</span> my-lab &amp;&amp; <span class="cmd">cd</span> my-lab
<span class="cmd">bn init</span> --starter-agents   <span class="dim"># project + claude-code, codex-cli, gemini-cli</span>
<span class="cmd">echo</span> "ANTHROPIC_API_KEY=sk-ant-…" &gt; .env`;
