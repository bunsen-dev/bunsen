// F1: DATE construct + ISO display + YEAR/MONTH/DAY (and a date never leaks its serial).
import { run, setCell, expectCell, cellText } from './_lib.mjs';

run('f-date-construct-display', async (page, check) => {
  await setCell(page, 'A1', '=DATE(2024,2,29)');
  await setCell(page, 'A2', '=DATE(2024,7,4)');
  await setCell(page, 'A3', '=DATE(2023,12,1)');
  await setCell(page, 'B1', '=YEAR(A1)');
  await setCell(page, 'B2', '=MONTH(A1)');
  await setCell(page, 'B3', '=DAY(A1)');
  await setCell(page, 'B4', '=YEAR(A2)');
  await setCell(page, 'B5', '=MONTH(A2)');
  await setCell(page, 'B6', '=DAY(A2)');

  await expectCell(page, check, 'A1', '2024-02-29');
  await expectCell(page, check, 'A2', '2024-07-04');
  await expectCell(page, check, 'A3', '2023-12-01');
  await expectCell(page, check, 'B1', '2024');
  await expectCell(page, check, 'B2', '2');
  await expectCell(page, check, 'B3', '29');
  await expectCell(page, check, 'B4', '2024');
  await expectCell(page, check, 'B5', '7');
  await expectCell(page, check, 'B6', '4');
  // A date must display as ISO, never as its raw serial number.
  check((await cellText(page, 'A1')) !== '19782', 'A1 does not leak its serial (19782)');
});
