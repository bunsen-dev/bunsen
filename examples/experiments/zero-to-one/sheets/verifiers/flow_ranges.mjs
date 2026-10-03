// Range functions over a rectangular range: SUM / AVERAGE / MAX / MIN / COUNT.
// Includes a non-integer AVERAGE to exercise the 2-decimal trailing-zero-trim rule.
import { run, setCell, expectCell } from './_lib.mjs';

run('flow-ranges', async (page, check) => {
  await setCell(page, 'A1', '10');
  await setCell(page, 'A2', '20');
  await setCell(page, 'A3', '30');
  await setCell(page, 'C1', '=SUM(A1:A3)');
  await setCell(page, 'C2', '=AVERAGE(A1:A3)');
  await setCell(page, 'C3', '=MAX(A1:A3)');
  await setCell(page, 'C4', '=MIN(A1:A3)');
  await setCell(page, 'C5', '=COUNT(A1:A3)');

  await expectCell(page, check, 'C1', '60'); // SUM
  await expectCell(page, check, 'C2', '20'); // AVERAGE (integer result)
  await expectCell(page, check, 'C3', '30'); // MAX
  await expectCell(page, check, 'C4', '10'); // MIN
  await expectCell(page, check, 'C5', '3'); // COUNT

  // Non-integer average -> exercises "at most 2 decimals, trailing zeros trimmed".
  await setCell(page, 'B1', '1');
  await setCell(page, 'B2', '2');
  await setCell(page, 'C6', '=AVERAGE(B1:B2)');
  await expectCell(page, check, 'C6', '1.5');
});
