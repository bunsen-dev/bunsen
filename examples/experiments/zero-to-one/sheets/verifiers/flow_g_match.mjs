// G3: MATCH returns the 1-based position; exact (0) vs approximate (default 1).
import { run, setCell, expectCell } from './_lib.mjs';

run('g-match-position-types', async (page, check) => {
  for (const [a, n] of [['A1', '10'], ['A2', '20'], ['A3', '30'], ['A4', '40']]) await setCell(page, a, n);
  await setCell(page, 'E1', '=MATCH(30,A1:A4,0)'); // exact -> position 3
  await setCell(page, 'E2', '=MATCH(25,A1:A4,0)'); // exact miss -> #N/A
  await setCell(page, 'E3', '=MATCH(25,A1:A4,1)'); // approx -> largest <=25 = 20 -> pos 2
  await setCell(page, 'E4', '=MATCH(40,A1:A4)');   // default 1 -> pos 4
  await setCell(page, 'E5', '=MATCH(5,A1:A4,1)');  // 5 below all -> #N/A

  await expectCell(page, check, 'E1', '3');
  await expectCell(page, check, 'E2', '#N/A');
  await expectCell(page, check, 'E3', '2');
  await expectCell(page, check, 'E4', '4');
  await expectCell(page, check, 'E5', '#N/A');
});
