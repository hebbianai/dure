import { readFileSync } from "node:fs";

// Rust embeds the same JSON integer in dure-app-protocol. Keep identity,
// profile selection and transport negotiation within this common wire bound.
export const MAX_BACKEND_CAPABILITIES_V1 = JSON.parse(
  readFileSync(new URL("./backend-capability-limit.json", import.meta.url), "utf8"),
);
