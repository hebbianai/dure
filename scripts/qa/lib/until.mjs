import { setTimeout as delay } from "node:timers/promises";

// Reads until `read` returns something truthy and returns it. A fixture uses
// this for state another process applies after it has already answered, such
// as a hook report the app queued for its Host.
export async function until(read, message, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(message);
}
