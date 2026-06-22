// Stub that `vitest.config.ts` aliases `server-only` / `client-only` to, so
// server modules guarded by `import "server-only"` can be unit-tested under
// vitest's node environment (where the real package throws on import).
export {};
