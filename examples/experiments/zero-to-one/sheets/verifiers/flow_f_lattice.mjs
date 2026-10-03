// F7: dates interplay with the rest of the lattice — comparisons, IF, &, IFERROR.
import { run, setCell, expectCell } from './_lib.mjs';

run('f-date-lattice-interplay', async (page, check) => {
  await setCell(page, 'A1', '=DATE(2024,2,29)=DATE(2024,2,29)');  // TRUE
  await setCell(page, 'A2', '=DATE(2024,2,29)<DATE(2024,3,1)');   // TRUE
  await setCell(page, 'A3', '=IF(DATE(2024,1,1)<DATE(2024,12,31),YEAR(DATE(2024,6,15)),0)'); // 2024
  await setCell(page, 'A4', '=YEAR(DATE(2024,1,1))+MONTH(DATE(2024,5,1))'); // 2024 + 5 = 2029
  await setCell(page, 'A5', '="D:"&DATE(2024,2,29)');             // D:2024-02-29
  await setCell(page, 'A6', '=IFERROR(YEAR(DATE(2024,2,29)),-1)'); // 2024 (not an error)

  await expectCell(page, check, 'A1', 'TRUE');
  await expectCell(page, check, 'A2', 'TRUE');
  await expectCell(page, check, 'A3', '2024');
  await expectCell(page, check, 'A4', '2029');
  await expectCell(page, check, 'A5', 'D:2024-02-29');
  await expectCell(page, check, 'A6', '2024');
});
