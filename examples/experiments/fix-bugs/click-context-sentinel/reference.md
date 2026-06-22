# Reference: pallets/click#3137

## PR Details
- **URL:** https://github.com/pallets/click/pull/3137
- **Title:** Provide altered context to callbacks to hide UNSET values as None
- **Merged:** November 12, 2025
- **Base SHA (pre-PR):** `ea70da487b05d6bb758d472a3a9ffab4a5b7fcd5`
- **Related Issues:** #3136, Flask #5836

## Problem
A previous PR (#3079) introduced deferred `UNSET` normalization for default value handling. This caused a regression where callbacks received context objects with `UNSET` sentinel values exposed in `ctx.params`, instead of the expected `None`.

This broke downstream libraries:
- Flask (issue #5836)
- Black
- Click Extra

The external API contract was that unset parameters should appear as `None` to user code.

## The Real Fix
The developers acknowledged this as "a ridiculous fix" but implemented a pragmatic workaround:
1. Temporarily provide a modified context object to callbacks
2. The modified context masks `UNSET` sentinel values as `None`
3. Preserves the external API contract while maintaining internal changes

## Key Files Changed
- Core Click context/option handling code
- Test cases validating the fix

## Evaluation Notes
When comparing the agent's solution:
- Did it understand the sentinel value pattern?
- Did it find a way to mask UNSET without breaking internal code?
- Did it maintain backward compatibility?
- Did it add regression tests?

This is a moderate-to-high complexity fix requiring understanding of Click's internal architecture.
