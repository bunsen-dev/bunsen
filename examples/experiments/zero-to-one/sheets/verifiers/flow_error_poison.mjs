// C2: an error in a range poisons the range function; an error operand poisons arithmetic.
import { run, setCell, expectCell } from './_lib.mjs';

run('c-error-poison', async (page, check) => {
  await setCell(page, 'A1', '10');
  await setCell(page, 'A2', '=1/0'); // #DIV/0!
  await setCell(page, 'A3', '20');

  await setCell(page, 'C1', '=SUM(A1:A3)');     // range contains an error -> #DIV/0!
  await setCell(page, 'C2', '=AVERAGE(A1:A3)'); // -> #DIV/0!
  await setCell(page, 'C3', '=MAX(A1:A3)');     // -> #DIV/0!
  await setCell(page, 'D1', '=A2*2');           // arithmetic with error operand -> #DIV/0!

  await expectCell(page, check, 'C1', '#DIV/0!');
  await expectCell(page, check, 'C2', '#DIV/0!');
  await expectCell(page, check, 'C3', '#DIV/0!');
  await expectCell(page, check, 'D1', '#DIV/0!');
});
