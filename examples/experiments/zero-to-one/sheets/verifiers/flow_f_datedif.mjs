// F6: DATEDIF D/M/Y complete-period boundaries (the brutal anniversary edges) + DAYS.
import { run, setCell, expectCell } from './_lib.mjs';

run('f-datedif-units', async (page, check) => {
  await setCell(page, 'A1', '=DATEDIF(DATE(2024,1,1),DATE(2024,3,1),"D")');   // 60 (leap)
  await setCell(page, 'A2', '=DATEDIF(DATE(2023,1,1),DATE(2023,3,1),"D")');   // 59
  await setCell(page, 'A3', '=DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"Y")'); // 3 (anniversary not reached)
  await setCell(page, 'A4', '=DATEDIF(DATE(2020,2,29),DATE(2024,2,29),"Y")'); // 4
  await setCell(page, 'A5', '=DATEDIF(DATE(2024,1,15),DATE(2024,3,14),"M")'); // 1 (day 14 < 15)
  await setCell(page, 'A6', '=DATEDIF(DATE(2024,1,15),DATE(2024,3,15),"M")'); // 2
  await setCell(page, 'A7', '=DAYS(DATE(2024,3,1),DATE(2024,2,1))');          // 29

  await expectCell(page, check, 'A1', '60');
  await expectCell(page, check, 'A2', '59');
  await expectCell(page, check, 'A3', '3');
  await expectCell(page, check, 'A4', '4');
  await expectCell(page, check, 'A5', '1');
  await expectCell(page, check, 'A6', '2');
  await expectCell(page, check, 'A7', '29');
});
