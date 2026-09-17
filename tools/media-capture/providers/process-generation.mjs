import {
  parseLinuxProcessIdentity,
  parseMacosProcessIdentity,
  processMemberSnapshots,
} from "../../../scripts/lib/process-identity.mjs";

function sharedGeneration(processId, platform) {
  const observation = processMemberSnapshots([processId], platform);
  if (observation.status !== "complete") {
    throw new Error("cannot observe exact media owner generation");
  }
  return observation.members[0]?.processIdentity;
}

export function observeProcessGeneration(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 1) {
    throw new Error("media owner process id must be an integer greater than one");
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    return sharedGeneration(processId, process.platform);
  }
  throw new Error("exact media owner generation is unsupported on this platform");
}

export function exactProcessGenerationStatus(expected) {
  if (
    !Number.isSafeInteger(expected?.processId) ||
    expected.processId <= 1 ||
    typeof expected?.startMarker !== "string" ||
    expected.startMarker.length === 0
  ) {
    throw new Error("media cleanup ledger has an invalid owner generation");
  }
  const expectedIdentity = process.platform === "darwin"
    ? parseMacosProcessIdentity(expected.startMarker)
    : parseLinuxProcessIdentity(expected.startMarker);
  if (!expectedIdentity) {
    const platformName = process.platform === "darwin" ? "macOS" : "Linux";
    throw new Error(
      `media cleanup ledger has an invalid ${platformName} owner generation`,
    );
  }
  const observed = observeProcessGeneration(expected.processId);
  if (observed === undefined) return "absent";
  return observed === expectedIdentity.processIdentity ? "live" : "replaced";
}
