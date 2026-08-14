// F5: EDATE/EOMONTH with end-of-month CLAMP (not roll-forward).
import { run, setCell, expectCell } from './_lib.mjs';

run('f-edate-eomonth-clamp', async (page, check) => {
  await setCell(page, 'A1', '=EDATE(DATE(2024,1,31),1)');  // clamp -> 2024-02-29
  await setCell(page, 'A2', '=EDATE(DATE(2023,1,31),1)');  // clamp -> 2023-02-28
  await setCell(page, 'A3', '=EDATE(DATE(2024,3,31),-1)'); // clamp -> 2024-02-29
  await setCell(page, 'B1', '=EOMONTH(DATE(2024,2,10),0)'); // -> 2024-02-29
  await setCell(page, 'B2', '=EOMONTH(DATE(2024,12,1),1)'); // -> 2025-01-31
  await setCell(page, 'B3', '=EOMONTH(DATE(2024,1,15),-1)'); // -> 2023-12-31

  await expectCell(page, check, 'A1', '2024-02-29');
  await expectCell(page, check, 'A2', '2023-02-28');
  await expectCell(page, check, 'A3', '2024-02-29');
  await expectCell(page, check, 'B1', '2024-02-29');
  await expectCell(page, check, 'B2', '2025-01-31');
  await expectCell(page, check, 'B3', '2023-12-31');
});
