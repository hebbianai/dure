import {
  hasProcessPointScope,
  observeCurrentUserProcessIdentities,
  observeProcessMembers,
  processPointScope,
} from "../../lib/process-identity.mjs";
import { exactOwnedProcessIdentity } from "./owned-process-group.mjs";
import { identityOwnedRelations } from "./owned-process-identity-recovery.mjs";

async function currentUserCandidates(
  candidates,
  observeIdentities,
  platform,
  options,
) {
  let currentRelations;
  try {
    const identities = await observeIdentities({ ...options, platform });
    currentRelations = identityOwnedRelations(
      candidates.map(({ exact }) => exact.processIdentity),
      identities,
      process.geteuid?.(),
    );
  } catch (error) {
    throw new Error(
      `owned_process_identity_snapshot_unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const currentGenerations = new Set(
    currentRelations.map(
      ({ pid, processIdentity }) => `${pid}\0${processIdentity}`,
    ),
  );
  return candidates.filter(({ exact }) =>
    currentGenerations.has(`${exact.pid}\0${exact.processIdentity}`)
  );
}

async function observeCandidates(candidates, observeMembers, platform, options) {
  const scope = processPointScope(candidates.map(({ exact }) => exact.pid));
  const { requestedPids } = scope;
  if (requestedPids.length === 0) {
    return Object.freeze({
      members: Object.freeze([]),
      scope,
      status: "complete",
    });
  }
  const observation = await observeMembers(
    { kind: "point", pids: requestedPids },
    { ...options, platform },
  );
  if (
    observation.status === "complete" &&
    !hasProcessPointScope(observation, requestedPids)
  ) {
    throw new Error("owned_process_observation_scope_mismatch");
  }
  return observation;
}

export async function captureOwnedProcessSnapshot(
  ownedProcesses,
  {
    observeIdentities = observeCurrentUserProcessIdentities,
    platform = process.platform,
    ...options
  } = {},
) {
  const ledger = Object.freeze(
    ownedProcesses.map((record) => Object.freeze({ ...record })),
  );
  let candidates = ledger.map((expected) => ({
    exact: exactOwnedProcessIdentity(expected),
    expected,
  }));
  // The closed UID census proves stale generations without requesting BSD
  // metadata. Only exact surviving pairs reach the detailed observer.
  if (platform === "darwin" && candidates.length > 0) {
    candidates = await currentUserCandidates(
      candidates,
      observeIdentities,
      platform,
      options,
    );
  }
  return Object.freeze({
    candidates: Object.freeze(
      candidates.map((candidate) => Object.freeze(candidate)),
    ),
    ledger,
    platform,
  });
}

export async function observeOwnedProcessSnapshot(
  snapshot,
  {
    observeIdentities = observeCurrentUserProcessIdentities,
    observeMembers = observeProcessMembers,
    ...options
  } = {},
) {
  const deadline = Number.isSafeInteger(options.timeoutMs) &&
      options.timeoutMs > 0
    ? performance.now() + options.timeoutMs
    : undefined;
  const nextOptions = () => {
    if (deadline === undefined) return options;
    const timeoutMs = Math.ceil(deadline - performance.now());
    return timeoutMs > 0 ? { ...options, timeoutMs } : undefined;
  };
  let candidates = snapshot.candidates;
  // A captured generation may have departed before this observation. Refresh
  // it before an inaccessible replacement can consume the metadata deadline.
  if (snapshot.platform === "darwin" && candidates.length > 0) {
    const censusOptions = nextOptions();
    if (!censusOptions) {
      return {
        reason: "process_member_observation_timeout",
        status: "incomplete",
      };
    }
    candidates = await currentUserCandidates(
      candidates,
      observeIdentities,
      snapshot.platform,
      censusOptions,
    );
  }
  while (true) {
    const currentOptions = nextOptions();
    if (!currentOptions) {
      return {
        reason: "process_member_observation_timeout",
        status: "incomplete",
      };
    }
    const observation = await observeCandidates(
      candidates,
      observeMembers,
      snapshot.platform,
      currentOptions,
    );
    if (observation.status === "complete" || snapshot.platform !== "darwin") {
      return observation;
    }
    const censusOptions = nextOptions();
    if (!censusOptions) return observation;
    const surviving = await currentUserCandidates(
      candidates,
      observeIdentities,
      snapshot.platform,
      censusOptions,
    );
    if (surviving.length === candidates.length) return observation;
    candidates = surviving;
  }
}
