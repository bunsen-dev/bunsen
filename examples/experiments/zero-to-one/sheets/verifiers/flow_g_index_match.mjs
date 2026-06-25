// G5: INDEX+MATCH combo; an error argument (a MATCH miss) PROPAGATES as #N/A,
// not #REF! (argument-error precedence beats numeric bounds).
import { run, setCell, expectCell } from './_lib.mjs';

async function seedTable(page) {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  for (const [a, t] of [['B1', 'Ten'], ['B2', 'Twenty'], ['B3', 'Thirty'], ['B4', 'Forty']]) await setCell(page, a, t);
  for (const [a, t] of [['C1', 'x'], ['C2', 'y'], ['C3', 'z'], ['C4', 'w']]) await setCell(page, a, t);
}

run('g-index-match-combo', async (page, check) => {
  await seedTable(page);
  await setCell(page, 'E1', '=INDEX(A1:C4,MATCH(30,A1:A4,0),3)'); // row3 col3 = z
  await setCell(page, 'E2', '=INDEX(A1:C4,MATCH(25,A1:A4,1),2)'); // approx -> row2 col2 = Twenty
  await setCell(page, 'E3', '=INDEX(A1:C4,MATCH(99,A1:A4,0),2)'); // MATCH miss -> #N/A propagates

  await expectCell(page, check, 'E1', 'z');
  await expectCell(page, check, 'E2', 'Twenty');
  await expectCell(page, check, 'E3', '#N/A');
});
