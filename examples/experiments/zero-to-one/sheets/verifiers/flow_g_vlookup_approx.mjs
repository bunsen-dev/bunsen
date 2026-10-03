// G2: VLOOKUP approximate match is the DEFAULT (4th arg omitted) — largest first-col <= key.
import { run, setCell, expectCell } from './_lib.mjs';

async function seedTable(page) {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  for (const [a, t] of [['B1', 'Ten'], ['B2', 'Twenty'], ['B3', 'Thirty'], ['B4', 'Forty']]) await setCell(page, a, t);
  for (const [a, t] of [['C1', 'x'], ['C2', 'y'], ['C3', 'z'], ['C4', 'w']]) await setCell(page, a, t);
}

run('g-vlookup-approx-default', async (page, check) => {
  await seedTable(page);
  await setCell(page, 'E1', '=VLOOKUP(25,A1:C4,3)'); // <=25 -> 20 -> C2 = y
  await setCell(page, 'E2', '=VLOOKUP(40,A1:C4,1)'); // <=40 includes 40 -> row4 col1 = 40
  await setCell(page, 'E3', '=VLOOKUP(35,A1:C4,2)'); // <=35 -> 30 -> Thirty
  await setCell(page, 'E4', '=VLOOKUP(5,A1:C4,2)');  // 5 < min 10 -> #N/A

  await expectCell(page, check, 'E1', 'y');
  await expectCell(page, check, 'E2', '40');
  await expectCell(page, check, 'E3', 'Thirty');
  await expectCell(page, check, 'E4', '#N/A');
});
