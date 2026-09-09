// Arithmetic: operator precedence (* before +) and parentheses. Also proves the
// formula bar shows the SOURCE while the cell BODY shows the COMPUTED value.
import { run, setCell, selectCell, expectCell, expectFormulaBar } from './_lib.mjs';

run('flow-arithmetic', async (page, check) => {
  await setCell(page, 'A1', '3');
  await setCell(page, 'B1', '4');
  await setCell(page, 'D1', '=A1+B1*2'); // 3 + (4*2) = 11  (precedence)
  await setCell(page, 'D2', '=(A1+B1)/2'); // (3+4)/2 = 3.5  (parens + division)

  await expectCell(page, check, 'D1', '11'); // precedence respected
  await expectCell(page, check, 'D2', '3.5'); // parentheses respected

  await selectCell(page, 'D1');
  await expectFormulaBar(page, check, '=A1+B1*2'); // formula bar shows the source...
  await expectCell(page, check, 'D1', '11'); // ...while the body shows the computed value
});
