import { emit } from "@tauri-apps/api/event";
import { createDockview } from "dockview-react";
import { installAgentTracker } from "@/lib/agents/agentTracker";
import { handleCliHmuxRehost } from "@/lib/cli/cliHmuxRehost";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { backendCapabilities, convertFileSrc } from "@/lib/ipc/core";
import {
	completeManagedAgentFreshStart,
	type ManagedAgentFreshStartExecution,
	type ManagedAgentFreshStartInspection,
	managedAgentFreshStartSyncPayload,
} from "@/lib/sessions/managed/managedAgentFreshStart";
import { managedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehost";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	commitManagedAgentRehostReceipt,
	commitReconciledManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { runManagedAgentRehostTransaction } from "@/lib/sessions/managed/managedAgentRehostTransaction";
import { resolveManagedAgentTarget } from "@/lib/sessions/managed/managedAgentTarget";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { durableAppStorage, useStore } from "@/store";
import {
	createNativeRehostBackendFixture,
	nativeResumeCreateFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";
import { managedRehostTransactionFixture } from "@/test/managedRehostTransactionFixtures";

async function observeNativeCompletion<T>(
	generation: number,
	complete: () => Promise<T>,
) {
	const session = nativeResumeCreateFixture(generation).session;
	const key = hmuxSessionMetadataKey(session.workspaceId, session.sessionId);
	let observed = false;
	const snapshot = () => ({
		activity: useStore.getState().agentActivity["agent-1"],
		outputSeq: useStore.getState().hmuxSessionMetadata[key]?.outputSeq,
		sessionId: useStore.getState().agents[0]?.sessionId,
	});
	let before: ReturnType<typeof snapshot> | undefined;
	const stopTracker = installAgentTracker();
	const stopObservation = useStore.subscribe((state, previous) => {
		if (
			observed ||
			state.agents === previous.agents ||
			state.agents[0]?.sessionId !== session.sessionId
		)
			return;
		observed = true;
		// Deliver newer observations after target installation but before
		// optional pane lookup settles, through the real tracker/store path.
		queueMicrotask(() => {
			useStore.getState().setSessionAgentRuntimeState(session.sessionId, {
				terminalEpoch: session.terminalEpoch!,
				revision: "1",
				observedThroughOutputSeq: "42",
				lifecycle: "running",
				activity: "working",
				attention: "none",
				source: "controller_input",
				turnCompletedCount: "0",
			});
			useStore
				.getState()
				.setHmuxSessionMetadata({ ...session, outputSeq: "42" });
			before = snapshot();
		});
	});
	try {
		const completion = await complete();
		await durableAppStorage.flush();
		return { before, after: snapshot(), completion };
	} finally {
		stopObservation();
		stopTracker();
	}
}

/** Exercise the actual Resume caller and its presentation awaits in a hidden
 * WebView. Only native create and backend publication use fixture responses. */
export async function probeNativeResumeCompletion() {
	const original = window.fetch;
	const createEndpoint = convertFileSrc(
		"hmux_managed_create_advance_v1",
		"ipc",
	);
	const routeEndpoint = convertFileSrc("dure_backend_route_assert", "ipc");
	const receipt = nativeResumeCreateFixture(10);
	let creates = 0;
	let unavailableRoutes = 0;
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		const endpoint = String(args[0]);
		if (endpoint !== createEndpoint && endpoint !== routeEndpoint)
			return original.apply(window, args);
		const request = JSON.parse(String(args[1]?.body));
		if (endpoint === routeEndpoint && request.route?.profileId === "local") {
			unavailableRoutes += 1;
			return new Response("Fixture backend route unavailable", {
				headers: { "Tauri-Response": "error" },
			});
		}
		if (
			endpoint !== createEndpoint ||
			request.request?.sessionId !== "session-9"
		)
			return original.apply(window, args);
		creates += 1;
		return new Response(JSON.stringify({ state: "advanced", receipt }), {
			headers: { "content-type": "application/json", "Tauri-Response": "ok" },
		});
	};
	try {
		const { completion, ...observation } = await observeNativeCompletion(
			10,
			() =>
				resumeExactManagedAgentPane(
					"agent-1",
					"agent:agent-1",
					"conversation-10",
				),
		);
		return {
			creates,
			unavailableRoutes,
			projection: completion.projection,
			...observation,
		};
	} finally {
		window.fetch = original;
	}
}

/** Exercise the real WebView caller with a simulated legacy capability reply.
 * This is not an old native binary: block any attempted create at the fixture
 * boundary so a failing regression can never start a provider. */
export async function probeNativeUnsupportedResume() {
	const capabilities = await backendCapabilities(true);
	if (!capabilities) throw new Error("Missing native adapter capabilities");
	const original = window.fetch;
	const capsEndpoint = convertFileSrc("app_caps", "ipc");
	const createEndpoint = convertFileSrc(
		"hmux_managed_create_advance_v1",
		"ipc",
	);
	const source = useStore.getState().agents[0];
	if (!source) throw new Error("Missing Resume source fixture");
	let creates = 0;
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		const endpoint = String(args[0]);
		if (endpoint === capsEndpoint)
			return new Response(
				JSON.stringify({
					...capabilities,
					features: capabilities.features.filter(
						(feature) => feature !== "hmux.managed-create-advance-v1",
					),
				}),
				{
					headers: {
						"content-type": "application/json",
						"Tauri-Response": "ok",
					},
				},
			);
		if (endpoint === createEndpoint) {
			creates += 1;
			return new Response("Command hmux_managed_create_advance_v1 not found", {
				headers: { "Tauri-Response": "error" },
			});
		}
		return original.apply(window, args);
	};
	try {
		await backendCapabilities(true);
		let errorMessage: string | undefined;
		try {
			await resumeExactManagedAgentPane(
				"agent-1",
				"agent:agent-1",
				"conversation-10",
			);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		const current = useStore.getState().agents[0];
		if (
			creates !== 0 ||
			errorMessage !== "hmux_managed_create_advance_v1_backend_unavailable" ||
			current?.sessionId !== source.sessionId ||
			current?.conversationId !== source.conversationId
		)
			throw new Error(
				"Unsupported Resume crossed the native mutation boundary",
			);
		return {
			simulatedLegacyCapabilities: true,
			creates,
			errorMessage,
			sourcePreserved: true,
		};
	} finally {
		window.fetch = original;
		await backendCapabilities(true);
	}
}

/** Exercise durable-successor completion without launching a provider or
 * bypassing automatic recovery's visible-window admission in the hidden app. */
export async function probeNativeReconciledCompletion() {
	const payload = {
		...nativeResumePayloadFixture(11),
		launchKind: "exact_resume" as const,
		sourceConversationId: "conversation-10",
		conversationId: "conversation-10",
		panelId: "pane:reconciled-slot",
	};
	const container = document.createElement("div");
	container.style.cssText =
		"position:fixed;width:900px;height:600px;visibility:hidden";
	document.body.append(container);
	const api = createDockview(container, {
		createComponent: () => ({
			element: document.createElement("div"),
			init() {},
		}),
	});
	api.layout(900, 600);
	const desktopId = "qa-reconciled-pane";
	registerDockview(desktopId, api);
	const stopRetarget = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents &&
			state.agents[0]?.sessionId === "session-11"
		) {
			queueMicrotask(() =>
				api
					.getPanel(payload.panelId)
					?.api.updateParameters({ agentRef: { agentId: "other-agent" } }),
			);
		}
	});
	try {
		api.addPanel({
			id: payload.panelId,
			component: "agent",
			params: { agentRef: { agentId: payload.agentId } },
		});
		api.addPanel({ id: "qa-unrelated-pane", component: "terminal" });
		const selected = api.activePanel?.id;
		const { completion, commits, ...observation } =
			await probeBackendCompletion(11, payload, () =>
				commitReconciledManagedAgentRehostReceipt({
					payload,
					replacement: nativeResumeCreateFixture(11).session,
					conversationId: payload.conversationId,
				}),
			);
		if (
			completion.projection !== "applied" ||
			completion.presentation !== "pending" ||
			api.activePanel?.id !== selected
		) {
			throw new Error(
				"Reconciled runtime completion activated a retargeted pane",
			);
		}
		return {
			reconciliations: commits,
			projection: completion.projection,
			retargetedPanePreserved: true,
			...observation,
		};
	} finally {
		stopRetarget();
		unregisterDockview(desktopId, api);
		api.dispose();
		container.remove();
	}
}

/** Use the same transaction as UI/CLI. Only source inspection and native
 * execution/journal lookup are fixtures; no provider process is started. */
export async function probeNativeTransactionCompletion(replay: boolean) {
	const generation = replay ? 13 : 12;
	const { inspection, recovery, payload } = managedRehostTransactionFixture(
		generation,
		"conversation-10",
	);
	let executions = 0;
	let lookups = 0;
	const { completion, ...observation } = await probeBackendCompletion(
		generation,
		payload,
		() =>
			runManagedAgentRehostTransaction(
				{
					name: inspection.agentId,
					panelId: inspection.panelId,
					confirmed: !replay,
					...(replay ? { operationId: payload.operationId } : {}),
				},
				{
					resolveTarget: resolveManagedAgentTarget,
					reconcile: async () => null,
					inspect: async () => inspection,
					reconcileOperation: async () => {
						lookups += 1;
						return recovery;
					},
					execute: async () => {
						executions += 1;
						return { recovery };
					},
					syncPayload: managedAgentRehostSyncPayload,
					commitReceipt: commitManagedAgentRehostReceipt,
					commitReconciledReceipt: commitReconciledManagedAgentRehostReceipt,
					emit,
					setMetadata: (session) =>
						useStore.getState().setHmuxSessionMetadata(session),
				},
			),
	);
	return {
		executions,
		lookups,
		replayed: completion.rehost.replayed,
		state: completion.state,
		outcome: completion.rehost.outcome,
		...observation,
	};
}

/** Exercise the CLI Fresh caller with real completion, metadata and native
 * event delivery. Native inspection/execution use a controlled successor. */
export async function probeNativeFreshCompletion() {
	const source = nativeResumePayloadFixture(14);
	const inspection: ManagedAgentFreshStartInspection = {
		agentId: source.agentId,
		agentName: source.agentName,
		projectId: source.projectId,
		providerId: source.providerId,
		sourceBinding: source.sourceBinding,
		sourceDiscoveryState: "exited",
		sourceConversationId: "conversation-10",
		cwd: source.cwd,
		desktopId: source.desktopId,
		panelId: source.panelId,
		permissionMode: "default",
		targetCredentialId: null,
		terminalEnvironment: {},
	};
	const replacement = nativeResumeCreateFixture(14);
	const execution: ManagedAgentFreshStartExecution = {
		createIdempotencyKey: replacement.idempotencyKey,
		replacement: replacement.session,
		receipt: {
			sourceSessionId: source.sourceBinding.sessionId,
			operationId: source.operationId,
			action: "replace_ai_provider_with_fresh_conversation",
			outcome: "replaced",
			replayed: false,
		},
	};
	const payload = managedAgentFreshStartSyncPayload(inspection, execution);
	const unexpected = async (): Promise<never> => {
		throw new Error("Unexpected non-Fresh fixture execution");
	};
	let executions = 0;
	const { completion, ...observation } = await probeBackendCompletion(
		14,
		payload,
		() =>
			handleCliHmuxRehost(
				{
					name: inspection.agentId,
					targetPanelId: inspection.panelId,
					freshStart: true,
					confirmRestart: true,
				},
				"qa-fresh-completion",
				{
					claim: async () => true,
					inspect: unexpected,
					rehost: unexpected,
					permissionModeRelaunch: unexpected,
					inspectFresh: async () => inspection,
					executeFresh: async () => {
						executions += 1;
						return execution;
					},
					completeFresh: completeManagedAgentFreshStart,
				},
			),
	);
	return { executions, completion, ...observation };
}

async function probeBackendCompletion<T>(
	generation: number,
	payload: ManagedAgentRehostSyncPayload,
	complete: () => Promise<T>,
) {
	const original = window.fetch;
	const endpoint = convertFileSrc("dure_backend_request", "ipc");
	const routeEndpoint = convertFileSrc("dure_backend_route_assert", "ipc");
	const backend = createNativeRehostBackendFixture(generation - 1);
	backend.prepare(payload);
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		const command = String(args[0]);
		if (command !== endpoint && command !== routeEndpoint)
			return original.apply(window, args);
		const request = JSON.parse(String(args[1]?.body));
		if (command === routeEndpoint && request.route?.profileId === "local") {
			return new Response(
				JSON.stringify(
					nativeResumePayloadFixture(generation).backendRouteAuthority,
				),
				{
					headers: {
						"content-type": "application/json",
						"Tauri-Response": "ok",
					},
				},
			);
		}
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
				headers: { "Tauri-Response": "error" },
			});
		}
	};
	let completion: Promise<T> | undefined;
	try {
		const observation = await observeNativeCompletion(generation, async () => {
			completion = complete();
			void completion.catch(() => undefined);
			const deadline = Date.now() + 20_000;
			while (backend.pending.length === 0) {
				if (Date.now() >= deadline)
					throw new Error("Missing rehost commit response boundary");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			backend.pending[0].reply();
			return completion;
		});
		return { commits: backend.pending.length, ...observation };
	} finally {
		for (const pending of backend.pending) pending.lose();
		await completion?.catch(() => undefined);
		window.fetch = original;
	}
}
