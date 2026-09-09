// C3: the EXACT error token survives a plain reference (not rewritten to a generic error).
import { run, setCell, expectCell } from './_lib.mjs';

run('c-error-identity', async (page, check) => {
  await setCell(page, 'A1', '=K1');    // col K is past J -> #REF!
  await setCell(page, 'B1', '=A1');    // plain reference reproduces #REF!
  await setCell(page, 'A2', '=1/0');   // #DIV/0!
  await setCell(page, 'B2', '=A2');    // -> #DIV/0!
  await setCell(page, 'A3', '=FOO()'); // unknown fn -> #NAME?
  await setCell(page, 'B3', '=A3');    // -> #NAME?

  await expectCell(page, check, 'A1', '#REF!');
  await expectCell(page, check, 'B1', '#REF!');
  await expectCell(page, check, 'B2', '#DIV/0!');
  await expectCell(page, check, 'B3', '#NAME?');
});
