// E1: an exponential double-reference chain that requires a memoized/topological engine.
// Cn = C(n-1) + C(n-1). A memoized / topological engine evaluates each cell once -> O(n)
// and settles instantly. An unmemoized recursive-pull engine visits the dependency twice
// per cell -> O(2^n); by the deep cells it does ~2^29 additions on a single recompute, the
// page freezes, and the read never reaches the value. C30 = 2^29 = 536870912 (exact, < 2^53).
import { run, setCell, expectCellWithin } from './_lib.mjs';

run('e-exp-hang', async (page, check) => {
  await setCell(page, 'C1', '1');
  for (let n = 2; n <= 30; n++) {
    await setCell(page, `C${n}`, `=C${n - 1}+C${n - 1}`);
  }
  // Hard 8s cap; each read is raced against a stalled RPC so a frozen renderer fails
  // cleanly rather than wedging the verifier. (A naive recompute engine already hangs while seeding
  // the deep cells, which surfaces as a setCell timeout -> the run wrapper fails it.)
  await expectCellWithin(page, check, 'C30', '536870912', { capMs: 8000 });
});
