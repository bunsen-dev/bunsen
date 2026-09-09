// H5: text criteria are whole-cell, case-insensitive, with NO wildcards (* and ? are literal).
import { run, setCell, expectCell } from './_lib.mjs';

run('h-text-exact-no-wildcard', async (page, check) => {
  for (const [a, t] of [['A1', 'apple'], ['A2', 'Apple'], ['A3', 'apples'], ['A4', 'app'], ['A5', 'a*ple']]) {
    await setCell(page, a, t);
  }
  await setCell(page, 'C1', '=COUNTIF(A1:A5,"apple")');    // apple, Apple -> 2 (case-insensitive)
  await setCell(page, 'C2', '=COUNTIF(A1:A5,"a*ple")');    // literal star -> only "a*ple" -> 1
  await setCell(page, 'C3', '=COUNTIF(A1:A5,"<>apple")');  // not equal apple -> {apples,app,a*ple} -> 3

  await expectCell(page, check, 'C1', '2');
  await expectCell(page, check, 'C2', '1');
  await expectCell(page, check, 'C3', '3');
});
