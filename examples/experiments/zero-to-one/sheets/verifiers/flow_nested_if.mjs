// B1 (headline): nested IF short-circuits at every level AND recomputes through the
// condition on edit. The unreached 1/B1 branch must never leak #DIV/0!.
import { run, setCell, expectCell } from './_lib.mjs';

run('b-nested-if', async (page, check) => {
  await setCell(page, 'A1', '0');
  await setCell(page, 'B1', '2');
  await setCell(page, 'H1', '=IF(A1=0, 100, IF(B1=0, 200, 1/B1))');

  await expectCell(page, check, 'H1', '100'); // A1=0 -> outer then-branch

  await setCell(page, 'A1', '9');             // flip outer cond; do NOT retype H1
  await expectCell(page, check, 'H1', '0.5'); // inner else: 1/B1 = 1/2

  await setCell(page, 'B1', '0');             // flip inner cond; do NOT retype H1
  await expectCell(page, check, 'H1', '200'); // inner then; 1/B1 unreached -> NO #DIV/0!
});
