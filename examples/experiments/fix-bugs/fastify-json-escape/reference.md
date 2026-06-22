# Reference: fastify/fastify#6420

## PR Details
- **URL:** https://github.com/fastify/fastify/pull/6420
- **Title:** fix: use JSON.stringify in onBadUrl for proper escaping
- **Merged:** December 23, 2025
- **Base SHA (pre-PR):** `970c575832521fff01cc018d928d84454811173b`

## Problem
Template string interpolation in `onBadUrl` handler creates malformed JSON responses when URLs contain special characters (quotes, backslashes). This is a security/correctness bug that could cause:
- Invalid JSON responses to clients
- Potential injection issues

## The Real Fix
The actual PR made these changes:
1. Used `JSON.stringify()` to properly escape the URL path in the JSON message
2. Used `Buffer.byteLength()` instead of `.length` for accurate Content-Length calculation (handles multi-byte characters)
3. Added a test case to verify JSON escaping works with special characters

## Key Files Changed
- `lib/route.js` (or similar routing file) - the onBadUrl handler
- Test file for bad URL handling

## Evaluation Notes
When comparing the agent's solution:
- Did it identify the same root cause (template string escaping)?
- Did it use the same fix pattern (JSON.stringify)?
- Did it consider Content-Length calculation for multi-byte chars?
- Did it add test coverage?
