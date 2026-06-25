// C4: #NAME? (unknown function) vs #REF! (reference outside the A1:J100 grid).
import { run, setCell, expectCell } from './_lib.mjs';

run('c-name-ref', async (page, check) => {
  await setCell(page, 'A1', '5');
  await setCell(page, 'F1', '=FOO(A1)'); // unknown function -> #NAME?
  await setCell(page, 'F3', '=K1');      // column past J -> #REF!
  await setCell(page, 'F4', '=A51');     // row past 50 -> #REF!

  await expectCell(page, check, 'F1', '#NAME?');
  await expectCell(page, check, 'F3', '#REF!');
  await expectCell(page, check, 'F4', '#REF!');
});
