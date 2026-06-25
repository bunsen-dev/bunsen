// A3 (headline): & (concat) is LOWER precedence than + - * /.
// (Cells G/H/I are within the mandated A-J grid.)
import { run, setCell, expectCell } from './_lib.mjs';

run('a-amp-precedence', async (page, check) => {
  await setCell(page, 'G1', '="x"&1+1');   // "x"&(1+1) = "x2"
  await setCell(page, 'G2', '=1+2&3+4');    // (1+2)&(3+4) = "37"
  await setCell(page, 'G3', '=2&3*4');      // 2&(3*4) = "212"

  await expectCell(page, check, 'G1', 'x2');
  await expectCell(page, check, 'G2', '37');
  await expectCell(page, check, 'G3', '212');
});
