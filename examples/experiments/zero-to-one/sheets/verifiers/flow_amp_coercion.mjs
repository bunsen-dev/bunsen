// A4: & concatenates operands as TEXT, coercing numbers via the display rule.
// (Cells H1..H4 are within the mandated A-J grid.)
import { run, setCell, expectCell } from './_lib.mjs';

run('a-amp-coercion', async (page, check) => {
  await setCell(page, 'H1', '="a"&"b"');   // "ab"
  await setCell(page, 'H2', '=1&2');        // "12"
  await setCell(page, 'H3', '=3&"."&5');    // "3.5"
  await setCell(page, 'H4', '=1&(1/4)');    // "1" & "0.25" = "10.25" (display-rule coercion)

  await expectCell(page, check, 'H1', 'ab');
  await expectCell(page, check, 'H2', '12');
  await expectCell(page, check, 'H3', '3.5');
  await expectCell(page, check, 'H4', '10.25');
});
