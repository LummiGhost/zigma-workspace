import { afterEach } from "vitest";
import { setTimeout } from "node:timers/promises";

// Synchronous Git-heavy tests can starve fork IPC acknowledgement callbacks
// across consecutive tests. Yield an event-loop turn without suppressing RPC
// errors or changing any test/assertion timeout.
afterEach(async () => {
  if (process.platform === "win32") await setTimeout(0);
});
