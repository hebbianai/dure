import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { AppControlClientError, requestAppControl } from "./app-control-client.mjs";
import { validPingResult } from "./backend-profile-preflight.mjs";
import {
  BACKEND_PROFILES_KIND,
  BACKEND_PROFILES_SCHEMA_VERSION,
  BackendProfileError,
  MAX_BACKEND_PROFILES_BYTES,
  backendProfilesErrorReport,
  parseBackendProfiles,
  parseProfileId,
  projectBackendProfile,
  resolveBackendProfilesPath,
} from "./backend-profiles.mjs";
import {
  pinBackendSshMaterial,
  selectBackendSshMaterial,
} from "./backend-ssh-material.mjs";
import {
  BACKEND_SSH_REFERENCES_FILE,
  BACKEND_SSH_REFERENCES_KIND,
  BACKEND_SSH_REFERENCES_SCHEMA_VERSION,
  MAX_BACKEND_SSH_REFERENCES_BYTES,
  parseBackendSshReferenceCatalog,
} from "./backend-ssh-references.mjs";
import {
  SSH_GATEWAY_CAPABILITY,
  buildSshStdinShellArgv,
  exchangeSshBackendRequest,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import {
  localBackendErrorReport,
  readOwnerFile,
  replaceOwnerStateFile,
} from "./local-backend.mjs";

const API_VERSION = "dure.backend-profiles/v1";
const HOST_LOOKUP_CAPABILITY = "ssh_hosts.get_v1";
const MAX_REMOTE_DESCRIPTOR_BYTES = 64 * 1024;
const PROBE_DEADLINE_MS = 15_000;
const PROFILE_DEADLINE_MS = 185_000;
const SSH_CONNECT_TIMEOUT_MS = 5_000;
const SSH_MATERIAL_DIRECTORY = "backend-ssh";
const SUPPORTED_PROTOCOL = Object.freeze({
  minimum: Object.freeze({ major: 1, minor: 0 }),
  maximum: Object.freeze({ major: 1, minor: 0 }),
});
const REMOTE_DESCRIPTOR_ABSENT = "absent";
const READ_REMOTE_DESCRIPTOR_SCRIPT = `descriptor="$HOME/.dure/backend/control-plane.json"
if [ -r "$descriptor" ]; then cat "$descriptor"; else printf '${REMOTE_DESCRIPTOR_ABSENT}\\n'; fi
`;

function fail(code, options) {
  throw new BackendProfileError(code, options);
}

/** `dure profiles add <id> --host <app host id>`, or null when malformed. */
export function parseBackendProfileAddArguments(args) {
  const flag = args.indexOf("--host");
  const hostId = args[flag + 1];
  const positional = args.filter((_, index) => index !== flag && index !== flag + 1);
  if (
    flag < 0 ||
    hostId === undefined ||
    hostId.startsWith("-") ||
    positional.length !== 1 ||
    positional[0].startsWith("-")
  ) {
    return null;
  }
  return { profileId: positional[0], hostId };
}

/** Read one registered host from the app that owns the SSH host registry. */
export async function lookupAppSshHost(hostId, { descriptor, fetchImpl } = {}) {
  if (descriptor && !descriptor.capabilities?.includes(HOST_LOOKUP_CAPABILITY)) {
    throw new AppControlClientError(
      "client_capability_missing",
      `Update the running Dure app; ${HOST_LOOKUP_CAPABILITY} is required.`,
    );
  }
  const payload = await requestAppControl({
    descriptor,
    path: "/ssh/hosts/get",
    body: { hostId },
    fetchImpl,
  });
  if (payload.host?.id !== hostId) {
    throw new AppControlClientError(
      "client_response_invalid",
      "The Dure app returned a different SSH host than the one requested.",
    );
  }
  return payload.host;
}

/** Only keys the user already trusts, found the way the app finds them. */
function readKnownHostKeysFromUserFile(host, port, homeDirectory) {
  const lookup = port === 22 ? host : `[${host}]:${port}`;
  let output;
  try {
    output = execFileSync(
      "ssh-keygen",
      ["-F", lookup, "-f", join(homeDirectory, ".ssh", "known_hosts")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }
  return output.split("\n").filter((line) => line && !line.startsWith("#"));
}

function profileAuth(profileId, host, homeDirectory) {
  if (host.auth === "password") fail("backend_profiles_add_password_auth");
  if (typeof host.keyPath !== "string" || !host.keyPath) {
    return { auth: { kind: "ssh_agent" } };
  }
  return {
    auth: { kind: "identity_file", reference: `credential-profile:${profileId}` },
    keyPath: host.keyPath.startsWith("~/")
      ? join(homeDirectory, host.keyPath.slice(2))
      : host.keyPath,
  };
}

function sshProfile(profileId, host, auth, endpoint, expected) {
  return {
    id: profileId,
    transport: {
      kind: "ssh",
      host: host.host,
      port: host.port,
      user: host.user,
      endpoint,
      batchMode: true,
      strictHostKeyChecking: "yes",
      connectTimeoutMs: SSH_CONNECT_TIMEOUT_MS,
    },
    auth,
    trust: { kind: "known_hosts", reference: `known-hosts-profile:${profileId}` },
    expected,
    deadlineMs: PROFILE_DEADLINE_MS,
  };
}

function catalogSource(profiles, base = {}) {
  return `${JSON.stringify(
    {
      ...base,
      schemaVersion: BACKEND_PROFILES_SCHEMA_VERSION,
      kind: BACKEND_PROFILES_KIND,
      profiles,
    },
    null,
    2,
  )}\n`;
}

function assertDestinationAvailable(catalog, profile) {
  const existing = catalog.profiles.find((candidate) => candidate.id === profile.id);
  if (
    existing &&
    (existing.transport.kind !== "ssh" ||
      existing.transport.host !== profile.transport.host ||
      existing.transport.port !== profile.transport.port ||
      existing.transport.user !== profile.transport.user)
  ) {
    fail("backend_profiles_add_profile_exists");
  }
  return existing;
}

function selectProbeMaterial(knownHostsFile, keyPath) {
  const selected = { knownHostsFile: selectBackendSshMaterial(knownHostsFile) };
  if (keyPath !== undefined) {
    try {
      if (!isAbsolute(keyPath)) throw new Error("relative key path");
      selected.identityFile = selectBackendSshMaterial(keyPath);
    } catch (error) {
      fail("backend_profiles_add_key_unavailable", { cause: error });
    }
  }
  return Object.freeze({ pin: () => pinBackendSshMaterial(selected) });
}

function parseRemoteDescriptor(stdout) {
  const text = stdout.toString("utf8").trim();
  if (text === REMOTE_DESCRIPTOR_ABSENT) {
    fail("backend_profiles_add_no_backend", {
      detail: "no backend descriptor on the host",
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (
    typeof value?.backendId !== "string" ||
    typeof value.generation !== "string" ||
    typeof value.socketPath !== "string" ||
    !value.socketPath.startsWith("/")
  ) {
    fail("backend_profiles_add_no_backend", {
      detail: "unreadable backend descriptor on the host",
    });
  }
  return value;
}

async function readRemoteDescriptor(profile, material, sshExchange) {
  const pinned = material.pin();
  let exchange;
  try {
    exchange = await sshExchange(
      buildSshStdinShellArgv(profile, pinned),
      Buffer.from(READ_REMOTE_DESCRIPTOR_SCRIPT, "utf8"),
      {
        deadlineMs: PROBE_DEADLINE_MS,
        maxResponseBytes: MAX_REMOTE_DESCRIPTOR_BYTES,
      },
    );
  } finally {
    pinned.dispose();
  }
  if (exchange?.kind !== "success") {
    fail("backend_profiles_add_ssh_failed", { detail: exchange?.kind ?? "unavailable" });
  }
  return parseRemoteDescriptor(exchange.stdout);
}

/** One pass over the host: read what backend it claims to run, then have that
 * exact backend answer. Nothing retries and nothing is installed. */
async function probeBackendIdentity(draft, material, sshExchange) {
  const descriptor = await readRemoteDescriptor(draft, material, sshExchange);
  const candidate = {
    ...draft,
    transport: {
      ...draft.transport,
      endpoint: { kind: "unix_socket", path: descriptor.socketPath },
    },
    expected: {
      backendId: descriptor.backendId,
      generation: descriptor.generation,
      protocol: SUPPORTED_PROTOCOL,
      capabilities: [SSH_GATEWAY_CAPABILITY],
    },
  };
  let response;
  try {
    response = await performBackendProfileRequest(
      candidate,
      { body: { schemaVersion: 1 }, operation: "backend.ping" },
      {
        deadlineMs: PROBE_DEADLINE_MS,
        resolveSshReferences: () => material,
        sshExchange,
      },
    );
  } catch (error) {
    fail("backend_profiles_add_no_backend", {
      cause: error,
      detail: typeof error?.code === "string" ? error.code : "request failed",
    });
  }
  if (!validPingResult(response.result)) {
    fail("backend_profiles_add_no_backend", { detail: "malformed backend reply" });
  }
  return {
    ...candidate,
    expected: {
      backendId: response.backend.id,
      generation: response.backend.generation,
      protocol: SUPPORTED_PROTOCOL,
      capabilities: response.backend.capabilities,
    },
  };
}

function writeSshReferences(root, profileId, knownHostsPath, keyPath) {
  const path = join(root, BACKEND_SSH_REFERENCES_FILE);
  const source = readOwnerFile(path, MAX_BACKEND_SSH_REFERENCES_BYTES);
  const references =
    source === null ? new Map() : parseBackendSshReferenceCatalog(source);
  references.set(`known-hosts-profile:${profileId}`, {
    kind: "known_hosts_file",
    path: knownHostsPath,
  });
  const credential = `credential-profile:${profileId}`;
  if (keyPath === undefined) references.delete(credential);
  else references.set(credential, { kind: "identity_file", path: keyPath });
  const next = `${JSON.stringify(
    {
      schemaVersion: BACKEND_SSH_REFERENCES_SCHEMA_VERSION,
      kind: BACKEND_SSH_REFERENCES_KIND,
      references: [...references].map(([reference, entry]) => ({
        reference,
        ...entry,
      })),
    },
    null,
    2,
  )}\n`;
  parseBackendSshReferenceCatalog(next);
  replaceOwnerStateFile(path, next, source);
}

function writeProfile(catalogPath, profile) {
  const source = readOwnerFile(catalogPath, MAX_BACKEND_PROFILES_BYTES);
  if (source === null) fail("backend_profiles_config_missing");
  const existing = assertDestinationAvailable(parseBackendProfiles(source), profile);
  const document = JSON.parse(source);
  const entry = existing?.default ? { ...profile, default: true } : profile;
  const profiles = existing
    ? document.profiles.map((candidate) => (candidate.id === profile.id ? entry : candidate))
    : [...document.profiles, entry];
  const next = catalogSource(profiles, document);
  if (Buffer.byteLength(next, "utf8") > MAX_BACKEND_PROFILES_BYTES) {
    fail("backend_profiles_config_too_large");
  }
  const written = parseBackendProfiles(next).profiles.find(
    (candidate) => candidate.id === profile.id,
  );
  replaceOwnerStateFile(catalogPath, next, source);
  return { profile: written, replaced: existing !== undefined };
}

/** Trust material lands before the profile, so a reader never finds a profile
 * whose references are missing. */
function persistProfile(root, catalogPath, profile, knownHosts, keyPath) {
  const directory = join(root, SSH_MATERIAL_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const knownHostsPath = join(directory, `${profile.id}.known_hosts`);
  replaceOwnerStateFile(
    knownHostsPath,
    knownHosts,
    readOwnerFile(knownHostsPath, MAX_BACKEND_PROFILES_BYTES),
  );
  writeSshReferences(root, profile.id, knownHostsPath, keyPath);
  return writeProfile(catalogPath, profile);
}

/** Build, verify and persist an SSH backend profile for one registered app
 * host. Every refusal happens before any Dure state changes. */
export async function addSshBackendProfile(
  { profileId, hostId },
  {
    environment = process.env,
    homeDirectory = homedir(),
    loadCatalog,
    lookupHost,
    readKnownHostKeys = (host, port) =>
      readKnownHostKeysFromUserFile(host, port, homeDirectory),
    sshExchange = exchangeSshBackendRequest,
  },
) {
  parseProfileId(profileId);
  const host = await lookupHost(hostId);
  const { auth, keyPath } = profileAuth(profileId, host, homeDirectory);
  const draft = sshProfile(
    profileId,
    host,
    auth,
    { kind: "tcp", host: "127.0.0.1", port: 1 },
    {
      backendId: "unprobed",
      generation: "unprobed",
      protocol: SUPPORTED_PROTOCOL,
      capabilities: [],
    },
  );
  parseBackendProfiles(catalogSource([draft]));
  assertDestinationAvailable(await loadCatalog(), draft);
  const keys = readKnownHostKeys(host.host, host.port);
  if (keys.length === 0) fail("backend_profiles_add_host_key_unknown");

  const catalogPath = resolveBackendProfilesPath({ environment });
  const root = dirname(catalogPath);
  const knownHosts = `${keys.join("\n")}\n`;
  const probeDirectory = mkdtempSync(join(root, ".backend-ssh-probe-"));
  try {
    const candidateKnownHosts = join(probeDirectory, "known_hosts");
    writeFileSync(candidateKnownHosts, knownHosts, { mode: 0o600, flag: "wx" });
    const material = selectProbeMaterial(candidateKnownHosts, keyPath);
    const verified = await probeBackendIdentity(draft, material, sshExchange);
    const { profile, replaced } = persistProfile(
      root,
      catalogPath,
      verified,
      knownHosts,
      keyPath,
    );
    return {
      schemaVersion: 1,
      apiVersion: API_VERSION,
      kind: "dure.backend_profiles.add",
      hostId,
      replaced,
      profile: projectBackendProfile(profile),
    };
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

export function backendProfileAddErrorReport(error) {
  if (error?.name === "LocalBackendError") return localBackendErrorReport(error);
  if (error instanceof AppControlClientError) {
    return {
      schemaVersion: 1,
      apiVersion: API_VERSION,
      kind: "dure.backend_profiles.error",
      error: { code: error.code, message: error.message },
    };
  }
  return backendProfilesErrorReport(error);
}

export function formatBackendProfileAddReport(report) {
  const { id, expected } = report.profile;
  return [
    `${report.replaced ? "Refreshed" : "Added"} backend profile ${id} for SSH host ${report.hostId}`,
    `  backend: ${expected.backendId}@${expected.generation}`,
    `  capabilities: ${expected.capabilities.length}`,
    `Use it with --backend ${id}, for example: dure runs list --backend ${id}`,
  ].join("\n");
}
