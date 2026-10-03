// D1 (headline): the strict 10-significant-figure display rule, end to end —
// float-noise suppression, sig-figs (not decimals), the integer-exact path, and -0 -> 0.
// All expected strings verified in Node against a reference implementation of the rule.
import { run, setCell, expectCell } from './_lib.mjs';

run('d-display-precision', async (page, check) => {
  await setCell(page, 'A1', '=0.1+0.2');          // 0.30000000000000004 -> "0.3"
  await setCell(page, 'A2', '=4.1+1.1');          // 5.199999999999999  -> "5.2"
  await setCell(page, 'A3', '=1.1*1.1');          // 1.2100000000000002 -> "1.21"
  await setCell(page, 'A4', '=100/3');            // -> "33.33333333" (10 sig figs)
  await setCell(page, 'A5', '=22/7');             // -> "3.142857143"
  await setCell(page, 'A6', '=1/8');              // -> "0.125"
  await setCell(page, 'A7', '=0.07*100');         // 7.000000000000001 -> "7"
  await setCell(page, 'A8', '=999999*999999');    // integer-exact -> "999998000001"
  await setCell(page, 'A9', '=1000000*1000000');  // -> "1000000000000" (no sci notation)
  await setCell(page, 'A10', '=-1*0');            // -0 -> "0"

  await expectCell(page, check, 'A1', '0.3');
  await expectCell(page, check, 'A2', '5.2');
  await expectCell(page, check, 'A3', '1.21');
  await expectCell(page, check, 'A4', '33.33333333');
  await expectCell(page, check, 'A5', '3.142857143');
  await expectCell(page, check, 'A6', '0.125');
  await expectCell(page, check, 'A7', '7');
  await expectCell(page, check, 'A8', '999998000001');
  await expectCell(page, check, 'A9', '1000000000000');
  await expectCell(page, check, 'A10', '0');
});
