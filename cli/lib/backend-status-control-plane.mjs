import {
  BackendProfileError,
  loadBackendProfiles,
  projectBackendProfile,
  selectBackendProfile,
} from "./backend-profiles.mjs";
import { testBackendProfile } from "./backend-profile-preflight.mjs";
import { BackendTransportError } from "./backend-transport.mjs";

export const CONTROL_PLANE_NOT_DEPLOYED_REASON =
  "control_plane_not_deployed";

const OUTDATED_TRANSPORT_ERRORS = new Set([
  "backend_transport_backend_mismatch",
  "backend_transport_capability_missing",
  "backend_transport_generation_mismatch",
  "backend_transport_profile_capability_missing",
  "backend_transport_protocol_incompatible",
]);

function elapsedMs(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
}

function typedError(code, message, source) {
  return { code, message, source };
}

function safeEndpoint(profile) {
  if (!profile) return null;
  const projected = projectBackendProfile(profile);
  return {
    transport: projected.transport.kind,
    kind: projected.transport.endpoint.kind,
    id: projected.transport.endpoint.id,
  };
}

function targetFor(profile) {
  if (!profile) {
    return { kind: "local", id: "local", transport: "local_process" };
  }
  return {
    kind: profile.transport.kind === "local" ? "local" : "remote",
    id: profile.id,
    transport:
      profile.transport.kind === "local" ? "local_process" : "ssh",
  };
}

function unavailableControlPlane({
  durationMs,
  error,
  observedAtMs,
  profile,
  reasonCode,
  state,
}) {
  return {
    state,
    reasonCode,
    identity: null,
    build: null,
    protocol: {
      negotiation: state === "outdated" ? "incompatible" : "unavailable",
      capabilities: [],
    },
    host: null,
    process: null,
    endpoint: safeEndpoint(profile),
    heartbeat: {
      state: "unknown",
      observedAtMs: null,
      ageMs: null,
    },
    lastTypedError: error,
    observedAtMs,
    sourceAgeMs: 0,
    durationMs,
    target: targetFor(profile),
  };
}

function failureObservation(error, profile, observedAtMs, durationMs) {
  if (error instanceof BackendProfileError) {
    const noDeployableProfile = new Set([
      "backend_profiles_config_missing",
      "backend_profiles_selection_missing",
      "backend_profiles_selection_not_found",
    ]).has(error.code);
    const reasonCode = noDeployableProfile
      ? CONTROL_PLANE_NOT_DEPLOYED_REASON
      : error.code;
    return unavailableControlPlane({
      durationMs,
      error: noDeployableProfile
        ? null
        : typedError(error.code, error.message, "backend_profile"),
      observedAtMs,
      profile,
      reasonCode,
      state: noDeployableProfile ? "absent" : "unreachable",
    });
  }
  if (error instanceof BackendTransportError) {
    const state = OUTDATED_TRANSPORT_ERRORS.has(error.code)
      ? "outdated"
      : error.code === "backend_transport_remote_error"
        ? "degraded"
        : "unreachable";
    return unavailableControlPlane({
      durationMs,
      error: typedError(error.code, error.message, "control_plane_transport"),
      observedAtMs,
      profile,
      reasonCode: error.code,
      state,
    });
  }
  return unavailableControlPlane({
    durationMs,
    error: typedError(
      "control_plane_observation_failed",
      "the selected control plane could not be observed",
      "control_plane_status",
    ),
    observedAtMs,
    profile,
    reasonCode: "control_plane_observation_failed",
    state: "unreachable",
  });
}

export async function inspectSelectedControlPlane({
  deadlineMs,
  environment = process.env,
  loadProfiles = loadBackendProfiles,
  now = Date.now,
  selectProfile = selectBackendProfile,
  testProfile = testBackendProfile,
} = {}) {
  const started = process.hrtime.bigint();
  let profile;
  try {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new BackendTransportError("backend_transport_timeout");
    }
    const catalog = loadProfiles({ environment });
    const selection = selectProfile(catalog, { environment });
    profile = selection.profile;
    const report = await testProfile(selection, { deadlineMs, environment });
    const observedAtMs = now();
    const endpoint = safeEndpoint(profile);
    return {
      state: "ready",
      reasonCode: null,
      identity: {
        backendId: report.backend.id,
        generation: report.backend.generation,
      },
      build: null,
      protocol: {
        negotiation: "accepted",
        version: { ...report.backend.protocol },
        capabilities: [...report.backend.capabilities],
      },
      host: null,
      process: null,
      endpoint,
      heartbeat: {
        state: "fresh",
        observedAtMs: report.backend.observedAtMs,
        ageMs: report.backend.sourceAgeMs,
      },
      lastTypedError: null,
      observedAtMs,
      sourceAgeMs: Math.max(0, observedAtMs - report.backend.observedAtMs),
      durationMs: elapsedMs(started),
      target: targetFor(profile),
    };
  } catch (error) {
    const observedAtMs = now();
    return failureObservation(
      error,
      profile,
      observedAtMs,
      elapsedMs(started),
    );
  }
}
