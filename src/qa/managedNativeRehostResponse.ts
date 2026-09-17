import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import { convertFileSrc } from "@/lib/ipc/core";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { commitManagedAgentRehostReceipt } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { durableAppStorage, useStore } from "@/store";
import {
	createNativeRehostBackendFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";

/** Used only by the isolated rehost probe. Control backend response timing for
 * its fixture Agent while preserving the native event/storage bridge. */
export async function probeLateNativeRehostResponse(
	launchKind: "resume_new_host" | "fresh" | "exact_resume",
	firstGeneration: number,
): Promise<string> {
	const original = window.fetch;
	const endpoint = convertFileSrc("dure_backend_request", "ipc");
	const backend = createNativeRehostBackendFixture(firstGeneration - 1);
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		if (String(args[0]) !== endpoint) return original.apply(window, args);
		const request = JSON.parse(String(args[1]?.body));
		if (request.body?.agentId !== "agent-1")
			return original.apply(window, args);
		try {
			const result = await backend.handleRequest(
				"dure_backend_request",
				request,
			);
			return new Response(JSON.stringify(result), {
				headers: { "content-type": "application/json", "Tauri-Response": "ok" },
			});
		} catch (error) {
			return new Response(String(error), {
				headers: { "content-type": "text/plain", "Tauri-Response": "error" },
			});
		}
	};
	const drain = async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await durableAppStorage.flush();
	};
	const completions: Array<ReturnType<typeof commitManagedAgentRehostReceipt>> =
		[];
	const waitForResponse = async (count: number) => {
		const deadline = Date.now() + 20_000;
		while (backend.pending.length < count) {
			if (Date.now() >= deadline)
				throw new Error(`Missing ${launchKind} response boundary: ${count}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	try {
		for (const generation of [firstGeneration, firstGeneration + 1]) {
			const payload = {
				...nativeResumePayloadFixture(generation, `account-${generation}`),
				launchKind,
				...(launchKind === "exact_resume"
					? { sourceConversationId: `conversation-${firstGeneration - 1}` }
					: {}),
				conversationId:
					launchKind === "fresh"
						? null
						: `conversation-${launchKind === "exact_resume" ? firstGeneration - 1 : generation}`,
			};
			backend.prepare(
				payload,
				launchKind === "fresh" ? `conversation-${generation}` : undefined,
			);
			const completion = commitManagedAgentRehostReceipt(payload, {
				activate: false,
			});
			completions.push(completion);
			void completion.catch(() => undefined);
			await waitForResponse(completions.length);
		}
		backend.pending[1].reply();
		await completions[1];
		await drain();
		backend.pending[0].reply();
		await completions[0];
		await drain();
		if (launchKind === "resume_new_host") {
			const payload = nativeResumePayloadFixture(
				firstGeneration + 1,
				`account-${firstGeneration + 1}`,
			);
			backend.observeCredentialGeneration("credential-observed-7");
			const observed = await createDureAgentRuntimeClient({
				profileId: "local",
			}).inspectExact("agent-1", payload.backendRouteAuthority!);
			if (observed.state !== "stable")
				throw new Error("Expected a stable fixture");
			projectAgentRuntimeTransition("agent-1", observed);
			useStore.setState({
				agents: [
					{
						...useStore.getState().agents[0],
						pendingCmd: "next explicit launch",
						skipPermissions: true,
					},
				],
			});
			await drain();
			await commitManagedAgentRehostReceipt(payload, { activate: false });
			await waitForResponse(3);
			backend.pending[2].reply();
			await drain();
		}
		return backend.currentSessionId();
	} finally {
		for (const pending of backend.pending) pending.lose();
		await Promise.allSettled(completions);
		await drain();
		window.fetch = original;
	}
}
