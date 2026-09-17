import {
	isHmuxManagedGenerationV1,
	sameHmuxManagedGeneration,
} from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { HmuxManagedStopFenceV1 } from "@/types";
import type { RemoteHmuxCatalogSessionV1 } from "./remoteHmuxBroker";

export function resolveRemoteHmuxAttachFence(
	prepareResult: unknown,
	persistedFence: HmuxManagedStopFenceV1 | undefined,
): HmuxManagedStopFenceV1 | undefined {
	const preparedFence = isHmuxManagedGenerationV1(prepareResult)
		? prepareResult
		: undefined;
	if (
		preparedFence &&
		persistedFence &&
		!sameHmuxManagedGeneration(preparedFence, persistedFence)
	) {
		throw new Error("remote_hmux_managed_attach_fence_changed");
	}
	return preparedFence ?? persistedFence;
}

export function requireRemoteHmuxAttachGeneration(
	session: RemoteHmuxCatalogSessionV1,
	expectedFence: HmuxManagedStopFenceV1 | undefined,
): void {
	if (session.sessionClass === "managed" && !expectedFence) {
		throw new Error("remote_hmux_managed_attach_fence_missing");
	}
	if (
		expectedFence &&
		(session.sessionClass !== "managed" ||
			!sameHmuxManagedGeneration(session, expectedFence))
	) {
		throw new Error("remote_hmux_managed_attach_generation_changed");
	}
}
