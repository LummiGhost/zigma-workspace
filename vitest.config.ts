import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Native SQLite must not share Windows worker-thread teardown. One fork per
    // test file also bounds simultaneous Git/CLI processes on this platform.
    pool: process.platform === "win32" ? "forks" : "threads",
    ...(process.platform === "win32" ? { maxWorkers: 1, setupFiles: ["./tests/windows-worker-io.ts"] } : {}),
  },
})
