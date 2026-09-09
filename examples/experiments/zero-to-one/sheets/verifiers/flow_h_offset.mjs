// H3: SUMIF/AVERAGEIF with an offset sumRange (aligned by ordinal position); text criteria
// are case-insensitive; AVERAGEIF over zero matches -> #DIV/0!.
import { run, setCell, expectCell } from './_lib.mjs';

run('h-offset-sumrange', async (page, check) => {
  for (const [a, t] of [['A1', 'east'], ['A2', 'west'], ['A3', 'east'], ['A4', 'north']]) await setCell(page, a, t);
  for (const [a, n] of [['C1', '10'], ['C2', '20'], ['C3', '30'], ['C4', '40']]) await setCell(page, a, n);
  await setCell(page, 'E1', '=SUMIF(A1:A4,"east",C1:C4)');     // rows 1,3 -> 10+30 = 40
  await setCell(page, 'E2', '=SUMIF(A1:A4,"EAST",C1:C4)');     // case-insensitive -> 40
  await setCell(page, 'E3', '=AVERAGEIF(A1:A4,"east",C1:C4)'); // 40/2 -> 20
  await setCell(page, 'E4', '=SUMIF(A1:A4,"south",C1:C4)');    // no match -> 0
  await setCell(page, 'E5', '=AVERAGEIF(A1:A4,"south",C1:C4)'); // no match -> #DIV/0!

  await expectCell(page, check, 'E1', '40');
  await expectCell(page, check, 'E2', '40');
  await expectCell(page, check, 'E3', '20');
  await expectCell(page, check, 'E4', '0');
  await expectCell(page, check, 'E5', '#DIV/0!');
});
