// H4: a numeric criterion matches ONLY number cells — text "hi" and boolean TRUE are excluded;
// TRUE is NOT counted as 1 (SUMIF(">0") over {5,TRUE,hi,5} = 10, not 11).
import { run, setCell, expectCell } from './_lib.mjs';

run('h-numeric-excludes-nonnumber', async (page, check) => {
  for (const [a, v] of [['A1', '5'], ['A2', 'hi'], ['A3', '7'], ['A4', '12']]) await setCell(page, a, v);
  await setCell(page, 'D1', '5');
  await setCell(page, 'D2', '=TRUE'); // a boolean value
  await setCell(page, 'D3', 'hi');
  await setCell(page, 'D4', '5');
  await setCell(page, 'C1', '=COUNTIF(A1:A4,">3")'); // {5,7,12} -> 3 (hi excluded)
  await setCell(page, 'C2', '=SUMIF(A1:A4,">3")');   // 5+7+12 -> 24
  await setCell(page, 'C3', '=COUNTIF(D1:D4,"5")');  // number 5 cells D1,D4 -> 2
  await setCell(page, 'C4', '=COUNTIF(D1:D4,">0")'); // numbers > 0 -> {5,5} -> 2 (TRUE excluded)
  await setCell(page, 'C5', '=SUMIF(D1:D4,">0")');   // 5+5 -> 10 (TRUE-as-1 would give 11)

  await expectCell(page, check, 'C1', '3');
  await expectCell(page, check, 'C2', '24');
  await expectCell(page, check, 'C3', '2');
  await expectCell(page, check, 'C4', '2');
  await expectCell(page, check, 'C5', '10');
});
