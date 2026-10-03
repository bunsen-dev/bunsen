// Smoke gate: app boots, grid (A1..J100) + formula bar render, sheet starts empty.
import { run, selectCell, expectCell, expectActive, expectFormulaBar } from './_lib.mjs';

run('app-boots', async (page, check) => {
  check((await page.locator('[data-testid="formula-bar"]').count()) > 0, 'formula bar is present');
  check((await page.locator('[data-testid="active-cell"]').count()) > 0, 'active-cell indicator is present');
  check((await page.locator('[data-testid="cell-J50"]').count()) > 0, 'grid covers A1..J50 (cell-J50 present)');

  await expectCell(page, check, 'A1', ''); // boots empty

  await selectCell(page, 'A1');
  await expectActive(page, check, 'A1');
  await expectFormulaBar(page, check, '');
});
