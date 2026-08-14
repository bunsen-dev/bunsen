// B3: single-level IF evaluates only the taken branch (both directions).
import { run, setCell, expectCell } from './_lib.mjs';

run('b-if-shortcircuit', async (page, check) => {
  await setCell(page, 'A1', '0');
  await setCell(page, 'D1', '=IF(A1=0, 0, 1/A1)');   // taken=0; untaken 1/A1 not evaluated
  await setCell(page, 'A2', '4');
  await setCell(page, 'D2', '=IF(A2=0, 0, 1/A2)');   // 1/4
  await setCell(page, 'A3', '0');
  await setCell(page, 'D3', '=IF(A3<>0, 1/A3, 99)'); // cond false -> 99 (1/A3 untaken)
  await setCell(page, 'D4', '=IF(A1=0, 1/A1, 0)');   // taken branch DOES error -> #DIV/0!

  await expectCell(page, check, 'D1', '0');
  await expectCell(page, check, 'D2', '0.25');
  await expectCell(page, check, 'D3', '99');
  await expectCell(page, check, 'D4', '#DIV/0!');
});
