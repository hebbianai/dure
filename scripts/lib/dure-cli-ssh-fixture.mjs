import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Functional process fixtures keep product defaults covered by pure tests and
 * use an explicit deadline so unrelated full-suite children cannot consume it. */
export const FUNCTIONAL_DEADLINE_MS = 10_000;

/** Identity-file auth reference following the `credential-profile:` contract. */
export function identityFileAuth(id) {
  return { kind: "identity_file", reference: `credential-profile:${id}` };
}

/**
 * Canonical SSH backend profile entry for backend-profiles.json fixtures.
 * The trust reference derives from the profile id so every consumer keeps
 * the `known-hosts-profile:` naming contract.
 */
export function sshBackendProfile({
  id = "remote-build",
  defaultProfile = false,
  host = "remote.example.test",
  user = "dure",
  endpointPort = 6767,
  connectTimeoutMs = 1_000,
  auth = { kind: "ssh_agent" },
  backendId = "remote-backend",
  generation = "remote-generation-1",
  protocol = {
    minimum: { major: 1, minor: 0 },
    maximum: { major: 1, minor: 0 },
  },
  capabilities = [
    "sessions.list",
    "sessions.list.bounded_catalog_v1",
    "sessions.read",
    "sessions.show",
  ],
  deadlineMs = FUNCTIONAL_DEADLINE_MS,
} = {}) {
  return {
    id,
    ...(defaultProfile ? { default: true } : {}),
    transport: {
      kind: "ssh",
      host,
      port: 22,
      user,
      endpoint: { kind: "tcp", host: "127.0.0.1", port: endpointPort },
      batchMode: true,
      strictHostKeyChecking: "yes",
      connectTimeoutMs,
    },
    auth,
    trust: { kind: "known_hosts", reference: `known-hosts-profile:${id}` },
    expected: { backendId, generation, protocol, capabilities },
    deadlineMs,
  };
}

/**
 * Installs an `ssh` stub plus the matching default `remote-build` profile and
 * known-hosts file so a CLI run exercises the SSH backend transport end to end
 * without a network. `fail` swaps the stub for one that exits before
 * responding; `capabilities`/`deadlineMs` pin both the stub's advertised
 * backend descriptor and the profile expectation.
 */
export function installRemoteBackendFixture(
  root,
  payload,
  {
    fail = false,
    capabilities = [
      "sessions.list",
      "sessions.list.bounded_catalog_v1",
      "sessions.read",
      "sessions.show",
    ],
    deadlineMs = FUNCTIONAL_DEADLINE_MS,
    results = {},
  } = {},
) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const ssh = join(bin, "ssh");
  const requestLog = join(root, "backend-requests.jsonl");
  writeFileSync(
    ssh,
    fail
      ? "#!/bin/sh\nexit 41\n"
      : `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const request = JSON.parse(readFileSync(0, "utf8"));
if (process.env.DURE_SESSION_REQUEST_LOG) {
  appendFileSync(process.env.DURE_SESSION_REQUEST_LOG, JSON.stringify(request) + "\\n");
}
const results = ${JSON.stringify(results)};
const result = Object.hasOwn(results, request.operation) ? results[request.operation] : request.operation === "sessions.list"
  ? { schemaVersion: 1, complete: true, sessions: ${JSON.stringify(payload)} }
  : request.operation === "sessions.show"
    ? { schemaVersion: 1, session: ${JSON.stringify(payload?.[0])} }
    : {
        schemaVersion: 1,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        sequenceThrough: "12",
        lines: ["remote managed screen"]
      };
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  apiVersion: "dure.backend-transport/v1",
  kind: "dure.backend.response",
  requestId: request.requestId,
  backend: {
    id: "remote-backend",
    generation: "remote-generation-1",
    protocol: { major: 1, minor: 0 },
    capabilities: ${JSON.stringify(capabilities)},
    observedAtMs: Date.now(),
  },
  result,
}));
`,
  );
  chmodSync(ssh, 0o755);
  const knownHostsFile = join(root, "known-hosts");
  writeFileSync(knownHostsFile, "remote.example.test ssh-ed25519 fixture\n", {
    mode: 0o600,
  });
  writeFileSync(
    join(root, "backend-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "dure.backend_profiles",
      profiles: [
        sshBackendProfile({ defaultProfile: true, capabilities, deadlineMs }),
      ],
    }),
    { mode: 0o600 },
  );
  return { bin, knownHostsFile, requestLog };
}
