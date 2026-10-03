// A2: ^ is RIGHT-associative (2^3^2 = 2^9 = 512, not 64). Also proves the formula bar
// echoes the source verbatim (no ** substitution / re-spacing).
import { run, setCell, selectCell, expectCell, expectFormulaBar } from './_lib.mjs';

run('a-exp-assoc', async (page, check) => {
  await setCell(page, 'D1', '=2^3^2');  // 2^(3^2) = 512
  await setCell(page, 'D2', '=4^3^2');  // 4^9 = 262144
  await setCell(page, 'D3', '=2^2^3');  // 2^8 = 256

  await expectCell(page, check, 'D1', '512');
  await expectCell(page, check, 'D2', '262144');
  await expectCell(page, check, 'D3', '256');

  await selectCell(page, 'D1');
  await expectFormulaBar(page, check, '=2^3^2'); // verbatim source
});
