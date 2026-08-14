// G1: VLOOKUP exact match (exact=FALSE) + #N/A on a miss.
import { run, setCell, expectCell } from './_lib.mjs';

async function seedTable(page) {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  for (const [a, t] of [['B1', 'Ten'], ['B2', 'Twenty'], ['B3', 'Thirty'], ['B4', 'Forty']]) await setCell(page, a, t);
  for (const [a, t] of [['C1', 'x'], ['C2', 'y'], ['C3', 'z'], ['C4', 'w']]) await setCell(page, a, t);
}

run('g-vlookup-exact', async (page, check) => {
  await seedTable(page);
  await setCell(page, 'E1', '=VLOOKUP(30,A1:C4,2,FALSE)'); // Thirty
  await setCell(page, 'E2', '=VLOOKUP(20,A1:C4,3,FALSE)'); // y
  await setCell(page, 'E3', '=VLOOKUP(25,A1:C4,2,FALSE)'); // #N/A
  await setCell(page, 'E4', '=VLOOKUP(10,A1:C4,1,FALSE)'); // 10

  await expectCell(page, check, 'E1', 'Thirty');
  await expectCell(page, check, 'E2', 'y');
  await expectCell(page, check, 'E3', '#N/A');
  await expectCell(page, check, 'E4', '10');
});
