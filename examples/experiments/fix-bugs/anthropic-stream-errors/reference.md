# Reference: anthropics/anthropic-sdk-typescript#856

## PR Details
- **URL:** https://github.com/anthropics/anthropic-sdk-typescript/pull/856
- **Title:** fix(streams): ensure errors are catchable
- **Merged:** December 5, 2025
- **Base SHA (pre-PR):** `1999377c398f83bdd13d461c1f4b03f0c7756da2`

## Problem
When using `.withResponse()` with the streaming API, errors are both caught by try-catch blocks AND thrown as uncaught exceptions. The same error exhibits dual behavior - caught properly AND thrown as an uncaught exception that crashes the Node.js process.

This only happens when:
- Using `.stream()` with `.withResponse()`
- The response errors (e.g., invalid parameters)

It does NOT happen with `.create()` or streaming without `.withResponse()`.

## Deep Dive: Root Cause Analysis

### Reproduction

```typescript
try {
  const { data: stream } = await anthropic.messages
    .stream({
      max_tokens: 1,
      messages: [],  // Invalid - will cause an error
      model: 'claude-sonnet-4-5',
    })
    .withResponse();
} catch (e) {
  console.log('Caught:', e);  // This runs...
}
// But ALSO triggers: process.on('uncaughtException')!
```

### The Architecture

The `MessageStream` class in `src/lib/MessageStream.ts` manages two internal promises:

```typescript
// Lines 56-62
#connectedPromise: Promise<Response | null>;
#endPromise: Promise<void>;
```

And a critical tracking flag:
```typescript
// Line 69
#catchingPromiseCreated = false;
```

### The Error Handling Logic

When an error occurs, `_emit('error', ...)` is called (around line 398):

```typescript
if (event === 'error') {
  const error = args[0] as AnthropicError;
  if (!this.#catchingPromiseCreated && !listeners?.length) {
    // Trigger an unhandled rejection if no handlers registered
    Promise.reject(error);
  }
  this.#rejectConnectedPromise(error);
  this.#rejectEndPromise(error);
  this._emit('end');
}
```

The logic is:
- If `#catchingPromiseCreated` is `false` AND no listeners, create an unhandled rejection
- Always reject both `#connectedPromise` and `#endPromise`

### Why It Breaks

The `withResponse()` method awaits `#connectedPromise`:

```typescript
async withResponse(): Promise<{ data: MessageStream; response: Response; ... }> {
  const response = await this.#connectedPromise;  // Awaits the promise
  // ...
}
```

When you call `.withResponse()`, you're creating a `.then()` chain on `#connectedPromise`. If an error occurs:

1. The error rejects `#connectedPromise`
2. Your `try-catch` around `await .withResponse()` catches it ✓
3. **BUT** `#catchingPromiseCreated` is still `false`
4. So `_emit('error')` ALSO creates `Promise.reject(error)` ✗

The flag isn't set because `withResponse()` doesn't set it!

### The Pattern That Works

Other methods like `emitted()` and `done()` already set the flag correctly:

```typescript
emitted<Event extends keyof MessageStreamEvents>(...): Promise<...> {
  return new Promise((resolve, reject) => {
    this.#catchingPromiseCreated = true;  // Already here!
    // ...
  });
}

async done(): Promise<void> {
  this.#catchingPromiseCreated = true;  // Already here!
  await this.#endPromise;
}
```

The bug was that `withResponse()` was missing this line.

## The Real Fix
The actual PR made these changes to `src/lib/MessageStream.ts`:

1. Added a flag `this.#catchingPromiseCreated = true` to track when a promise with error handling is created
2. This flag is checked in `#handleError` to determine whether errors should propagate as unhandled rejections
3. When a catching promise exists, errors are routed to it instead of becoming unhandled

Key code change:
```typescript
// In the method that creates promises with .catch()
this.#catchingPromiseCreated = true;
```

## Key Files Changed
- `src/lib/MessageStream.ts` - Added catching promise tracking
- `tests/api-resources/MessageStream.test.ts` - Added test for withResponse() error handling

## Test Added
```typescript
it('does not throw unhandled rejection with withResponse()', async () => {
  // Test ensures errors are catchable when using .withResponse()
});
```

## Evaluation Notes
When comparing the agent's solution:
- Did it identify the root cause (promise error propagation without tracking)?
- Did it add similar tracking to prevent dual error throwing?
- Did it add a test specifically for `.withResponse()` error handling?
- Did it avoid modifying unrelated code?
