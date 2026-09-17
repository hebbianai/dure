import { isBackendRuntimeFingerprint } from "../../../src/contracts/frontendRuntimeObservation.mjs";

const RUNTIME_FINGERPRINT_FEATURE = "app.runtime-fingerprint-v1";

export const MEDIA_BACKEND_FEATURES = Object.freeze([
  "hmux.terminal-state-binary-v1",
  "hmux.standalone-terminal-surface-v1",
  "hmux.managed-create-v1",
  "hmux.managed-create-advance-v1",
  "hmux.managed-shell-v1",
  "hmux.initial-agent-prompt-v1",
  "hmux.remote-catalog-v1",
  "hmux.remote-pane-departure-v1",
  "hmux.remote-structured-terminal-v1",
  "hmux.remote-initial-agent-prompt-v1",
  "hmux.remote-known-host-trust-v1",
  "hmux.remote-managed-create-v1",
  "ssh.connection-state-v1",
]);

export function mediaBackendCapabilities({
  buildId,
  name,
  runtimeFingerprint = null,
}) {
  const exactRuntimeFingerprint = isBackendRuntimeFingerprint(runtimeFingerprint)
    ? runtimeFingerprint
    : null;
  return {
    name,
    packageVersion: "1.0.0",
    protocolVersion: 1,
    buildId,
    runtimeFingerprint: exactRuntimeFingerprint,
    features: [
      ...(exactRuntimeFingerprint ? [RUNTIME_FINGERPRINT_FEATURE] : []),
      ...MEDIA_BACKEND_FEATURES,
    ],
  };
}
