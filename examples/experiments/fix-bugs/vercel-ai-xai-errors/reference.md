# Reference: vercel/ai#11671

## PR Details
- **URL:** https://github.com/vercel/ai/pull/11671
- **Title:** fix(provider/xai): handle error responses returned with 200 status
- **Merged:** January 9, 2026
- **Base SHA (pre-PR):** `98d480e4b176e1d01cc8692d7fa5e35d3ab90ad0`

## Problem
The xAI API occasionally returns error responses with HTTP 200 status codes instead of proper error status codes. When the service is overloaded, it returns:
```json
{"code":"The service is currently unavailable","error":"Timed out waiting for first token"}
```

This caused confusing downstream errors like "Type validation failed" or "Invalid input: expected array, received undefined" instead of surfacing the actual error message from xAI.

## Deep Dive: Root Cause Analysis

### What the User Sees

```
Type validation failed: Value: {"code":"The service is currently unavailable"...}
Error message: [{"expected":"array","code":"invalid_type","path":["choices"],
"message":"Invalid input: expected array, received undefined"}]
```

This is confusing because the real error ("service unavailable") is buried in a Zod validation error.

### The Architecture

In `packages/xai/src/xai-chat-language-model.ts`, the `doGenerate()` method makes an API call:

```typescript
async doGenerate(options: LanguageModelV3CallOptions): Promise<...> {
  const { args: body, warnings } = await this.getArgs(options);

  const { responseHeaders, value: response, rawValue: rawResponse } =
    await postJsonToApi({
      url: `${this.config.baseURL}/chat/completions`,
      // ...
      failedResponseHandler: xaiFailedResponseHandler,  // Only for non-200
      successfulResponseHandler: createJsonResponseHandler(
        xaiChatResponseSchema,  // Validates against this schema
      ),
      // ...
    });

  const choice = response.choices[0];  // BOOM! No 'choices' in error response
  // ...
}
```

### Why It Breaks

1. xAI returns `{"code": "...", "error": "..."}` with **HTTP 200**
2. `postJsonToApi` sees 200 status, uses `successfulResponseHandler`
3. `createJsonResponseHandler` tries to validate against `xaiChatResponseSchema`
4. The schema expects a `choices` array (defined around line 523):
   ```typescript
   const xaiChatResponseSchema = z.object({
     // ...
     choices: z.array(
       z.object({
         message: z.object({...}),
         index: z.number(),
         finish_reason: z.string().nullish(),
       }),
     ),
     // ...
   });
   ```
5. Validation fails because error response has no `choices`
6. User gets cryptic "Type validation failed" error

### The Same Problem in Streaming

The `doStream()` method (around line 284) has the same issue - it doesn't check for error responses before processing the stream:

```typescript
async doStream(options: LanguageModelV3CallOptions): Promise<...> {
  // ...
  const { responseHeaders, value: response } = await postJsonToApi({
    // ...
    successfulResponseHandler:
      createEventSourceResponseHandler(xaiChatChunkSchema),  // Assumes valid stream
    // ...
  });

  // Processes stream without checking for error response first
}
```

### The Fix Pattern

Add error detection **before** schema validation:

```typescript
async doGenerate(options: LanguageModelV3CallOptions): Promise<...> {
  // ... existing code to make API call ...

  // ADD: Check for error response with 200 status
  if ('code' in response && 'error' in response) {
    throw new APICallError({
      message: response.error,
      url: `${this.config.baseURL}/chat/completions`,
      isRetryable: response.code === 'The service is currently unavailable',
      requestBodyValues: body,
      responseBody: rawResponse,
      statusCode: 200,
    });
  }

  const choice = response.choices[0];
  // ... rest of method ...
}
```

Key aspects:
1. **Detect error pattern**: Check for `code` and `error` fields in response
2. **Throw proper error**: Use `APICallError` with the actual message from xAI
3. **Mark as retryable**: "Service unavailable" should trigger automatic retries
4. **Apply to both methods**: Fix both `doGenerate()` and `doStream()`

## The Real Fix
The actual PR made these changes to `packages/xai/src/xai-chat-language-model.ts`:

1. Added error detection in `doGenerate`:
```typescript
// Check for error response with 200 status
if ('code' in responseBody && 'error' in responseBody) {
  throw new APICallError({
    message: responseBody.error,
    url: /* ... */,
    isRetryable: responseBody.code === 'The service is currently unavailable',
    // ...
  });
}
```

2. Added similar error detection in `doStream` before attempting to parse the stream

3. Marked "service unavailable" errors as retryable so the SDK can auto-retry

## Key Files Changed
- `packages/xai/src/xai-chat-language-model.ts` - Added error detection in both methods
- `packages/xai/src/xai-chat-language-model.test.ts` - Added tests for both scenarios

## Tests Added
```typescript
it('should handle error response in generate', async () => {
  // Mock xAI returning error with 200 status
  // Verify APICallError is thrown with correct message
});

it('should handle error response in stream', async () => {
  // Same for streaming scenario
});
```

## Evaluation Notes
When comparing the agent's solution:
- Did it detect the error response pattern (checking for `code` and `error` fields)?
- Did it handle both `doGenerate` and `doStream` methods?
- Did it throw `APICallError` with the actual error message?
- Did it mark service unavailable as retryable?
- Did it add tests for both scenarios?
