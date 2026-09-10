import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20_000,
    // The fork pool intermittently hits "[vitest-worker]: Timeout calling
    // onTaskUpdate" on Windows when a worker is busy with long-running
    // synchronous git operations (the Run/Job stress tests); the threads
    // pool does not have this problem.
    pool: "threads",
  },
})
