// THE differentiator: transitive recalculation across a dependency chain.
// A1 -> B1 (=A1*2) -> C1 (=B1+1). Editing A1 must update C1 (two hops away) with no
// further action. Eager single-pass / "recompute only the edited cell" engines fail.
// (Reads poll briefly, so a correct-but-async recompute is not penalized for latency.)
import { run, setCell, expectCell } from './_lib.mjs';

run('flow-recalc-chain', async (page, check) => {
  await setCell(page, 'A1', '5');
  await setCell(page, 'B1', '=A1*2');
  await setCell(page, 'C1', '=B1+1');

  await expectCell(page, check, 'B1', '10'); // initial B1 = A1*2
  await expectCell(page, check, 'C1', '11'); // initial C1 = B1+1

  // Edit only A1; do NOT touch B1/C1. Both must recompute transitively.
  await setCell(page, 'A1', '10');

  await expectCell(page, check, 'B1', '20'); // B1 recomputes
  await expectCell(page, check, 'C1', '21'); // C1 recomputes transitively
});
