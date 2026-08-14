// G4: INDEX(range, rowIndex, colIndex) — 1-based, range-relative; out-of-bounds -> #REF!.
import { run, setCell, expectCell } from './_lib.mjs';

async function seedTable(page) {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  for (const [a, t] of [['B1', 'Ten'], ['B2', 'Twenty'], ['B3', 'Thirty'], ['B4', 'Forty']]) await setCell(page, a, t);
  for (const [a, t] of [['C1', 'x'], ['C2', 'y'], ['C3', 'z'], ['C4', 'w']]) await setCell(page, a, t);
}

run('g-index-rc', async (page, check) => {
  await seedTable(page);
  await setCell(page, 'E1', '=INDEX(A1:C4,2,3)'); // y
  await setCell(page, 'E2', '=INDEX(A1:C4,1,1)'); // 10
  await setCell(page, 'E3', '=INDEX(A1:C4,4,2)'); // Forty
  await setCell(page, 'E4', '=INDEX(A1:C4,5,1)'); // row OOB -> #REF!
  await setCell(page, 'E5', '=INDEX(A1:C4,2,4)'); // col OOB -> #REF!

  await expectCell(page, check, 'E1', 'y');
  await expectCell(page, check, 'E2', '10');
  await expectCell(page, check, 'E3', 'Forty');
  await expectCell(page, check, 'E4', '#REF!');
  await expectCell(page, check, 'E5', '#REF!');
});
