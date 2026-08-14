// H2: "<>0" excludes the empty cell (a non-number never matches a numeric criterion);
// SUMIF("<7") sums {0,4,0} = 4.  (A5 is deliberately left empty.)
import { run, setCell, expectCell } from './_lib.mjs';

run('h-notequal-empty', async (page, check) => {
  for (const [a, n] of [['A1', '0'], ['A2', '4'], ['A3', '0'], ['A4', '7']]) await setCell(page, a, n);
  // A5 left EMPTY (never set)
  await setCell(page, 'C1', '=COUNTIF(A1:A5,"<>0")'); // {4,7} -> 2 (empty excluded)
  await setCell(page, 'C2', '=COUNTIF(A1:A5,"=0")');  // {0,0} -> 2
  await setCell(page, 'C3', '=COUNTIF(A1:A5,"0")');   // bare = equality -> 2
  await setCell(page, 'C4', '=SUMIF(A1:A5,"<>0")');   // 4+7 -> 11
  await setCell(page, 'C5', '=COUNTIF(A1:A5,"<7")');  // {0,4,0} -> 3 (empty & 7 excluded)
  await setCell(page, 'C6', '=SUMIF(A1:A5,"<7")');    // 0+4+0 -> 4

  await expectCell(page, check, 'C1', '2');
  await expectCell(page, check, 'C2', '2');
  await expectCell(page, check, 'C3', '2');
  await expectCell(page, check, 'C4', '11');
  await expectCell(page, check, 'C5', '3');
  await expectCell(page, check, 'C6', '4');
});
