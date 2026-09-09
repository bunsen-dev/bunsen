// C1: the type lattice — text in arithmetic -> #VALUE!, empty cell -> 0, number -> number.
import { run, setCell, expectCell } from './_lib.mjs';

run('c-value-empty', async (page, check) => {
  await setCell(page, 'A1', 'hello'); // literal text
  // A2 deliberately left empty (never set)
  await setCell(page, 'A3', '42');

  await setCell(page, 'B1', '=A1+1'); // text + number -> #VALUE!
  await setCell(page, 'B2', '=A2+5'); // empty -> 0, so 5
  await setCell(page, 'B3', '=A2*3'); // empty -> 0, so 0
  await setCell(page, 'B4', '=A1*2'); // text * number -> #VALUE!
  await setCell(page, 'B5', '=A3*2'); // 84 (and "84", not "84.0")

  await expectCell(page, check, 'B1', '#VALUE!');
  await expectCell(page, check, 'B2', '5');
  await expectCell(page, check, 'B3', '0');
  await expectCell(page, check, 'B4', '#VALUE!');
  await expectCell(page, check, 'B5', '84');
});
