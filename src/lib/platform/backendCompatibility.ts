import {
  type FrontendRuntimeObservation,
  isBackendRuntimeFingerprint,
} from "@/contracts/frontendRuntimeObservation.mjs";

// The `terminal.*` legacy-daemon transport features retired with the PTY/SSH
// runtime (2026-08-16); only hmux/ssh-utility features remain gated here.
export const BACKEND_FEATURES = {
  appRuntimeFingerprint: "app.runtime-fingerprint-v1",
  hmuxStandaloneTerminalSurface: "hmux.standalone-terminal-surface-v1",
  hmuxStandaloneCommand: "hmux.standalone-command-v1",
  hmuxManagedCreate: "hmux.managed-create-v1",
  hmuxManagedCreateAdvanceV1: "hmux.managed-create-advance-v1",
  hmuxManagedLaunchPromptV1: "hmux.managed-launch-prompt-v1",
  hmuxManagedCreateChainStopV1: "hmux.managed-create-chain-stop-v1",
  hmuxManagedCreateChainStopV2: "hmux.managed-create-chain-stop-v2",
  hmuxManagedShell: "hmux.managed-shell-v1",
  hmuxManagedStop: "hmux.managed-stop-v1",
  hmuxInitialAgentPrompt: "hmux.initial-agent-prompt-v1",
  hmuxUpdateControlPlane: "hmux.update-control-plane-v1",
  hmuxStandaloneUpgrade: "hmux.standalone-upgrade-v1",
  hmuxRemoteCatalog: "hmux.remote-catalog-v1",
  hmuxRemoteAdoptionPreflight: "hmux.remote-adoption-preflight-v1",
  hmuxRemotePaneDeparture: "hmux.remote-pane-departure-v1",
  hmuxRemoteStructuredTerminal: "hmux.remote-structured-terminal-v1",
  hmuxRemoteExactInput: "hmux.remote-exact-input-v1",
  hmuxRemoteInitialAgentPrompt: "hmux.remote-initial-agent-prompt-v1",
  hmuxRemoteKnownHostTrust: "hmux.remote-known-host-trust-v1",
  hmuxRemoteProvision: "hmux.remote-provision-v1",
  hmuxRemoteCreate: "hmux.remote-create-v1",
  hmuxRemoteManagedCreate: "hmux.remote-managed-create-v1",
  hmuxRemoteManagedCreateAdvanceV1: "hmux.remote-managed-create-advance-v1",
  hmuxRemoteManagedCreateChainStopV1: "hmux.remote-managed-create-chain-stop-v1",
  hmuxRemoteManagedCreateChainStopV2: "hmux.remote-managed-create-chain-stop-v2",
  hmuxRemoteManagedRehost: "hmux.remote-managed-rehost-v1",
  hmuxRemoteManagedStop: "hmux.remote-managed-stop-v1",
  sshCredentialOverlay: "ssh.credential-overlay-v1",
  remoteGitCheckoutHelper: "git.remote-checkout-helper-v1",
} as const;

const REQUIRED_BACKEND_PROTOCOL_VERSION = 1;
const REQUIRED_BACKEND_FEATURES = [
  BACKEND_FEATURES.hmuxManagedCreateAdvanceV1,
] as const;

export type FrontendBuildInfo = FrontendRuntimeObservation;

export interface BackendCapabilities {
  name: string;
  packageVersion: string;
  protocolVersion: number;
  buildId: string;
  runtimeFingerprint?: string | null;
  features: string[];
}

type BackendCompatibilityBasis =
  | "none"
  | "runtime-fingerprint"
  | "build-id-fallback"
  | "fingerprint-unavailable";

export interface AppCompatibility {
  mode: "current" | "version-skew" | "degraded" | "legacy";
  comparisonBasis: BackendCompatibilityBasis;
  frontendBuildId: string;
  frontendSourceRevision: string | null;
  frontendWorktreeOverlay: FrontendRuntimeObservation["worktreeOverlay"];
  frontendRuntimeFingerprint: string | null;
  backend: BackendCapabilities | null;
  missingFeatures: string[];
}

function frontendCompatibilityIdentity(frontend: FrontendBuildInfo) {
  return {
    frontendBuildId: frontend.buildId,
    frontendSourceRevision: frontend.sourceRevision,
    frontendWorktreeOverlay: frontend.worktreeOverlay,
    frontendRuntimeFingerprint: frontend.backendRuntimeFingerprint,
  };
}

export function classifyAppCompatibility(
  frontend: FrontendBuildInfo,
  backend: BackendCapabilities | null,
): AppCompatibility {
  const frontendIdentity = frontendCompatibilityIdentity(frontend);
  if (!backend) {
    return {
      mode: "legacy",
      comparisonBasis: "none",
      ...frontendIdentity,
      backend: null,
      missingFeatures: [...REQUIRED_BACKEND_FEATURES],
    };
  }

  const missingFeatures = REQUIRED_BACKEND_FEATURES.filter(
    (feature) => !backend.features.includes(feature),
  );
  const compatible =
    backend.protocolVersion >= REQUIRED_BACKEND_PROTOCOL_VERSION &&
    missingFeatures.length === 0;
  if (!compatible) {
    return {
      mode: "degraded",
      comparisonBasis: "none",
      ...frontendIdentity,
      backend,
      missingFeatures,
    };
  }

  if (!backend.features.includes(BACKEND_FEATURES.appRuntimeFingerprint)) {
    return {
      mode: backend.buildId === frontend.buildId ? "current" : "version-skew",
      comparisonBasis: "build-id-fallback",
      ...frontendIdentity,
      backend,
      missingFeatures,
    };
  }

  if (
    !isBackendRuntimeFingerprint(frontend.backendRuntimeFingerprint) ||
    !isBackendRuntimeFingerprint(backend.runtimeFingerprint)
  ) {
    return {
      mode: "version-skew",
      comparisonBasis: "fingerprint-unavailable",
      ...frontendIdentity,
      backend,
      missingFeatures,
    };
  }

  return {
    mode:
      backend.runtimeFingerprint === frontend.backendRuntimeFingerprint
        ? "current"
        : "version-skew",
    comparisonBasis: "runtime-fingerprint",
    ...frontendIdentity,
    backend,
    missingFeatures,
  };
}

export function backendCapabilitiesSupport(
  capabilities: BackendCapabilities | null,
  feature: string,
): boolean {
  return Boolean(
    capabilities &&
      capabilities.protocolVersion >= REQUIRED_BACKEND_PROTOCOL_VERSION &&
      capabilities.features.includes(feature),
  );
}
