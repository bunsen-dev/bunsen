// A1 (headline): a leading unary minus binds TIGHTER than ^.  -2^2 = (-2)^2 = 4, not -4.
import { run, setCell, expectCell } from './_lib.mjs';

run('a-unary-exp', async (page, check) => {
  await setCell(page, 'E1', '=-2^2');   // (-2)^2 = 4
  await setCell(page, 'E2', '=-3^2');   // (-3)^2 = 9
  await setCell(page, 'E3', '=2^-2');   // 2^(-2) = 0.25
  await setCell(page, 'E4', '=-2^-2');  // (-2)^(-2) = 0.25

  await expectCell(page, check, 'E1', '4');
  await expectCell(page, check, 'E2', '9');
  await expectCell(page, check, 'E3', '0.25');
  await expectCell(page, check, 'E4', '0.25');
});
