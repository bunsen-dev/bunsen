// G6: VLOOKUP colIndex out of the range width -> #REF!, and #REF! has PRIORITY over a row miss.
import { run, setCell, expectCell } from './_lib.mjs';

async function seedTable(page) {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  for (const [a, t] of [['B1', 'Ten'], ['B2', 'Twenty'], ['B3', 'Thirty'], ['B4', 'Forty']]) await setCell(page, a, t);
  for (const [a, t] of [['C1', 'x'], ['C2', 'y'], ['C3', 'z'], ['C4', 'w']]) await setCell(page, a, t);
}

run('g-lookup-colindex-ref', async (page, check) => {
  await seedTable(page);
  await setCell(page, 'E1', '=VLOOKUP(30,A1:C4,4,FALSE)');  // col 4 > width 3 -> #REF!
  await setCell(page, 'E2', '=VLOOKUP(30,A1:C4,0,FALSE)');  // col 0 < 1 -> #REF!
  await setCell(page, 'E3', '=VLOOKUP(30,A1:C4,3,FALSE)');  // valid -> z
  await setCell(page, 'E4', '=VLOOKUP(999,A1:C4,4,FALSE)'); // #REF! beats the row miss

  await expectCell(page, check, 'E1', '#REF!');
  await expectCell(page, check, 'E2', '#REF!');
  await expectCell(page, check, 'E3', 'z');
  await expectCell(page, check, 'E4', '#REF!');
});
