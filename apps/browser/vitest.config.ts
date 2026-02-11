import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";

const projectRoot = fileURLToPath(new URL("./", import.meta.url));
const pool =
  (process.env.VITEST_POOL as "threads" | "vmThreads" | "process" | undefined) ?? "threads";

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: {
      $lib: resolve(projectRoot, "src/lib"),
    },
  },
  test: {
    environment: "node",
    environmentMatchGlobs: [
      ["tests/components/**/*.test.ts", "jsdom"],
      ["tests/e2e/**/*.test.ts", "jsdom"],
      ["src/lib/**/*.component.test.ts", "jsdom"],
    ],
    include: [
      "src/lib/server/**/*.{test,spec}.{js,ts}",
      "src/routes/**/*.{test,spec}.{js,ts}",
      "tests/**/*.{test,spec}.{js,ts}",
    ],
    setupFiles: ["tests/setup-vitest.ts"],
    pool,
    coverage: {
      reporter: ["text", "lcov"],
      enabled: false,
    },
  },
});
