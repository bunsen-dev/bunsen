// SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * Open command - Launch local viewer for a run
 */

import { createServer } from 'http';
import { parse as parseUrl } from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import chalk from 'chalk';
import {
  loadRunManifest,
  loadEvaluationResult,
  loadLogs,
  loadWorkspaceDiff,
  loadThreadsIndex,
  loadThreadTurns,
  getRunDir,
  getRecordingPath,
  getScreenshotsDir,
  getCriterionLogPath,
  listRuns,
  filterLockfilesFromDiff,
} from '@bunsen-dev/runtime';

interface OpenOptions {
  port?: string;
}

export async function openCommand(
  runId: string | undefined,
  options: OpenOptions
): Promise<void> {
  const port = parseInt(options.port || '3456', 10);

  // If no runId provided, use the most recent run
  if (!runId) {
    const runs = listRuns();
    if (runs.length === 0) {
      console.error(chalk.red('No runs found'));
      process.exit(1);
    }
    runId = runs[0].run_id;
    console.log(chalk.dim(`Opening most recent run: ${runId}`));
  }

  // Validate run exists
  if (!loadRunManifest(runId)) {
    console.error(chalk.red(`Run not found: ${runId}`));
    process.exit(1);
  }

  const runDir = getRunDir(runId);

  const server = createServer(async (req, res) => {
    const parsedUrl = parseUrl(req.url || '/', true);
    const pathname = parsedUrl.pathname || '/';

    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    try {
      // API routes
      if (pathname === '/api/run') {
        const manifest = loadRunManifest(runId!);
        if (!manifest) {
          res.statusCode = 404;
          res.end('Run not found');
          return;
        }
        const evaluation = loadEvaluationResult(runId!);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ manifest, evaluation }));
        return;
      }

      if (pathname === '/api/logs') {
        const logs = loadLogs(runId!);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ logs: logs || '' }));
        return;
      }

      if (pathname === '/api/diff') {
        const rawDiff = loadWorkspaceDiff(runId!);
        const diff = rawDiff ? filterLockfilesFromDiff(rawDiff) : rawDiff;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ diff }));
        return;
      }

      if (pathname === '/api/traces/index') {
        const index = loadThreadsIndex(runId!);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ index }));
        return;
      }

      // /api/traces/thread/<threadId>?start=N&end=M
      if (pathname.startsWith('/api/traces/thread/')) {
        const threadId = pathname.replace('/api/traces/thread/', '');
        const startParam = parsedUrl.query.start;
        const endParam = parsedUrl.query.end;
        const start = typeof startParam === 'string' ? Number(startParam) : undefined;
        const end = typeof endParam === 'string' ? Number(endParam) : undefined;
        const turns = loadThreadTurns(
          runId!,
          threadId,
          {
            ...(Number.isFinite(start) ? { start } : {}),
            ...(Number.isFinite(end) ? { end } : {}),
          },
        );
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ threadId, turns }));
        return;
      }

      if (pathname === '/api/supervisor') {
        const supervisorPath = path.join(runDir, 'supervisor.json');
        if (fs.existsSync(supervisorPath)) {
          const supervisorData = fs.readFileSync(supervisorPath, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(supervisorData);
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ interactions: [] }));
        }
        return;
      }

      // Scorer log route (for code-based scorers)
      if (pathname.startsWith('/api/scorer-log/')) {
        const slug = pathname.replace('/api/scorer-log/', '');
        const logPath = getCriterionLogPath(runId!, slug);
        if (fs.existsSync(logPath)) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ log: fs.readFileSync(logPath, 'utf-8') }));
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Scorer log not found' }));
        }
        return;
      }

      // Static file routes
      if (pathname === '/recording.cast') {
        const castPath = getRecordingPath(runId!);
        if (fs.existsSync(castPath)) {
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(castPath));
        } else {
          res.statusCode = 404;
          res.end('Recording not found');
        }
        return;
      }

      // Screenshots — served from artifacts/screenshots/. The criterion
      // result stores screenshots with the full `artifacts/screenshots/<file>`
      // path; the viewer fetches them via the same path.
      if (pathname.startsWith('/artifacts/screenshots/')) {
        const filename = pathname.replace('/artifacts/screenshots/', '');
        const screenshotPath = path.join(getScreenshotsDir(runId!), filename);
        if (fs.existsSync(screenshotPath)) {
          const ext = path.extname(filename).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
          };
          res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
          res.end(fs.readFileSync(screenshotPath));
        } else {
          res.statusCode = 404;
          res.end('Screenshot not found');
        }
        return;
      }

      // Default: serve the HTML viewer
      res.setHeader('Content-Type', 'text/html');
      res.end(getViewerHtml(runId!));
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.end('Internal server error');
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log();
    console.log(chalk.green('✓ Bunsen Viewer started'));
    console.log(chalk.dim(`  Run: ${runId}`));
    console.log(chalk.dim(`  URL: ${url}`));
    console.log();
    console.log(chalk.dim('Press Ctrl+C to stop'));
    console.log();

    // Open in browser
    const platform = process.platform;
    const openCmd =
      platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} ${url}`);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.dim('\nShutting down...'));
    server.close();
    process.exit(0);
  });

  // Keep the process running
  await new Promise(() => {});
}

function getViewerHtml(runId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bunsen Viewer - ${runId}</title>
  <link rel="stylesheet" href="https://unpkg.com/asciinema-player@3.8.0/dist/bundle/asciinema-player.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --border-color: #30363d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-green: #3fb950;
      --accent-red: #f85149;
      --accent-yellow: #d29922;
      --accent-blue: #58a6ff;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
    }

    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .header h1 {
      font-size: 20px;
      font-weight: 600;
    }

    .header .logo {
      font-size: 24px;
    }

    .header .run-info {
      display: flex;
      gap: 16px;
      margin-left: auto;
      font-size: 14px;
      color: var(--text-secondary);
    }

    .header .status {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }

    .header .status.succeeded { background: rgba(63, 185, 80, 0.2); color: var(--accent-green); }
    .header .status.failed { background: rgba(248, 81, 73, 0.2); color: var(--accent-red); }
    .header .status.running { background: rgba(210, 153, 34, 0.2); color: var(--accent-yellow); }
    .header .status.pending { background: rgba(88, 166, 255, 0.2); color: var(--accent-blue); }
    .header .status.canceled { background: rgba(110, 118, 129, 0.2); color: var(--text-muted); }

    .container {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 24px;
      padding: 24px;
      max-width: 1600px;
      margin: 0 auto;
    }

    .main-content {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .sidebar {
      position: sticky;
      top: 24px;
      align-self: start;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      overflow: hidden;
    }

    .card-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-header h2 {
      font-size: 14px;
      font-weight: 600;
    }

    .card-body {
      padding: 16px;
    }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border-color);
    }

    .tab {
      padding: 12px 16px;
      font-size: 14px;
      color: var(--text-secondary);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
    }

    .tab:hover {
      color: var(--text-primary);
    }

    .tab.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent-blue);
    }

    .tab-content {
      display: none;
      padding: 16px;
    }

    .tab-content.active {
      display: block;
    }

    #player-container {
      background: #000;
      border-radius: 4px;
      overflow: hidden;
    }

    .no-recording {
      padding: 40px;
      text-align: center;
      color: var(--text-muted);
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
    }

    .summary-item {
      background: var(--bg-tertiary);
      padding: 12px;
      border-radius: 4px;
    }

    .summary-item label {
      display: block;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .summary-item .value {
      font-size: 16px;
      font-weight: 500;
    }

    .score-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 14px;
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent-blue);
    }

    .criterion-score {
      color: var(--accent-blue);
    }

    .criterion-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .criterion-item {
      background: var(--bg-tertiary);
      padding: 12px;
      border-radius: 4px;
    }

    .criterion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }

    .criterion-name {
      font-weight: 500;
    }

    .criterion-score {
      font-weight: 600;
    }

    .criterion-summary {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .report-content {
      line-height: 1.6;
    }

    .report-content h1, .report-content h2, .report-content h3 {
      margin-top: 24px;
      margin-bottom: 12px;
    }

    .report-content h1 { font-size: 24px; }
    .report-content h2 { font-size: 20px; }
    .report-content h3 { font-size: 16px; }

    .report-content p {
      margin-bottom: 12px;
    }

    .report-content ul, .report-content ol {
      margin-left: 24px;
      margin-bottom: 12px;
    }

    .report-content code {
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 85%;
    }

    .report-content pre {
      background: var(--bg-tertiary);
      padding: 16px;
      border-radius: 4px;
      overflow-x: auto;
      margin-bottom: 12px;
    }

    .report-content pre code {
      background: none;
      padding: 0;
    }

    .report-content blockquote {
      border-left: 4px solid var(--border-color);
      padding-left: 16px;
      color: var(--text-secondary);
      margin-bottom: 12px;
    }

    .screenshots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    .screenshot-item {
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
    }

    .screenshot-item img {
      width: 100%;
      height: auto;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .screenshot-item img:hover {
      opacity: 0.8;
    }

    .screenshot-item .label {
      padding: 8px 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .logs-content {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      background: var(--bg-tertiary);
      padding: 16px;
      border-radius: 4px;
      min-height: 400px;
      max-height: calc(100vh - 300px);
      overflow-y: auto;
    }

    .diff-content {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      line-height: 1.5;
      background: var(--bg-tertiary);
      padding: 16px;
      border-radius: 4px;
      overflow-x: auto;
    }

    .diff-file-header {
      background: var(--bg-secondary);
      color: var(--accent-blue);
      font-weight: 600;
      padding: 8px 12px;
      margin: 16px -16px 8px -16px;
      border-top: 1px solid var(--border-color);
      word-break: break-all;
      white-space: normal;
    }

    .diff-file-header:first-child {
      margin-top: 0;
      border-top: none;
    }

    .diff-line {
      white-space: pre;
    }

    .diff-line.added {
      background: rgba(63, 185, 80, 0.15);
      color: var(--accent-green);
    }

    .diff-line.removed {
      background: rgba(248, 81, 73, 0.15);
      color: var(--accent-red);
    }

    .diff-line.hunk-header {
      color: var(--text-muted);
      font-style: italic;
    }

    .traces-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .trace-item {
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
    }

    .trace-header {
      padding: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .trace-header:hover {
      background: var(--bg-primary);
    }

    .trace-expand {
      color: var(--text-muted);
      transition: transform 0.2s;
    }

    .trace-item.expanded .trace-expand {
      transform: rotate(90deg);
    }

    .trace-model {
      font-weight: 500;
    }

    .trace-tokens {
      font-size: 12px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .trace-body {
      display: none;
      padding: 12px;
      border-top: 1px solid var(--border-color);
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      max-height: 400px;
      overflow-y: auto;
    }

    .trace-turns {
      white-space: pre-wrap;
      word-break: break-all;
    }

    .trace-item.expanded .trace-body {
      display: block;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
    }

    .lightbox {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.9);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }

    .lightbox.active {
      display: flex;
    }

    .lightbox img {
      max-width: 90%;
      max-height: 90%;
    }

    .lightbox-close {
      position: absolute;
      top: 20px;
      right: 20px;
      color: white;
      font-size: 32px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <header class="header">
    <span class="logo">🔬</span>
    <h1>Bunsen Viewer</h1>
    <div class="run-info">
      <span id="experiment-name">Loading...</span>
      <span>→</span>
      <span id="agent-name">Loading...</span>
      <span id="status-badge" class="status">...</span>
    </div>
  </header>

  <div class="container">
    <div class="main-content">
      <!-- Tabbed Content -->
      <div class="card">
        <div class="tabs">
          <div class="tab active" data-tab="report">Report</div>
          <div class="tab" data-tab="screenshots">Screenshots</div>
          <div class="tab" data-tab="traces">Traces</div>
          <div class="tab" data-tab="logs">Logs</div>
          <div class="tab" data-tab="diff">Diff</div>
        </div>

        <div id="tab-report" class="tab-content active">
          <div id="report-content" class="report-content">
            <div class="empty-state">No evaluation report available</div>
          </div>
        </div>

        <div id="tab-screenshots" class="tab-content">
          <div id="screenshots-content" class="screenshots-grid">
            <div class="empty-state">No screenshots available</div>
          </div>
        </div>

        <div id="tab-traces" class="tab-content">
          <div id="traces-content" class="traces-list">
            <div class="empty-state">No traces available</div>
          </div>
        </div>

        <div id="tab-logs" class="tab-content">
          <div id="logs-content" class="logs-content">
            <div class="empty-state">No logs available</div>
          </div>
        </div>

        <div id="tab-diff" class="tab-content">
          <div id="diff-content" class="diff-content">
            <div class="empty-state">No workspace diff available</div>
          </div>
        </div>
      </div>

      <!-- Terminal Recording -->
      <div class="card">
        <div class="card-header">
          <h2>Terminal Recording</h2>
        </div>
        <div id="player-container">
          <div class="no-recording" id="no-recording">Loading...</div>
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <div class="sidebar">
      <div class="card">
        <div class="card-header">
          <h2>Summary</h2>
        </div>
        <div class="card-body">
          <div class="summary-grid">
            <div class="summary-item">
              <label>Duration</label>
              <div class="value" id="duration">-</div>
            </div>
            <div class="summary-item">
              <label>Cost</label>
              <div class="value" id="cost">-</div>
            </div>
            <div class="summary-item">
              <label>API Calls</label>
              <div class="value" id="api-calls">-</div>
            </div>
            <div class="summary-item">
              <label>Score</label>
              <div class="value" id="weighted-score">-</div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top: 16px;">
        <div class="card-header">
          <h2>Scores</h2>
        </div>
        <div class="card-body">
          <div id="criteria-list" class="criterion-list">
            <div class="empty-state">No scores available</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Lightbox for screenshots -->
  <div id="lightbox" class="lightbox">
    <span class="lightbox-close" onclick="closeLightbox()">&times;</span>
    <img id="lightbox-img" src="">
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script>
    // Tab handling
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Lightbox
    function openLightbox(src) {
      document.getElementById('lightbox-img').src = src;
      document.getElementById('lightbox').classList.add('active');
    }

    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('active');
    }

    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') closeLightbox();
    });

    // Format duration
    function formatDuration(ms) {
      if (!ms) return '-';
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return seconds + 's';
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return minutes + 'm ' + remainingSeconds + 's';
    }

    // Format cost
    function formatCost(usd) {
      if (!usd || usd === 0) return '-';
      return '$' + usd.toFixed(4);
    }

    // Format diff with syntax highlighting
    function formatDiff(diff) {
      if (!diff) return '<div class="empty-state">No workspace diff available</div>';
      const lines = diff.split('\\n');
      const result = [];
      let currentFile = null;

      for (const line of lines) {
        // Extract file path from +++ line (the destination file)
        if (line.startsWith('+++ ')) {
          // Extract path, removing timestamp and /workspace prefix
          let filePath = line.substring(4).split('\\t')[0].trim();
          // Remove /workspace/ or /workspace-source/ prefix
          filePath = filePath.replace(/^\\/workspace(-source)?\\//, '');
          if (filePath && filePath !== '/dev/null') {
            currentFile = filePath;
            result.push('<div class="diff-file-header">' + escapeHtml(filePath) + '</div>');
          }
          continue;
        }

        // Skip diff command lines, --- lines, and index lines
        if (line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('index ')) {
          continue;
        }

        // Hunk headers (@@ ... @@)
        if (line.startsWith('@@')) {
          result.push('<div class="diff-line hunk-header">' + escapeHtml(line) + '</div>');
          continue;
        }

        // Added lines
        if (line.startsWith('+')) {
          result.push('<div class="diff-line added">' + escapeHtml(line) + '</div>');
          continue;
        }

        // Removed lines
        if (line.startsWith('-')) {
          result.push('<div class="diff-line removed">' + escapeHtml(line) + '</div>');
          continue;
        }

        // Context lines
        if (line) {
          result.push('<div class="diff-line">' + escapeHtml(line) + '</div>');
        }
      }

      return result.join('');
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function viewScorerLog(logPath) {
      const match = logPath.match(/evaluation\\/criteria\\/(.+)\\.log$/);
      const slug = match ? match[1] : logPath.replace(/^scorer-/, '').replace(/\\.log$/, '');
      const res = await fetch('/api/scorer-log/' + slug);
      const data = await res.json();
      if (data.log) {
        const win = window.open('', '_blank');
        win.document.write('<html><head><title>Scorer Log: ' + escapeHtml(slug) + '</title><style>body{font-family:monospace;white-space:pre-wrap;padding:1em;background:#1a1a2e;color:#e0e0e0;}</style></head><body>' + escapeHtml(data.log) + '</body></html>');
      } else {
        alert('Log not found');
      }
    }

    // Load data
    async function loadData() {
      try {
        // Load run manifest and evaluation
        const runRes = await fetch('/api/run');
        const { manifest, evaluation } = await runRes.json();

        // Update header
        document.getElementById('experiment-name').textContent = manifest.experiment.id;
        document.getElementById('agent-name').textContent = manifest.agent.id + (manifest.agent.variant ? ':' + manifest.agent.variant : '');

        const statusBadge = document.getElementById('status-badge');
        statusBadge.textContent = manifest.status;
        statusBadge.className = 'status ' + manifest.status;

        // Update summary
        document.getElementById('duration').textContent = formatDuration(manifest.duration_ms);
        document.getElementById('cost').textContent = formatCost(manifest.usage?.estimated_cost_usd);
        document.getElementById('api-calls').textContent = manifest.usage?.total_ai_calls || 0;

        const weightedScore = evaluation?.weightedScore ?? manifest.evaluation?.weighted_score;
        if (weightedScore !== null && weightedScore !== undefined) {
          const scoreEl = document.getElementById('weighted-score');
          scoreEl.innerHTML = '<span class="score-badge">' + weightedScore.toFixed(2) + '/1</span>';
        }

        // Update criteria scores (filter out N/A scores)
        if (evaluation?.criteria?.length) {
          const scoredCriteria = evaluation.criteria.filter(c => c.score !== null && c.score !== undefined);
          if (scoredCriteria.length > 0) {
            document.getElementById('criteria-list').innerHTML = scoredCriteria.map(c => {
              const typeTag = c.scorerType && c.scorerType !== 'judge' ? \`<span style="font-size:0.75em;opacity:0.6;margin-left:0.5em">[\${c.scorerType}]</span>\` : '';
              const logLink = c.logPath ? \`<a href="#" onclick="viewScorerLog('\${c.logPath}');return false" style="font-size:0.8em;margin-left:0.5em">View Log</a>\` : '';
              return \`
                <div class="criterion-item">
                  <div class="criterion-header">
                    <span class="criterion-name">\${escapeHtml(c.id)}\${typeTag}</span>
                    <span class="criterion-score">\${c.score.toFixed(2)}\${logLink}</span>
                  </div>
                  <div class="criterion-summary">\${escapeHtml(c.summary || '')}</div>
                </div>
              \`;
            }).join('');
          }
        }

        // Update report
        if (evaluation?.report) {
          marked.setOptions({
            highlight: function(code, lang) {
              if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
              }
              return hljs.highlightAuto(code).value;
            }
          });
          document.getElementById('report-content').innerHTML = marked.parse(evaluation.report);
        }

        // Update screenshots
        const screenshotPaths = [];
        if (evaluation?.criteria) {
          evaluation.criteria.forEach(c => {
            if (c.screenshots) {
              c.screenshots.forEach(s => {
                screenshotPaths.push({ path: s, criterion: c.id });
              });
            }
          });
        }

        if (screenshotPaths.length > 0) {
          document.getElementById('screenshots-content').innerHTML = screenshotPaths.map(s => \`
            <div class="screenshot-item">
              <img src="/\${s.path}" alt="\${escapeHtml(s.criterion)}" onclick="openLightbox('/\${s.path}')">
              <div class="label">\${escapeHtml(s.criterion)}</div>
            </div>
          \`).join('');
        }

        // Load logs
        const logsRes = await fetch('/api/logs');
        const { logs } = await logsRes.json();
        if (logs) {
          document.getElementById('logs-content').textContent = logs;
        }

        // Load diff
        const diffRes = await fetch('/api/diff');
        const { diff } = await diffRes.json();
        if (diff) {
          document.getElementById('diff-content').innerHTML = formatDiff(diff);
        }

        // Load traces index (small) and lazy-load thread bodies on click.
        const tracesRes = await fetch('/api/traces/index');
        const tracesData = await tracesRes.json();
        const idx = tracesData?.index;
        if (idx?.threads?.length) {
          document.getElementById('traces-content').innerHTML = idx.threads.map((thread, ti) => {
            const model = thread.context?.model || 'unknown';
            const provider = thread.context?.provider || '';
            const stats = thread.stats || {};
            const threadId = thread.threadId;
            return \`
              <div class="trace-item" id="trace-\${ti}" data-thread-id="\${threadId}" data-loaded="0">
                <div class="trace-header" onclick="toggleTrace(\${ti})">
                  <span class="trace-expand">▶</span>
                  <span class="trace-model">\${escapeHtml(provider)} / \${escapeHtml(model)}</span>
                  <span class="trace-tokens">\${stats.totalInputTokens || 0} in / \${stats.totalOutputTokens || 0} out</span>
                </div>
                <div class="trace-body">
                  <div style="margin-bottom: 8px; color: var(--text-muted);">
                    Thread \${threadId} • \${thread.turnCount || 0} turns • \${stats.durationMs || 0}ms
                  </div>
                  <pre class="trace-turns" id="trace-turns-\${ti}">Loading...</pre>
                </div>
              </div>
            \`;
          }).join('');
        }

        // Load terminal recording
        try {
          const recordingRes = await fetch('/recording.cast');
          if (recordingRes.ok) {
            const container = document.getElementById('player-container');
            const noRecording = document.getElementById('no-recording');
            noRecording.textContent = 'Loading player...';

            // Create a fresh div for the player
            const playerDiv = document.createElement('div');
            playerDiv.id = 'asciinema-player';

            // Dynamically load asciinema-player script
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/asciinema-player@3.8.0/dist/bundle/asciinema-player.min.js';
            script.onload = function() {
              noRecording.style.display = 'none';
              container.appendChild(playerDiv);
              AsciinemaPlayer.create('/recording.cast', playerDiv, {
                fit: 'width',
                theme: 'monokai',
                idleTimeLimit: 2,
                speed: 1,
                controls: true
              });
            };
            script.onerror = function() {
              console.error('Failed to load asciinema-player script');
              noRecording.textContent = 'Error: Failed to load player';
            };
            document.head.appendChild(script);
          } else {
            document.getElementById('no-recording').textContent = 'No terminal recording available';
          }
        } catch (e) {
          console.error('Error loading recording:', e);
          document.getElementById('no-recording').textContent = 'No terminal recording available';
        }

      } catch (error) {
        console.error('Error loading data:', error);
      }
    }

    async function toggleTrace(index) {
      const item = document.getElementById('trace-' + index);
      item.classList.toggle('expanded');
      if (item.dataset.loaded === '1') return;
      const threadId = item.dataset.threadId;
      try {
        const res = await fetch('/api/traces/thread/' + encodeURIComponent(threadId));
        const data = await res.json();
        const turnsEl = document.getElementById('trace-turns-' + index);
        turnsEl.textContent = JSON.stringify(data.turns ?? [], null, 2);
        item.dataset.loaded = '1';
      } catch (e) {
        const turnsEl = document.getElementById('trace-turns-' + index);
        turnsEl.textContent = 'Failed to load thread: ' + (e && e.message || e);
      }
    }

    loadData();
  </script>
</body>
</html>`;
}
