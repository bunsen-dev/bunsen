// F3: proleptic-Gregorian leap rule (1900 not leap, 2000 leap) + WEEKDAY (Sunday=1).
import { run, setCell, expectCell } from './_lib.mjs';

run('f-leap-year-weekday', async (page, check) => {
  await setCell(page, 'A1', '=DATE(1900,2,29)'); // 1900 not leap -> 1900-03-01
  await setCell(page, 'A2', '=DATE(2000,2,29)'); // 2000 leap -> 2000-02-29
  await setCell(page, 'A3', '=MONTH(DATE(1900,2,29))');
  await setCell(page, 'A4', '=DAY(DATE(1900,2,29))');
  await setCell(page, 'B1', '=WEEKDAY(DATE(2024,7,4))');  // Thu -> 5
  await setCell(page, 'B2', '=WEEKDAY(DATE(2024,1,7))');  // Sun -> 1
  await setCell(page, 'B3', '=WEEKDAY(DATE(2023,12,25))'); // Mon -> 2

  await expectCell(page, check, 'A1', '1900-03-01');
  await expectCell(page, check, 'A2', '2000-02-29');
  await expectCell(page, check, 'A3', '3');
  await expectCell(page, check, 'A4', '1');
  await expectCell(page, check, 'B1', '5');
  await expectCell(page, check, 'B2', '1');
  await expectCell(page, check, 'B3', '2');
});
