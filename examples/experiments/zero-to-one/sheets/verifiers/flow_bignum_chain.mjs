// E2: a 30-deep linear chain recomputes transitively after a head edit, and large exact
// integers display as plain digits (no scientific notation, no .00, no float drift).
// Depth 30 keeps UI seeding within the criterion timeout; 2^29 / 2^30 are exact (< 2^53).
import { run, setCell, expectCell } from './_lib.mjs';

run('e-bignum-chain', async (page, check) => {
  await setCell(page, 'A1', '1');
  for (let n = 2; n <= 30; n++) {
    await setCell(page, `A${n}`, `=A${n - 1}*2`);
  }
  await expectCell(page, check, 'A30', '536870912', { timeout: 5000 }); // 2^29

  await setCell(page, 'A1', '2'); // head edit must propagate transitively to A30
  await expectCell(page, check, 'A30', '1073741824', { timeout: 6000 }); // 2^30 (exact, < 2^53)
});
