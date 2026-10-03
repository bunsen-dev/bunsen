// Exercise the image-installed Playwright and Chromium under each scorer user.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('/usr/lib/node_modules/playwright');

async function main() {
  fs.accessSync(chromium.executablePath(), fs.constants.R_OK | fs.constants.X_OK);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <h1>Visual scorer smoke test</h1>
      <button onclick="document.querySelector('output').textContent++">Click me</button>
      <output>0</output>
    `);
    assert.equal(await page.locator('h1').textContent(), 'Visual scorer smoke test');
    assert.equal(await page.locator('output').textContent(), '0');
    const before = await page.screenshot();
    await page.getByRole('button', { name: 'Click me' }).click();
    assert.equal(await page.locator('output').textContent(), '1');
    const after = await page.screenshot();
    for (const screenshot of [before, after]) {
      assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
    assert.ok(!before.equals(after), 'Clicking should change the rendered screenshot');
    console.log(`uid=${process.getuid()}: Chromium launched, counter incremented, two PNGs captured`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
