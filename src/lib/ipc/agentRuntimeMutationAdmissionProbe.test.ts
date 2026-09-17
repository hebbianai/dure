// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { probeRuntimeMutationAdmission } from "@/qa/agentRuntimeMutationAdmission";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<typeof import("@tauri-apps/api/core")>()),
	convertFileSrc: (command: string) => `http://ipc.local/${command}`,
	invoke: async (command: string, args: unknown) => {
		const response = await window.fetch(`http://ipc.local/${command}`, {
			body: JSON.stringify(args),
		});
		if (response.headers.get("Tauri-Response") === "error")
			throw new Error(await response.text());
		return response.json();
	},
}));

afterEach(async () => {
	await durableAppStorage.flush();
	vi.restoreAllMocks();
});

it("keeps the admission fixture durable during a prior rehost projection", async () => {
	useStore.setState({ agents: [managedRehostAgentFixture(13)] });
	await durableAppStorage.flush();
	await useStore.persist.rehydrate();
	// Native rehost completion freezes the previous ancestor while a newer
	// registration is already durable. The next probe must not reuse that
	// identity by writing an unrelated provider only into the local projection.
	const releaseAncestor = durableAppStorage.freezeProjectionAncestor();
	try {
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
			if (!current) throw new Error("Missing durable fixture");
			return {
				value: {
					...current,
					state: { ...current.state, agents: [managedRehostAgentFixture(14)] },
				},
				result: undefined,
			};
		});
		const observation = await probeRuntimeMutationAdmission();
		expect(observation).toEqual({
			converged: true,
			error: "client_agent_runtime_transition_conflict",
			requests: [
				"agent_runtime.projection.inspect",
				"agent_runtime.projection.inspect",
			],
			preserved: true,
			storedPendingCmd: "newer user work",
		});
	} finally {
		releaseAncestor();
	}
});
