import { readFileSync } from "node:fs";
import { createApnsSender } from "./apns.mjs";
import { openBindings } from "./bindings.mjs";
import { createPushServer } from "./service.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const list = (value) => (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

try {
  // The entrypoint hands the state directory and the key file to `node`
  // and drops root before this runs. Never run the service as root.
  if (process.getuid?.() === 0) throw new Error("The push service must not run as root");
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const audiences = list(required("DURE_PUSH_AUDIENCE"));
  const directory = required("DURE_PUSH_STATE_DIR");
  const sender = createApnsSender({
    key: readFileSync(required("DURE_APNS_KEY_FILE")),
    keyId: required("DURE_APNS_KEY_ID"),
    teamId: required("DURE_APNS_TEAM_ID"),
  });
  let bindings;
  try {
    bindings = await openBindings({ directory });
  } catch {
    throw new Error("DURE_PUSH_STATE_DIR is not writable");
  }
  const server = createPushServer({
    // Optional during the transition: while set, these computers keep /v1.
    allowedHubs: list(process.env.DURE_PUSH_HUB_FINGERPRINTS),
    audiences,
    sender,
    bindings,
    clientAddressHeader: process.env.DURE_PUSH_CLIENT_IP_HEADER?.trim() || undefined,
  });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`Dure push service listening on port ${port}\n`));
  const stop = () => server.close(() => {
    sender.close();
    bindings.close();
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch (error) {
  // Configuration errors contain field names, never key material or tokens.
  process.stderr.write(`Push service configuration failed: ${error instanceof Error ? error.message : "invalid configuration"}\n`);
  process.exitCode = 1;
}
