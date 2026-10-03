// F2: DATE overflow-normalization (never clamps, never rejects).
import { run, setCell, expectCell } from './_lib.mjs';

run('f-date-overflow-normalization', async (page, check) => {
  await setCell(page, 'A1', '=DATE(2023,2,29)'); // -> 2023-03-01
  await setCell(page, 'A2', '=DATE(2024,2,30)'); // -> 2024-03-01
  await setCell(page, 'A3', '=DATE(2024,13,1)'); // -> 2025-01-01
  await setCell(page, 'A4', '=DATE(2024,1,0)');  // -> 2023-12-31
  await setCell(page, 'A5', '=DATE(2024,3,0)');  // -> 2024-02-29
  await setCell(page, 'A6', '=DATE(2025,0,15)'); // -> 2024-12-15
  await setCell(page, 'B4', '=YEAR(A4)');
  await setCell(page, 'C4', '=MONTH(A4)');
  await setCell(page, 'D4', '=DAY(A4)');

  await expectCell(page, check, 'A1', '2023-03-01');
  await expectCell(page, check, 'A2', '2024-03-01');
  await expectCell(page, check, 'A3', '2025-01-01');
  await expectCell(page, check, 'A4', '2023-12-31');
  await expectCell(page, check, 'A5', '2024-02-29');
  await expectCell(page, check, 'A6', '2024-12-15');
  await expectCell(page, check, 'B4', '2023');
  await expectCell(page, check, 'C4', '12');
  await expectCell(page, check, 'D4', '31');
});
