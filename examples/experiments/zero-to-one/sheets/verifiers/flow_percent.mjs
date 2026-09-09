// A5: postfix % divides by 100 and binds tightest (tighter than ^).
// (Cells I1..I4 are within the mandated A-J grid.)
import { run, setCell, expectCell } from './_lib.mjs';

run('a-percent', async (page, check) => {
  await setCell(page, 'I1', '=50%');      // 0.5
  await setCell(page, 'I2', '=200%');     // 2
  await setCell(page, 'I3', '=50%*4');    // 0.5 * 4 = 2
  await setCell(page, 'I4', '=2^50%');    // 2^(0.5) = sqrt(2)

  await expectCell(page, check, 'I1', '0.5');
  await expectCell(page, check, 'I2', '2');
  await expectCell(page, check, 'I3', '2');
  await expectCell(page, check, 'I4', '1.414213562'); // 10 sig figs
});
