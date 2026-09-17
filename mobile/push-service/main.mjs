import { readFileSync } from "node:fs";
import { createApnsSender } from "./apns.mjs";
import { createPushServer } from "./service.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

try {
  const sender = createApnsSender({
    key: readFileSync(required("DURE_APNS_KEY_FILE")),
    keyId: required("DURE_APNS_KEY_ID"),
    teamId: required("DURE_APNS_TEAM_ID"),
  });
  const allowedHubs = new Set(required("DURE_PUSH_HUB_FINGERPRINTS").split(",").map((value) => value.trim()));
  if ([...allowedHubs].some((value) => !/^SHA256:[A-Za-z0-9+/]{43}=$/.test(value))) throw new Error("Invalid authorized Hub fingerprint");
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const server = createPushServer({ allowedHubs, sender });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Dure push service listening on port ${port}\n`));
  const stop = () => server.close(() => { sender.close(); });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  // Configuration errors contain field names, never key material or tokens.
  process.stderr.write(`Push service configuration failed: ${error instanceof Error ? error.message : "invalid configuration"}\n`);
  process.exitCode = 1;
}
