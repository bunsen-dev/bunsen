// Whitespace-sensitive, pre-highlighted terminal/code blocks for the landing page.
// Hand-maintained authored content (originally extracted from the landing design HTML).
// Rendered via dangerouslySetInnerHTML to preserve exact whitespace + highlight spans —
// when editing, keep these in sync with the real experiment.v1 / agent.v1 schema + CLI shapes.

export const experimentYaml = `<span class="c">$schema</span>: …/experiment.v1.json
<span class="k">version</span>: v1
<span class="k">name</span>: gcal-clone
<span class="k">task</span>:
  <span class="k">prompt</span>: <span class="s">|-</span>
    <span class="s">Build a calendar app in the Vite app in /workspace:</span>
    <span class="s">month / week / day views, drag-to-create events, and</span>
    <span class="s">recurring events (daily/weekly/monthly, with exceptions).</span>
<span class="k">workspace</span>:
  <span class="k">sources</span>:
    - <span class="k">path</span>: ./workspace          <span class="c"># a Vite + React starter ⇒ /workspace</span>
<span class="k">environment</span>:
  <span class="k">image</span>: { <span class="k">base</span>: bunsen/visual }  <span class="c"># Node 20 + headless Chromium</span>
<span class="k">run</span>: { <span class="k">timeout</span>: 30m }
<span class="k">evaluation</span>:
  <span class="k">criteria</span>:
    - <span class="k">id</span>: builds        <span class="c"># $0 gate — skip the rest unless it compiles</span>
      <span class="k">title</span>: Builds
      <span class="k">type</span>: script
      <span class="k">run</span>: bash /bunsen/verifiers/build.sh   <span class="c"># a script in verifiers/: npm ci &amp;&amp; npm run build</span>
      <span class="k">scores</span>: [0, 1]   <span class="c"># allowed values — omit for continuous 0–1 (the default)</span>
      <span class="k">gate</span>: { <span class="k">ifBelow</span>: 1 }
      <span class="k">timeout</span>: 5m
    - <span class="k">id</span>: security      <span class="c"># an agent audits the code and cites file:line</span>
      <span class="k">title</span>: Security scan
      <span class="k">type</span>: agent
      <span class="k">instructions</span>: <span class="s">|-</span>
        <span class="s">Audit the source for injection / XSS — unsanitized event</span>
        <span class="s">titles, dangerouslySetInnerHTML, an unsafe ICS export.</span>
    - <span class="k">id</span>: drag-and-drop <span class="c"># browser-agent — the core interaction</span>
      <span class="k">title</span>: Drag and drop
      <span class="k">type</span>: browser-agent
      <span class="k">scores</span>: [0, 1]
      <span class="k">instructions</span>: Drag to create an event, move it to another day — does it stick?
    - <span class="k">id</span>: responsive    <span class="c"># browser-agent — layout across breakpoints</span>
      <span class="k">title</span>: Responsive layout
      <span class="k">type</span>: browser-agent
      <span class="k">scores</span>: [0, 0.25, 0.5, 0.75, 1]
      <span class="k">instructions</span>: Does the layout hold at 375 / 768 / 1280 px (day / week / month)?
    - <span class="k">id</span>: overall       <span class="c"># pure-math roll-up, no LLM</span>
      <span class="k">title</span>: Overall
      <span class="k">type</span>: aggregate
      <span class="k">needs</span>: all
      <span class="k">aggregate</span>: { <span class="k">function</span>: weighted_average }
      <span class="k">weight</span>: 0`;

export const agentYaml = `<span class="c">$schema</span>: …/agent.v1.json
<span class="k">version</span>: v1
<span class="k">name</span>: my-agent
<span class="k">install</span>:
  <span class="k">source</span>:
    <span class="k">type</span>: git                  <span class="c"># or local | npm | binary</span>
    <span class="k">repo</span>: https://github.com/me/my-agent
    <span class="k">ref</span>: feature/better-planner   <span class="c"># run an unmerged branch</span>
<span class="k">entrypoint</span>:
  <span class="k">command</span>: python -m my_agent.run  <span class="c"># the task prompt is appended</span>
<span class="k">interaction</span>:
  <span class="k">mode</span>: direct
<span class="k">model</span>:
  <span class="k">env</span>: ANTHROPIC_MODEL          <span class="c"># bn run … --model sets this</span>
  <span class="k">default</span>: claude-sonnet-4-6`;

export const fileTree = `<span class="td">gcal-clone/</span>
├─ experiment.yaml   <span class="tc">task + rubric</span>
├─ <span class="td">verifiers/</span>        <span class="tc">build.sh ⇒ /bunsen/verifiers</span>
└─ <span class="td">workspace/</span>        <span class="tc">seeded → /workspace</span>
   ├─ src/  index.html
   └─ <span class="tc">a Vite + React starter</span>`;

export const suiteCommand = `<span class="dim"># add the suite at a pinned ref, then run any agent against any task</span>
<span class="cmd">bn suites add</span> https://github.com/bunsen-dev/terminal-bench.git --as terminal-bench
<span class="cmd">bn run</span> terminal-bench/crack-7z-hash claude-code   <span class="dim"># code-scored, no API key</span>`;

export const quickstartCommands = `<span class="cmd">curl -fsSL</span> https://bunsen.dev/install.sh | <span class="cmd">sh</span>   <span class="dim"># install the Bunsen CLI</span>
<span class="cmd">bn skills install</span>         <span class="dim"># so your agent can help you with anything you want to do with Bunsen</span>

<span class="cmd">mkdir</span> my-lab &amp;&amp; <span class="cmd">cd</span> my-lab
<span class="cmd">bn init</span> --starter-agents  <span class="dim"># project + claude-code, codex-cli, gemini-cli</span>
<span class="cmd">echo</span> "ANTHROPIC_API_KEY=sk-ant-…" &gt; .env

<span class="dim"># add Terminal Bench at a pinned ref, then run a real task</span>
<span class="cmd">bn suites add</span> https://github.com/bunsen-dev/terminal-bench.git --as terminal-bench
<span class="cmd">bn run</span> terminal-bench/fibonacci-server claude-code`;
