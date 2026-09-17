import type { Space } from "@/types";

export function resolveSpaceActivationTarget(
  spaces: readonly Space[],
  requestedSpaceId: unknown,
): Space {
  const spaceId =
    typeof requestedSpaceId === "string" ? requestedSpaceId.trim() : "";
  if (!spaceId) {
    throw new Error("spaceId is required");
  }
  const space = spaces.find((candidate) => candidate.id === spaceId);
  if (!space) {
    throw new Error(`Space ${spaceId} was not found`);
  }
  return space;
}

/** @deprecated Use `resolveSpaceActivationTarget`. */
export function resolveDesktopActivationTarget(
  spaces: readonly Space[],
  requestedDesktopId: unknown,
): Space {
  return resolveSpaceActivationTarget(spaces, requestedDesktopId);
}
