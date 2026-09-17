import { parseLinuxProcessIdentity } from "../../lib/process-identity.mjs";

/**
 * @typedef {{kind: "current", member: object} |
 *   {kind: "departed" | "reused" | "legacy_live", member?: never}} OwnedGenerationState
 */

export function isDepartedProcessMember(member) {
  return !member || member.state === "zombie";
}

/**
 * Classify one canonical member at the expected PID against an already parsed
 * persisted kernel generation. Legacy ticks can prove departure, not ownership.
 * @returns {OwnedGenerationState}
 */
export function classifyOwnedGeneration(generation, member) {
  if (isDepartedProcessMember(member)) return { kind: "departed" };
  if (generation.kind === "linux_bootless") {
    const observed = parseLinuxProcessIdentity(member.processIdentity);
    return observed && BigInt(observed.startTicks).toString() === generation.startTicks
      ? { kind: "legacy_live" }
      : { kind: "reused" };
  }
  return member.processIdentity === generation.processIdentity
    ? { kind: "current", member }
    : { kind: "reused" };
}
