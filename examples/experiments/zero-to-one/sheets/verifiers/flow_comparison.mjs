// B5 (baseline tier): comparison operators + boolean tokens TRUE/FALSE + bool->number.
import { run, setCell, expectCell } from './_lib.mjs';

run('flow-comparison', async (page, check) => {
  await setCell(page, 'A1', '5');
  await setCell(page, 'B1', '5');
  await setCell(page, 'C1', '3');
  await setCell(page, 'E1', '=A1=B1');                 // 5=5
  await setCell(page, 'E2', '=A1<>C1');                // 5<>3
  await setCell(page, 'E3', '=C1>=A1');                // 3>=5
  await setCell(page, 'E4', '=AND(A1>C1, B1=5)');      // T and T
  await setCell(page, 'E5', '=OR(A1<C1, NOT(B1=5))');  // F or F
  await setCell(page, 'E6', '=(A1>C1)+(B1=5)');        // 1 + 1

  await expectCell(page, check, 'E1', 'TRUE');
  await expectCell(page, check, 'E2', 'TRUE');
  await expectCell(page, check, 'E3', 'FALSE');
  await expectCell(page, check, 'E4', 'TRUE');
  await expectCell(page, check, 'E5', 'FALSE');
  await expectCell(page, check, 'E6', '2');            // booleans coerce to 1/0
});
