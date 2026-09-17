import crypto from "node:crypto";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hasPrivateField(value) {
  if (Array.isArray(value)) return value.some(hasPrivateField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /private|secret|seed|token/i.test(key) || hasPrivateField(child),
  );
}

function roleKeyIds(root, roleName) {
  const role = root?.signed?.roles?.[roleName];
  return Array.isArray(role?.keyids) ? role.keyids : [];
}

function validateBootstrapRoot(channel, policy, root, blockers) {
  const prefix = `${channel.name}:bootstrap_root`;
  if (!root) {
    blockers.push(`${prefix}_missing`);
    return new Set();
  }
  if (!SHA256_PATTERN.test(channel.bootstrapRootSha256 ?? "")) {
    blockers.push(`${prefix}_digest_unpinned`);
  } else if (sha256(root.bytes) !== channel.bootstrapRootSha256) {
    blockers.push(`${prefix}_digest_mismatch`);
  }

  const document = root.document;
  if (
    document?.signed?._type !== "root" ||
    document.signed.version !== 1 ||
    document.signed.consistent_snapshot !== true ||
    document.signed["x-hmux-channel"] !== channel.name ||
    hasPrivateField(document)
  ) {
    blockers.push(`${prefix}_identity_invalid`);
    return new Set();
  }

  const knownKeys = new Set(Object.keys(document.signed.keys ?? {}));
  const allRoleKeys = new Set();
  for (const roleName of ["root", "targets", "snapshot", "timestamp"]) {
    const declared = document.signed.roles?.[roleName];
    const expected = policy.roles?.[roleName];
    const keyIds = roleKeyIds(document, roleName);
    if (
      !declared ||
      !expected ||
      declared.threshold !== expected.threshold ||
      keyIds.length !== expected.keyCount ||
      new Set(keyIds).size !== keyIds.length ||
      keyIds.some((keyId) => !knownKeys.has(keyId))
    ) {
      blockers.push(`${prefix}_${roleName}_role_invalid`);
      continue;
    }
    for (const keyId of keyIds) allRoleKeys.add(keyId);
  }

  const rootKeys = new Set(roleKeyIds(document, "root"));
  if (roleKeyIds(document, "targets").some((keyId) => rootKeys.has(keyId))) {
    blockers.push(`${prefix}_root_targets_keys_overlap`);
  }
  return allRoleKeys;
}

export function evaluateHmuxReleaseActivationReadiness({
  policy,
  bootstrapRoots = {},
  bundleResources = [],
  applicationVerifierWired = false,
  runtimeSignedFetchEnabled = false,
  runtimeSignedInstallEnabled = false,
  releaseTrustRootChangesTriggerGate = false,
  originOwnershipEvidenceVerified = false,
  clientFixtureRefreshPassed = false,
  upstreamConformancePassed = false,
  renewalAlertingEnabled = false,
  tufPublisherReady = false,
}) {
  const blockers = [];
  const channels = Array.isArray(policy?.channels) ? policy.channels : [];
  const channelNames = channels.map(({ name }) => name).sort();
  if (
    channelNames.length !== 2 ||
    channelNames[0] !== "canary" ||
    channelNames[1] !== "stable"
  ) {
    blockers.push("channel_policy_invalid");
  }
  if (policy?.activation?.feedActivation !== "enabled") {
    blockers.push("feed_activation_disabled");
  }
  if (policy?.activation?.bootstrapState !== "staged_verified") {
    blockers.push("bootstrap_state_not_staged_verified");
  }
  for (const channel of channels) {
    if (channel.feedStatus !== "enabled") {
      blockers.push(`${channel.name}:feed_not_enabled`);
    }
  }
  if (!originOwnershipEvidenceVerified) {
    blockers.push("feed_origin_ownership_unverified");
  }
  if (!clientFixtureRefreshPassed) {
    blockers.push("chosen_client_fixture_refresh_unproven");
  }
  if (!upstreamConformancePassed) {
    blockers.push("upstream_conformance_unproven");
  }
  if (!applicationVerifierWired) {
    blockers.push("application_verifier_wiring_missing");
  }
  // These are authority boundaries, not caller assertions. Keep both blockers
  // unconditional until the Rust verifier exposes an offline bootstrap-root
  // validator and the application gate compares production key material with
  // every disposable fixture key domain.
  blockers.push("offline_bootstrap_root_validation_unavailable");
  blockers.push(
    "production_bootstrap_keys_not_proven_distinct_from_fixtures",
  );
  if (!runtimeSignedFetchEnabled) {
    blockers.push("runtime_signed_fetch_disabled");
  }
  if (!runtimeSignedInstallEnabled) {
    blockers.push("runtime_signed_install_disabled");
  }
  if (!releaseTrustRootChangesTriggerGate) {
    blockers.push("bootstrap_root_gate_trigger_missing");
  }
  if (!renewalAlertingEnabled) {
    blockers.push("metadata_renewal_alerting_missing");
  }
  if (!tufPublisherReady) {
    blockers.push("tuf_publisher_not_ready");
  }

  const bundledResourcePaths = Array.isArray(bundleResources)
    ? bundleResources
    : Object.values(bundleResources);
  const validatedRoots = [];
  for (const channel of channels) {
    const root = bootstrapRoots[channel.name];
    const allRoleKeys = validateBootstrapRoot(
      channel,
      policy,
      root,
      blockers,
    );
    if (root) validatedRoots.push({ ...root, allRoleKeys });
    const bundledPath = channel.bootstrapRoot?.replace(/^src-tauri\//, "");
    if (!bundledPath || !bundledResourcePaths.includes(bundledPath)) {
      blockers.push(`${channel.name}:bootstrap_root_not_bundled`);
    }
  }

  if (validatedRoots.length === 2) {
    if (sha256(validatedRoots[0].bytes) === sha256(validatedRoots[1].bytes)) {
      blockers.push("channel_bootstrap_roots_not_distinct");
    }
    const firstKeys = validatedRoots[0].allRoleKeys ?? new Set();
    const secondKeys = validatedRoots[1].allRoleKeys ?? new Set();
    if ([...firstKeys].some((keyId) => secondKeys.has(keyId))) {
      blockers.push("channel_signing_keys_not_isolated");
    }
  }

  return [...new Set(blockers)].sort();
}
