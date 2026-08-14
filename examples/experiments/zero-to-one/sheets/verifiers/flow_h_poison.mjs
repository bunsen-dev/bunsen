// H6: an error cell in the criteria range (or at a summed position) POISONS the aggregate —
// it is never a silent non-match.
import { run, setCell, expectCell } from './_lib.mjs';

run('h-error-poison', async (page, check) => {
  await setCell(page, 'A1', '10');
  await setCell(page, 'A2', '=1/0'); // #DIV/0! in the criteria range (A3 left empty)
  // criteria range A1:A3 contains an error -> poison
  await setCell(page, 'E1', '1');
  await setCell(page, 'E2', '2');
  await setCell(page, 'E3', '3');
  await setCell(page, 'F1', '10');
  await setCell(page, 'F2', '=1/0'); // error at a summed position (E2 matches -> sum F2)
  await setCell(page, 'F3', '30');
  await setCell(page, 'C1', '=SUMIF(A1:A3,">0")');        // error in range -> #DIV/0!
  await setCell(page, 'C2', '=COUNTIF(A1:A3,">0")');      // error in range -> #DIV/0!
  await setCell(page, 'C3', '=SUMIF(E1:E3,">0",F1:F3)');  // error in sumRange -> #DIV/0!

  await expectCell(page, check, 'C1', '#DIV/0!');
  await expectCell(page, check, 'C2', '#DIV/0!');
  await expectCell(page, check, 'C3', '#DIV/0!');
});
