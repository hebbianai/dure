import { dirname, isAbsolute, join } from "node:path";
import { resolveBackendProfilesPath } from "./backend-profiles.mjs";
import { BackendTransportError } from "./backend-transport.mjs";
import {
  pinBackendSshMaterial,
  readBackendSshCatalog,
  selectBackendSshMaterial,
} from "./backend-ssh-material.mjs";

export const BACKEND_SSH_REFERENCES_SCHEMA_VERSION = 1;
export const BACKEND_SSH_REFERENCES_KIND = "dure.backend_ssh_references";
export const BACKEND_SSH_REFERENCES_FILE = "backend-ssh-references.json";
export const MAX_BACKEND_SSH_REFERENCES_BYTES = 64 * 1024;
export const MAX_BACKEND_SSH_REFERENCES = 64;

const MAX_PATH_BYTES = 1024;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const KINDS = Object.freeze({
  "credential-profile:": "identity_file",
  "known-hosts-profile:": "known_hosts_file",
});

function unavailable() {
  throw new BackendTransportError("backend_transport_reference_unavailable");
}

function onlyKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.has(key))
  );
}

function parseReference(reference, kind) {
  if (typeof reference !== "string" || typeof kind !== "string") unavailable();
  const prefix = Object.keys(KINDS).find((candidate) =>
    reference.startsWith(candidate),
  );
  const profileId = prefix === undefined ? "" : reference.slice(prefix.length);
  if (
    prefix === undefined ||
    KINDS[prefix] !== kind ||
    !PROFILE_ID.test(profileId)
  ) {
    unavailable();
  }
  return reference;
}

export function parseBackendSshReferenceCatalog(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    unavailable();
  }
  if (
    !onlyKeys(value, new Set(["schemaVersion", "kind", "references"])) ||
    value.schemaVersion !== BACKEND_SSH_REFERENCES_SCHEMA_VERSION ||
    value.kind !== BACKEND_SSH_REFERENCES_KIND ||
    !Array.isArray(value.references) ||
    value.references.length > MAX_BACKEND_SSH_REFERENCES
  ) {
    unavailable();
  }
  const references = new Map();
  for (const entry of value.references) {
    if (!onlyKeys(entry, new Set(["reference", "kind", "path"]))) unavailable();
    const reference = parseReference(entry.reference, entry.kind);
    if (references.has(reference)) unavailable();
    if (
      typeof entry.path !== "string" ||
      !isAbsolute(entry.path) ||
      Buffer.byteLength(entry.path, "utf8") > MAX_PATH_BYTES ||
      /[\u0000-\u001f\u007f]/.test(entry.path)
    ) {
      unavailable();
    }
    references.set(reference, { kind: entry.kind, path: entry.path });
  }
  return references;
}

function catalogPath(environment) {
  return join(
    dirname(resolveBackendProfilesPath({ environment })),
    BACKEND_SSH_REFERENCES_FILE,
  );
}

function referenceEntry(references, reference, kind) {
  const parsedReference = parseReference(reference, kind);
  const entry = references.get(parsedReference);
  if (!entry || entry.kind !== kind) unavailable();
  return selectBackendSshMaterial(entry.path);
}

function resolveCatalogReferences({ auth, trust }, environment) {
  const source = readBackendSshCatalog(
    catalogPath(environment),
    MAX_BACKEND_SSH_REFERENCES_BYTES,
  );
  if (source === null) return null;
  const references = parseBackendSshReferenceCatalog(source);
  const resolved = {
    knownHostsFile: referenceEntry(
      references,
      trust.reference,
      "known_hosts_file",
    ),
  };
  if (auth.kind === "identity_file") {
    resolved.identityFile = referenceEntry(
      references,
      auth.reference,
      "identity_file",
    );
  }
  return resolved;
}

function resolveCompatibilityReferences({ auth, profileId }, environment) {
  if (
    !PROFILE_ID.test(profileId ?? "") ||
    environment.DURE_BACKEND_SSH_REFERENCE_PROFILE !== profileId
  ) {
    unavailable();
  }
  const resolved = {
    knownHostsFile: selectBackendSshMaterial(
      environment.DURE_BACKEND_KNOWN_HOSTS_FILE,
    ),
  };
  if (auth.kind === "identity_file") {
    resolved.identityFile = selectBackendSshMaterial(
      environment.DURE_BACKEND_IDENTITY_FILE,
    );
  }
  return resolved;
}

export function resolveBackendSshReferencesFromEnvironment(
  { auth, profileId, trust },
  environment = process.env,
) {
  if (
    !auth ||
    !trust ||
    !PROFILE_ID.test(profileId ?? "") ||
    trust.kind !== "known_hosts" ||
    (auth.kind !== "ssh_agent" && auth.kind !== "identity_file")
  ) {
    unavailable();
  }
  parseReference(trust.reference, "known_hosts_file");
  if (auth.kind === "identity_file") {
    parseReference(auth.reference, "identity_file");
  }
  const catalogResolved = resolveCatalogReferences(
    { auth, profileId, trust },
    environment,
  );
  const selected =
    catalogResolved ??
    resolveCompatibilityReferences({ auth, profileId, trust }, environment);
  return Object.freeze({ pin: () => pinBackendSshMaterial(selected) });
}
