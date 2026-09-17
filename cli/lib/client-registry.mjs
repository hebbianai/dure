import { closeSync, fstatSync, openSync } from "node:fs";
import { readVerifiedDescriptorText } from "./fd-verified-read.mjs";
import { record } from "./session-runtime-projection.mjs";

const MAX_CLIENT_REGISTRY_BYTES = 512 * 1024;
const MAX_CLIENT_AGENTS = 512;

export function agentDisplayName(agent) {
  const displayName = typeof agent?.displayName === "string" ? agent.displayName.trim() : "";
  return displayName || agent.name;
}

/** Names select a presentation record, not runtime identity or liveness. */
export function matchingAgents(registry, query) {
  if (!query || !Array.isArray(registry?.agents)) return [];
  // A display name can contain a slash; exact full-name matches come first.
  let matches = registry.agents.filter(
    (agent) => agent.name === query || agentDisplayName(agent) === query,
  );
  if (matches.length === 0 && query.includes("/")) {
    const separator = query.indexOf("/");
    const project = query.slice(0, separator);
    const name = query.slice(separator + 1);
    matches = registry.agents.filter(
      (agent) => agent.project === project &&
        (agent.name === name || agentDisplayName(agent) === name),
    );
  }
  if (matches.length === 0) {
    matches = registry.agents.filter((agent) => agent.sessionId === query);
  }
  return matches;
}

export function loadSessionClientProjection({
  registryPath,
  clientId = null,
} = {}) {
  const unavailable = (state) => ({
    state,
    clientId,
    updatedAtMs: null,
    agents: [],
    clientPresentation: null,
  });
  let descriptor;
  try {
    descriptor = openSync(registryPath, "r");
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_CLIENT_REGISTRY_BYTES)
    ) {
      return unavailable("invalid");
    }
    const text = readVerifiedDescriptorText(descriptor, before);
    if (text === null) {
      return unavailable("invalid");
    }
    const value = JSON.parse(text);
    if (!record(value) || !Array.isArray(value.agents)) return unavailable("invalid");
    return {
      state: value.agents.length > MAX_CLIENT_AGENTS ? "truncated" : "available",
      clientId,
      updatedAtMs:
        Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0
          ? value.updatedAt
          : null,
      agents: value.agents.slice(0, MAX_CLIENT_AGENTS).filter(record),
      clientPresentation: value.clientPresentation ?? null,
    };
  } catch (error) {
    return unavailable(error?.code === "ENOENT" ? "absent" : "invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
