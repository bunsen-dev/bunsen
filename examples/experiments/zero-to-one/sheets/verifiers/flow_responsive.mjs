// A little visual, scored objectively: at 375px the page must not overflow horizontally
// (a wide grid should scroll within its own container, not push the whole page wider).
// This is mandated by contract clause 9 in the task prompt.
import { run, waitGrid, expectCell } from './_lib.mjs';

run('flow-responsive', async (page, check) => {
  // Mobile width.
  await waitGrid(page, { viewport: { width: 375, height: 667 } });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(overflow <= 2, `no horizontal page overflow at 375px (overflow=${overflow}px)`);
  check((await page.locator('[data-testid="cell-A1"]').count()) > 0, 'grid still present at 375px');

  // Desktop width: grid renders normally and resets to empty on reload.
  await waitGrid(page, { viewport: { width: 1280, height: 800 } });
  await expectCell(page, check, 'A1', '');
});
