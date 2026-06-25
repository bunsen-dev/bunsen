// E3: a cycle formed by a LATER edit marks every member #CIRCULAR!, and BREAKING it must
// clear the error from the whole chain (per-edit cycle re-evaluation, not a sticky flag).
// Depth 30 keeps UI seeding within the criterion timeout.
import { run, setCell, expectCell } from './_lib.mjs';

run('e-cycle-recovery', async (page, check) => {
  await setCell(page, 'A1', '1');
  for (let n = 2; n <= 30; n++) {
    await setCell(page, `A${n}`, `=A${n - 1}+1`);
  }
  await expectCell(page, check, 'A30', '30'); // 1 + 29

  // Insert a back-edge A1 = A30 -> forms a 30-cell cycle.
  await setCell(page, 'A1', '=A30');
  await expectCell(page, check, 'A1', '#CIRCULAR!');
  await expectCell(page, check, 'A30', '#CIRCULAR!');

  // Break the cycle: the whole chain must recover; no cell may stay #CIRCULAR!.
  await setCell(page, 'A1', '10');
  await expectCell(page, check, 'A1', '10');
  await expectCell(page, check, 'A15', '24'); // 10 + 14
  await expectCell(page, check, 'A30', '39'); // 10 + 29
});
