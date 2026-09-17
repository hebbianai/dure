import {
  claimCliRequest,
  completeCliRequest,
} from "@/lib/cli/cliRequestBroker";
import { resolveCliSpaceId } from "@/lib/cli/cliSpaceIdentity";
import {
  resolveDesktopActivationTarget,
  resolveSpaceActivationTarget,
} from "@/lib/workspace/desktop/desktopActivation";
import { useStore } from "@/store";

async function handleSpaceActivate(
  params: Record<string, unknown>,
  reqId: string,
  legacyAction: boolean,
) {
  let space: ReturnType<typeof resolveSpaceActivationTarget>;
  try {
    const spaceId = resolveCliSpaceId(params, { required: true });
    space = legacyAction
      ? resolveDesktopActivationTarget(useStore.getState().spaces, spaceId)
      : resolveSpaceActivationTarget(useStore.getState().spaces, spaceId);
  } catch (error) {
    if (!(await claimCliRequest(reqId))) return null;
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!(await claimCliRequest(reqId))) return null;
  const state = useStore.getState();
  if (state.activeSpaceId !== space.id) {
    state.setActiveSpace(space.id);
  }
  const identity = {
    id: space.id,
    spaceId: space.id,
    desktopId: space.id,
    name: space.name,
    active: useStore.getState().activeSpaceId === space.id,
  };
  return {
    ok: true,
    space: identity,
    /** @deprecated Use `space`. */
    desktop: identity,
  };
}

export async function handleSpaceActivationCliRequest(
  params: Record<string, unknown>,
  reqId: string,
) {
  const result = await handleSpaceActivate(params, reqId, false);
  if (!result) return;
  await completeCliRequest(reqId, result, "space.activate");
}

/** @deprecated Use `handleSpaceActivationCliRequest`. */
export async function handleDesktopActivationCliRequest(
  params: Record<string, unknown>,
  reqId: string,
) {
  const result = await handleSpaceActivate(params, reqId, true);
  if (!result) return;
  await completeCliRequest(reqId, result, "desktop.activate");
}
