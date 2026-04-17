import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest default scans the repo for *.test.ts and *.test.mjs. The
    // egress-proxy sidecar is a separate package: its tests use the
    // stdlib `node:test` runner (zero-dep + runs inside its own Docker
    // image build). Exclude that tree so vitest doesn't try (and fail)
    // to run node:test's describe/it shape through its own runner.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "docker/**",
      "sdk/**/dist/**",
    ],
  },
});
