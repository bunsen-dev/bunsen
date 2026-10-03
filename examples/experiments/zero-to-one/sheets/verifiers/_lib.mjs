// Shared helpers for the deterministic Playwright verifiers, plus expectCellWithin() for
// the exponential-hang flow (hard wall-clock cap + read raced against a wedged RPC).

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const require = createRequire(import.meta.url);

function resolveChromium() {
  for (const p of [
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
    'playwright',
  ]) {
    try {
      return require(p).chromium;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not resolve the "playwright" module (expected globally installed in bunsen/visual).');
}

const BASE_URL = process.env.SHEETS_URL || 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcpProbe(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

export async function waitGrid(page, { viewport, deadlineMs = 180000 } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  const u = new URL(BASE_URL);
  const host = u.hostname;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  const start = Date.now();
  let listening = false;
  while (Date.now() - start < deadlineMs) {
    if (await tcpProbe(host, port)) { listening = true; break; }
    await sleep(1500);
  }
  if (!listening) {
    throw new Error(`Dev server never started listening on ${BASE_URL} within ${Math.round(deadlineMs / 1000)}s.`);
  }
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('[data-testid="cell-A1"]').first().waitFor({ state: 'attached', timeout: 30000 });
}

export async function setCell(page, addr, raw) {
  await page.dblclick(`[data-testid="cell-${addr}"]`, { timeout: 10000 });
  const input = page.locator('[data-testid="cell-input"]');
  await input.waitFor({ state: 'visible', timeout: 5000 });
  await input.fill(String(raw));
  await input.press('Enter');
  // Small settle; correctness is confirmed by the polling expect* reads. Do NOT wait for
  // the input to become 'hidden' — apps vary (a single static cell-input vs a per-edit
  // one), and that wait can burn its full timeout per cell, exceeding the per-criterion
  // timeout on the long seeding chains (E1/E2/E3).
  await page.waitForTimeout(50);
}

export async function cellText(page, addr) {
  const t = await page.locator(`[data-testid="cell-${addr}"]`).first().textContent();
  return (t ?? '').trim();
}

export async function selectCell(page, addr) {
  await page.click(`[data-testid="cell-${addr}"]`, { timeout: 10000 });
}

export async function activeAddr(page) {
  const t = await page.locator('[data-testid="active-cell"]').first().textContent();
  return (t ?? '').trim();
}

export async function formulaBar(page) {
  const fb = page.locator('[data-testid="formula-bar"]').first();
  const tag = await fb.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'input' || tag === 'textarea') return (await fb.inputValue()).trim();
  return ((await fb.textContent()) ?? '').trim();
}

async function pollEquals(getter, expected, timeout, interval = 100) {
  const start = Date.now();
  let last;
  for (;;) {
    try { last = await getter(); } catch { last = undefined; }
    if (last === expected) return last;
    if (Date.now() - start >= timeout) return last;
    await sleep(interval);
  }
}

export async function expectCell(page, check, addr, expected, { timeout = 3000 } = {}) {
  const got = await pollEquals(() => cellText(page, addr), expected, timeout);
  return check(got === expected, `${addr} == ${JSON.stringify(expected)}${got === expected ? '' : ` (got ${JSON.stringify(got)})`}`);
}

export async function expectActive(page, check, expected, { timeout = 2000 } = {}) {
  const got = await pollEquals(() => activeAddr(page), expected, timeout);
  return check(got === expected, `active cell == ${JSON.stringify(expected)}${got === expected ? '' : ` (got ${JSON.stringify(got)})`}`);
}

export async function expectFormulaBar(page, check, expected, { timeout = 2000 } = {}) {
  const got = await pollEquals(() => formulaBar(page), expected, timeout);
  return check(got === expected, `formula bar == ${JSON.stringify(expected)}${got === expected ? '' : ` (got ${JSON.stringify(got)})`}`);
}

// Race a promise against a timeout so a wedged Playwright RPC can't hang the verifier.
function raceTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms)),
  ]);
}

// Like expectCell but with a HARD wall-clock cap, and each read raced against a stall.
// Used by the exponential-hang flow: a frozen renderer makes reads time out -> fail.
export async function expectCellWithin(page, check, addr, expected, { capMs = 8000 } = {}) {
  const start = Date.now();
  let got;
  while (Date.now() - start < capMs) {
    got = await raceTimeout(cellText(page, addr), 1500, '<read-timeout>');
    if (got === expected) break;
    await sleep(150);
  }
  const elapsed = Date.now() - start;
  return check(
    got === expected,
    `${addr} == ${JSON.stringify(expected)} within ${capMs}ms (got ${JSON.stringify(got)} after ${elapsed}ms)`,
  );
}

export async function run(name, body) {
  const checks = [];
  const check = (cond, message) => {
    const ok = !!cond;
    checks.push({ ok, message });
    console.error(`  ${ok ? '✓' : '✗'} ${message}`);
    return ok;
  };
  const chromium = resolveChromium();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let error;
  try {
    const page = await browser.newPage();
    await waitGrid(page);
    await body(page, check);
  } catch (e) {
    error = e;
    console.error(`  ✗ EXCEPTION: ${e && e.message}`);
  } finally {
    await browser.close().catch(() => {});
  }
  const failed = checks.filter((c) => !c.ok).length;
  const passed = error == null && failed === 0;
  const summary = error
    ? `${name}: ERROR — ${error.message}`
    : `${name}: ${passed ? 'PASS' : 'FAIL'} (${checks.length - failed}/${checks.length} checks)`;
  console.log(summary);
  const out = process.env.BUNSEN_EVAL_RESULT;
  if (out) {
    try { writeFileSync(out, JSON.stringify({ score: passed ? 1 : 0, summary })); } catch { /* best-effort */ }
  }
  process.exit(passed ? 0 : 1);
}

export { BASE_URL };
