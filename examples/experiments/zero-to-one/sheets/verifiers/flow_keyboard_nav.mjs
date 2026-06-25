// Keyboard navigation: arrow keys move the active cell by one within the grid bounds.
// The contract requires this to work right after a single click (document-level key
// handling, or focus moved to the grid on selection). expectActive polls, so a small
// async focus/update is tolerated.
import { run, selectCell, expectActive } from './_lib.mjs';

run('flow-keyboard-nav', async (page, check) => {
  await selectCell(page, 'B2');
  await expectActive(page, check, 'B2'); // single click selects B2

  await page.keyboard.press('ArrowRight');
  await expectActive(page, check, 'C2');

  await page.keyboard.press('ArrowDown');
  await expectActive(page, check, 'C3');

  await page.keyboard.press('ArrowLeft');
  await expectActive(page, check, 'B3');

  await page.keyboard.press('ArrowUp');
  await expectActive(page, check, 'B2');
});
