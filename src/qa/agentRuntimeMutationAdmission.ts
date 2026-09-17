import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { transitionAgentRuntime } from "@/lib/agents/agentRuntimeTransitionAction";
import { convertFileSrc } from "@/lib/ipc/core";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import { createRuntimeMutationAdmissionFixture } from "@/test/agentRuntimeMutationAdmissionFixtures";

/** Real action/projector and native IPC callbacks; every fixture mutation is
 * handled here without contacting a provider, credential store, or session. */
export async function probeRuntimeMutationAdmission() {
	const fixture = createRuntimeMutationAdmissionFixture();
	const original = window.fetch;
	const endpoint = convertFileSrc("dure_backend_request", "ipc");
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		if (String(args[0]) !== endpoint) return original.apply(window, args);
		const request = JSON.parse(String(args[1]?.body));
		if (request.body?.agentId !== fixture.agent.id)
			return original.apply(window, args);
		try {
			const result = await fixture.handleRequest(
				"dure_backend_request",
				request,
			);
			return new Response(JSON.stringify(result), {
				headers: { "content-type": "application/json", "Tauri-Response": "ok" },
			});
		} catch (error) {
			return new Response(String(error), {
				headers: { "Tauri-Response": "error" },
			});
		}
	};
	try {
		// This independent fixture reuses the prior rehost probe's agent ID.
		// Seed it durably before projecting it: an in-flight window rehydration
		// must not arbitrate unrelated fixture registrations as runtime successors.
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
			if (!current) throw new Error("Missing durable admission fixture store");
			return {
				value: {
					...current,
					state: {
						...current.state,
						agents: fixture.state.agents,
						projects: fixture.state.projects,
					},
				},
				result: undefined,
			};
		});
		useStore.setState(fixture.state);
		const observed = await createDureAgentRuntimeClient({
			profileId: "local",
		}).inspect("agent-1");
		if (observed.state !== "stable") throw new Error("Expected stable fixture");
		const converged =
			projectAgentRuntimeTransition("agent-1", observed) === fixture.current;
		let error: string | null = null;
		try {
			await transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "native_cli",
			});
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		}
		await durableAppStorage.flush();
		const stored = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		);
		return {
			converged,
			error,
			requests: fixture.requests,
			preserved:
				useStore.getState().agents[0] === fixture.agent &&
				useStore.getState().agentRuntimeLaunchPresentation["agent-1"] ===
					fixture.current,
			storedPendingCmd: stored?.state?.agents[0]?.pendingCmd,
		};
	} finally {
		window.fetch = original;
	}
}
