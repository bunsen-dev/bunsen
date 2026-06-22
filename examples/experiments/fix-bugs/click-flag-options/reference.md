# Reference: pallets/click#3152

## PR Details
- **URL:** https://github.com/pallets/click/pull/3152
- **Title:** Fix handling of options which set both is_flag=False and flag_value=...
- **Merged:** November 20, 2025
- **Base SHA (pre-PR):** `7f7bbe4569ea68e8dabee232eade069ef3310aea`

## Problem
Click's option handling code doesn't correctly handle the edge case where a user explicitly sets `is_flag=False` but also provides a `flag_value`.

This should allow an option to work in two modes:
1. As a flag: `--verbose` gives the `flag_value` (e.g., 'debug')
2. With a value: `--verbose=warn` gives the explicit value
3. Without the flag: uses the `default` value

The implementation incorrectly handles this combination, breaking the expected behavior.

## The Real Fix
The fix involved:
1. Adjusting the logic in option parameter handling
2. Properly checking the `is_flag=False` condition before applying flag behavior
3. Ensuring `flag_value` is still used when the option is passed without a value

## Key Files Changed
- Click's core option handling code
- Test cases for the edge case

## Evaluation Notes
When comparing the agent's solution:
- Did it find the correct location in Click's option handling code?
- Did it understand the interaction between is_flag, flag_value, and default?
- Did it add test coverage for this specific edge case?
- Is the fix minimal and targeted?
