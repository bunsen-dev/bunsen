// Divide-by-zero renders the exact token #DIV/0! (not Infinity / NaN / a thrown error).
import { run, setCell, expectCell } from './_lib.mjs';

run('flow-div-zero', async (page, check) => {
  await setCell(page, 'F1', '=1/0');
  await expectCell(page, check, 'F1', '#DIV/0!'); // literal divide-by-zero

  // Also via a reference that evaluates to zero in the denominator.
  await setCell(page, 'A1', '0');
  await setCell(page, 'F2', '=5/A1');
  await expectCell(page, check, 'F2', '#DIV/0!'); // =5/A1 with A1=0
});
