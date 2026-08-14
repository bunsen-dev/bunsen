// B2 (headline): IFERROR catches only real error tokens; ISERROR distinguishes error
// from a legit falsy (0 / FALSE). Fallback is not evaluated when value succeeds.
import { run, setCell, expectCell } from './_lib.mjs';

run('b-iferror', async (page, check) => {
  await setCell(page, 'A1', '0');
  await setCell(page, 'F1', '=IFERROR(1/A1, 42)'); // 1/0 errors -> 42
  await setCell(page, 'F2', '=IFERROR(A1, 42)');   // A1 is 0, not an error -> 0
  await setCell(page, 'F3', '=IFERROR(A1=1, 42)'); // FALSE, not an error -> FALSE
  await setCell(page, 'F4', '=ISERROR(1/A1)');     // TRUE
  await setCell(page, 'F5', '=ISERROR(A1)');       // FALSE (0 is not an error)
  await setCell(page, 'F6', '=IFERROR(10/2, 1/0)'); // value ok -> 5, fallback not evaluated

  await expectCell(page, check, 'F1', '42');
  await expectCell(page, check, 'F2', '0');
  await expectCell(page, check, 'F3', 'FALSE');
  await expectCell(page, check, 'F4', 'TRUE');
  await expectCell(page, check, 'F5', 'FALSE');
  await expectCell(page, check, 'F6', '5');
});
