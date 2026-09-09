// D2 (headline): ROUND(value, n) with round-HALF-AWAY-FROM-ZERO, on the exact decimal
// value (not a binary-float artifact). Math.round / toFixed-based impls fail these.
import { run, setCell, expectCell } from './_lib.mjs';

run('d-round', async (page, check) => {
  await setCell(page, 'A1', '=ROUND(1.005,2)'); // -> 1.01  (float 1.005 is 1.00499...; decimal-exact wins)
  await setCell(page, 'A2', '=ROUND(2.675,2)'); // -> 2.68
  await setCell(page, 'A3', '=ROUND(-2.5,0)');  // -> -3    (half away from zero)
  await setCell(page, 'A4', '=ROUND(2.5,0)');   // -> 3
  await setCell(page, 'A5', '=ROUND(0.615,2)'); // -> 0.62
  await setCell(page, 'A6', '=ROUND(-0.5,0)');  // -> -1    (also a -0 guard)

  await expectCell(page, check, 'A1', '1.01');
  await expectCell(page, check, 'A2', '2.68');
  await expectCell(page, check, 'A3', '-3');
  await expectCell(page, check, 'A4', '3');
  await expectCell(page, check, 'A5', '0.62');
  await expectCell(page, check, 'A6', '-1');
});
