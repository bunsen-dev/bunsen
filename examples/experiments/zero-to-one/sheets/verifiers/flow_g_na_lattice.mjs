// G7: #N/A is a full error-lattice member — propagates through refs, poisons arithmetic and
// ranges, is caught by IFERROR, makes ISERROR TRUE; ISERROR(success) is FALSE.
import { run, setCell, expectCell } from './_lib.mjs';

run('g-na-token-lattice', async (page, check) => {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  await setCell(page, 'E1', '=VLOOKUP(99,A1:A4,1,FALSE)'); // #N/A
  await setCell(page, 'E2', '=E1');                         // reference reproduces #N/A
  await setCell(page, 'E3', '=E1+5');                       // arithmetic poisoned -> #N/A
  await setCell(page, 'E4', '=SUM(A1:A4)+E1');              // 100 + #N/A -> #N/A
  await setCell(page, 'E5', '=ISERROR(E1)');               // TRUE
  await setCell(page, 'E6', '=IFERROR(E1,-1)');            // -1
  await setCell(page, 'E7', '=ISERROR(VLOOKUP(30,A1:A4,1,FALSE))'); // success -> FALSE

  await expectCell(page, check, 'E1', '#N/A');
  await expectCell(page, check, 'E2', '#N/A');
  await expectCell(page, check, 'E3', '#N/A');
  await expectCell(page, check, 'E4', '#N/A');
  await expectCell(page, check, 'E5', 'TRUE');
  await expectCell(page, check, 'E6', '-1');
  await expectCell(page, check, 'E7', 'FALSE');
});
