// H7: zero-match totals (SUMIF->0, COUNTIF->0, AVERAGEIF->#DIV/0!), then recompute on edit.
import { run, setCell, expectCell } from './_lib.mjs';

run('h-nomatch-recalc', async (page, check) => {
  for (const [a, n] of [['A1', '2'], ['A2', '4'], ['A3', '6']]) await setCell(page, a, n);
  await setCell(page, 'C1', '=SUMIF(A1:A3,">100")');
  await setCell(page, 'C2', '=COUNTIF(A1:A3,">100")');
  await setCell(page, 'C3', '=AVERAGEIF(A1:A3,">100")');

  await expectCell(page, check, 'C1', '0');         // no match -> 0
  await expectCell(page, check, 'C2', '0');
  await expectCell(page, check, 'C3', '#DIV/0!');   // no match -> #DIV/0!

  await setCell(page, 'A3', '200'); // now one match; aggregates must recompute
  await expectCell(page, check, 'C1', '200');
  await expectCell(page, check, 'C2', '1');
  await expectCell(page, check, 'C3', '200');
});
