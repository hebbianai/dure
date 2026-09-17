import { join } from "node:path";
import { loadSessionClientProjection } from "./client-registry.mjs";
import { parseClientPresentation } from "./client-presentation-state.mjs";
import { publicAppControlIdentity, requestAppControl } from "./app-control-client.mjs";

/** The saved client projection discovers exact pane IDs across windows. Runtime
 * truth and mounted actions must still be read from the owning pane/session. */
export async function observeApp({ directory, descriptor, fetchImpl, now = Date.now }) {
  await requestAppControl({ descriptor, path: "/ping", method: "GET", fetchImpl });
  const registry = loadSessionClientProjection({ registryPath: join(directory, "agents.json") });
  const presentation = parseClientPresentation(registry.clientPresentation);
  return {
    schemaVersion: 1,
    kind: "dure.client_observation",
    client: publicAppControlIdentity(descriptor),
    presentation: {
      state: presentation ? registry.state : "unavailable",
      source: "saved_client_projection",
      observedAtMs: registry.updatedAtMs,
      ageMs: registry.updatedAtMs === null ? null : Math.max(0, now() - registry.updatedAtMs),
      ...(presentation ?? { spaces: [] }),
    },
    nextAction: "Use an exact pane ID with app_pane_state to discover current actions, parameters and availability.",
  };
}
