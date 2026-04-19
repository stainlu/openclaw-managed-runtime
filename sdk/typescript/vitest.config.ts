import { defineConfig } from "vitest/config";

// Self-contained so vitest doesn't walk up to the repo-root config, which
// imports vitest from the root's node_modules — absent in CI jobs that
// don't run `pnpm install` at the root (e.g. the networking-e2e job).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
