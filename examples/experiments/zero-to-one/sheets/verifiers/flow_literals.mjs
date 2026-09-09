// Control flow: literal values render verbatim, and the formula bar shows the raw value.
import { run, setCell, selectCell, expectCell, expectFormulaBar } from './_lib.mjs';

run('flow-literals', async (page, check) => {
  await setCell(page, 'D1', '42');
  await setCell(page, 'D2', 'hello');

  await expectCell(page, check, 'D1', '42'); // literal number
  await expectCell(page, check, 'D2', 'hello'); // literal string

  await selectCell(page, 'D1');
  await expectFormulaBar(page, check, '42'); // formula bar shows the raw value
});
