// Circular-reference detection: a self-reference and a 2-cycle both render #CIRCULAR!
// and must NOT hang or crash the page. If the engine infinite-loops, the page freezes
// and the assertions below time out -> the verifier fails (score 0), which is correct.
// The 2-cycle is completed by a LATER edit (G3=G2 after G2=G3), so a faithful engine
// must re-evaluate dependents on edit, not only at type-time.
import { run, setCell, expectCell } from './_lib.mjs';

run('flow-circular', async (page, check) => {
  // Self-reference.
  await setCell(page, 'G1', '=G1');
  await expectCell(page, check, 'G1', '#CIRCULAR!'); // self-reference G1==G1

  // 2-cycle: G2 -> G3 -> G2, completed by the second edit.
  await setCell(page, 'G2', '=G3');
  await setCell(page, 'G3', '=G2');
  await expectCell(page, check, 'G2', '#CIRCULAR!'); // 2-cycle member
  await expectCell(page, check, 'G3', '#CIRCULAR!'); // 2-cycle member
});
