import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default worker_threads pool fails on Node 24 with
    // "Cannot read properties of undefined (reading 'config')" during suite
    // collection; vmThreads runs the same suites reliably.
    pool: "vmThreads",
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
