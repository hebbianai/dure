const CAPTURE_PROOF_SCHEMA_VERSION = 1;
const BROWSER_CLIENT = "browser-client";
const NATIVE_TAURI = "native-tauri";

const PROFILES = Object.freeze({
  "hmux-source-pane-move-v1": Object.freeze({
    boundary: "browser-pane-move",
    exactEvidence: Object.freeze([
      "hmux-session-fence",
      "host-process-generation",
      "provider-process-generation",
      "terminal-epoch",
      "canonical-screen-sequence",
      "browser-pane-and-session-binding",
    ]),
    limitations: Object.freeze([
      "browser-terminal-replays-isolated-source-frames",
      "ssh-inventory-is-a-sanitized-fixture",
      "does-not-prove-ssh-transport-continuity",
      "does-not-observe-native-webview-or-focus",
    ]),
    profile: "hmux-source-pane-move-v1",
    requiredActions: Object.freeze(["moveSpacesPane"]),
    requiredProviderSource: "live",
    requiredSurface: BROWSER_CLIENT,
    requiresTerminalSurfaceProof: false,
    requiresLiveContinuity: true,
    status: "preserved",
  }),
  "hmux-client-reconnect-v1": Object.freeze({
    boundary: "client-reconnect",
    exactEvidence: Object.freeze([
      "hmux-session-fence",
      "host-process-generation",
      "provider-process-generation",
      "terminal-epoch",
      "canonical-screen-sequence",
    ]),
    limitations: Object.freeze([
      "does-not-observe-native-app-process-exit",
      "does-not-prove-native-app-restart",
    ]),
    profile: "hmux-client-reconnect-v1",
    requiredActions: Object.freeze(["reloadAppClient"]),
    requiredProviderSource: "live",
    requiredSurface: BROWSER_CLIENT,
    requiresTerminalSurfaceProof: false,
    requiresLiveContinuity: true,
    status: "reattached",
  }),
  "hmux-native-view-handoff-v1": Object.freeze({
    boundary: "view-handoff",
    exactEvidence: Object.freeze([
      "hmux-session-fence",
      "host-process-generation",
      "provider-process-generation",
      "terminal-epoch",
      "canonical-screen-sequence",
      "terminal-surface-view-handoff",
      "owned-real-tauri-window-ids",
    ]),
    limitations: Object.freeze([
      "does-not-observe-native-app-restart",
      "does-not-prove-machine-reboot-survival",
    ]),
    profile: "hmux-native-view-handoff-v1",
    requiredActions: Object.freeze([]),
    requiredProviderSource: "live",
    requiredSurface: NATIVE_TAURI,
    requiresTerminalSurfaceProof: true,
    requiresLiveContinuity: true,
    status: "survived",
  }),
  "hmux-reboot-stale-recovery-v1": Object.freeze({
    boundary: "reboot-stale-session",
    exactEvidence: Object.freeze([
      "reboot-stale-census-fixture",
      "confirmation-gated-recovery-plan",
      "presentation-checkpoint-replay",
      "pane-binding-retarget",
      "fresh-terminal-epoch",
    ]),
    limitations: Object.freeze([
      "uses-deterministic-backend-fixture",
      "does-not-observe-machine-reboot",
      "does-not-observe-native-app-process-exit",
      "does-not-prove-network-disconnect-recovery",
      "does-not-prove-host-crash-recovery",
    ]),
    profile: "hmux-reboot-stale-recovery-v1",
    requiredActions: Object.freeze([
      "reloadForSessionRecovery",
      "confirmSessionRecovery",
    ]),
    requiredProviderSource: "fixture",
    requiredSurface: BROWSER_CLIENT,
    requiresTerminalSurfaceProof: false,
    requiresLiveContinuity: false,
    status: "recovered",
  }),
});

const VISUAL_ONLY = Object.freeze({
  boundary: null,
  exactEvidence: Object.freeze([]),
  limitations: Object.freeze(["no-lifecycle-claim"]),
  profile: "visual-only-v1",
  requiredActions: Object.freeze([]),
  requiredProviderSource: null,
  requiredSurface: null,
  requiresTerminalSurfaceProof: false,
  requiresLiveContinuity: false,
  status: null,
});

const LEGACY_FLAGS = Object.freeze([
  "requiresLiveClientContinuity",
  "requiresNativeWindows",
  "requiresControllerLeaseProof",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function captureProofRequirements(scenario) {
  const captureProof = scenario?.captureProof;
  if (captureProof === undefined) return VISUAL_ONLY;
  if (
    !isRecord(captureProof) ||
    captureProof.schemaVersion !== CAPTURE_PROOF_SCHEMA_VERSION ||
    Object.keys(captureProof).some(
      (key) => key !== "schemaVersion" && key !== "profile",
    )
  ) {
    throw new Error("captureProof must be a version 1 profile reference");
  }
  const profile = PROFILES[captureProof.profile] ?? null;
  if (!profile) {
    throw new Error(`captureProof.profile ${String(captureProof.profile)} is unsupported`);
  }
  return profile;
}

export function captureProofValidationErrors(scenario) {
  const errors = [];
  if (LEGACY_FLAGS.some((key) => Object.hasOwn(scenario ?? {}, key))) {
    errors.push("legacy capture proof flags are unsupported; use captureProof");
  }

  let requirements;
  try {
    requirements = captureProofRequirements(scenario);
  } catch (error) {
    errors.push(error.message);
    return errors;
  }

  for (const requiredAction of requirements.requiredActions) {
    const actionCount = (scenario?.timeline ?? []).filter(
      ({ action }) => action === requiredAction,
    ).length;
    if (actionCount !== 1) {
      errors.push(
        `captureProof.profile ${requirements.profile} requires exactly one ${requiredAction} action`,
      );
    }
  }
  if (
    requirements.requiredSurface === BROWSER_CLIENT &&
    scenario?.captureStage?.mode !== "desktop-window"
  ) {
    errors.push(`${requirements.profile} requires the browser desktop capture stage`);
  }
  if (
    requirements.requiredSurface === NATIVE_TAURI &&
    scenario?.captureStage?.mode !== "full-frame"
  ) {
    errors.push(`${requirements.profile} requires the owned real-Tauri capture stage`);
  }
  if (
    requirements.requiredSurface !== NATIVE_TAURI &&
    scenario?.nativeSessionWindowAgentId !== undefined
  ) {
    errors.push("nativeSessionWindowAgentId requires a native captureProof profile");
  }
  return errors;
}

export function captureProofNeedsNativeTauri(scenario) {
  return captureProofRequirements(scenario).requiredSurface === NATIVE_TAURI;
}

export function captureProofNeedsLiveContinuity(scenario) {
  return captureProofRequirements(scenario).requiresLiveContinuity;
}

export function captureProofManifest({
  captureSurface,
  continuityEvidence = [],
  terminalSurfaceProof = null,
  providerSource,
  scenario,
}) {
  const requirements = captureProofRequirements(scenario);
  if (![BROWSER_CLIENT, NATIVE_TAURI].includes(captureSurface)) {
    throw new Error("capture proof surface is unsupported");
  }
  if (
    requirements.requiredSurface !== null &&
    requirements.requiredSurface !== captureSurface
  ) {
    throw new Error(
      `${requirements.profile} requires ${requirements.requiredSurface} evidence`,
    );
  }
  if (
    requirements.requiredProviderSource !== null &&
    providerSource !== requirements.requiredProviderSource
  ) {
    throw new Error(
      `${requirements.profile} requires ${requirements.requiredProviderSource} provider evidence`,
    );
  }
  if (requirements.requiresLiveContinuity) {
    if (!Array.isArray(continuityEvidence) || continuityEvidence.length === 0) {
      throw new Error(`${requirements.profile} is missing continuity observations`);
    }
  }
  if (requirements.requiresTerminalSurfaceProof && !terminalSurfaceProof) {
    throw new Error(`${requirements.profile} is missing terminal surface evidence`);
  }
  if (!requirements.requiresTerminalSurfaceProof && terminalSurfaceProof !== null) {
    throw new Error(`${requirements.profile} does not accept terminal surface evidence`);
  }

  return {
    schemaVersion: CAPTURE_PROOF_SCHEMA_VERSION,
    profile: requirements.profile,
    captureSurface,
    claim:
      requirements.boundary === null
        ? null
        : {
            boundary: requirements.boundary,
            status: requirements.status,
          },
    exactEvidence: [...requirements.exactEvidence],
    limitations: [...requirements.limitations],
    liveContinuity: {
      required: requirements.requiresLiveContinuity,
      enforced: requirements.requiresLiveContinuity,
      probes: continuityEvidence,
    },
    terminalSurface: {
      required: requirements.requiresTerminalSurfaceProof,
      proof: terminalSurfaceProof,
    },
  };
}
