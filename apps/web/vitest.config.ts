import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig `@/* -> ./*` path alias.
      "@": resolve("."),
      // `server-only` / `client-only` throw when imported outside an RSC bundle;
      // stub them so server modules can be unit-tested under vitest's node env.
      "server-only": resolve("./test/empty-module.ts"),
      "client-only": resolve("./test/empty-module.ts"),
    },
  },
});
