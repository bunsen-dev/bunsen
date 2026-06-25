// H1: numeric criterion boundary — ">5" excludes 5, ">=5" includes it.
import { run, setCell, expectCell } from './_lib.mjs';

run('h-numeric-boundary', async (page, check) => {
  for (const [a, n] of [['A1', '3'], ['A2', '5'], ['A3', '8'], ['A4', '5'], ['A5', '10']]) await setCell(page, a, n);
  await setCell(page, 'C1', '=COUNTIF(A1:A5,">5")');    // {8,10} -> 2
  await setCell(page, 'C2', '=COUNTIF(A1:A5,">=5")');   // {5,8,5,10} -> 4
  await setCell(page, 'C3', '=SUMIF(A1:A5,">5")');      // 8+10 -> 18
  await setCell(page, 'C4', '=SUMIF(A1:A5,">=5")');     // 5+8+5+10 -> 28
  await setCell(page, 'C5', '=AVERAGEIF(A1:A5,">5")');  // 18/2 -> 9
  await setCell(page, 'C6', '=AVERAGEIF(A1:A5,">=5")'); // 28/4 -> 7

  await expectCell(page, check, 'C1', '2');
  await expectCell(page, check, 'C2', '4');
  await expectCell(page, check, 'C3', '18');
  await expectCell(page, check, 'C4', '28');
  await expectCell(page, check, 'C5', '9');
  await expectCell(page, check, 'C6', '7');
});
