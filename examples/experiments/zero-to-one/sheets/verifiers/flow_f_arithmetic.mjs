// F4: date type propagation — date+number -> date; date-date -> number (days).
import { run, setCell, expectCell } from './_lib.mjs';

run('f-date-arithmetic-types', async (page, check) => {
  await setCell(page, 'A1', '=DATE(2024,2,28)');
  await setCell(page, 'A2', '=A1+1');                       // -> 2024-02-29 (leap)
  await setCell(page, 'A3', '=DATE(2023,2,28)');
  await setCell(page, 'A4', '=A3+1');                       // -> 2023-03-01 (non-leap)
  await setCell(page, 'A5', '=DATE(2024,3,1)-1');          // -> 2024-02-29
  await setCell(page, 'A6', '=DATE(2024,12,31)-DATE(2024,1,1)'); // -> 365
  await setCell(page, 'A7', '=DATE(2025,1,1)-DATE(2024,1,1)');   // -> 366 (leap year span)

  await expectCell(page, check, 'A1', '2024-02-28');
  await expectCell(page, check, 'A2', '2024-02-29');
  await expectCell(page, check, 'A4', '2023-03-01');
  await expectCell(page, check, 'A5', '2024-02-29');
  await expectCell(page, check, 'A6', '365');
  await expectCell(page, check, 'A7', '366');
});
