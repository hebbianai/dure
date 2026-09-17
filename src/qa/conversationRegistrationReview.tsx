import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ManagedAgentRecoveryBar } from "@/components/sessions/ManagedAgentRecoveryBar";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { t } from "@/lib/i18n";
import { convertFileSrc } from "@/lib/ipc/core";
import { conversationRegistrationPeers } from "@/lib/sessions/recovery/conversationRegistrationPeers";
import {
	clearHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { durableAppStorage, useStore } from "@/store";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

/** Real hidden WebView rendering and action wiring, with native history/create
 * responses intercepted. This fixture must never launch a provider. */
export async function probeConversationRegistrationReview() {
	const previous = useStore.getState();
	const source = managedRehostAgentFixture(20);
	const peer = {
		...managedRehostAgentFixture(21),
		id: "qa-conversation-peer",
		name: "qa-linked-fork",
		conversationId: source.conversationId,
	};
	const binding = source.runtimeBinding;
	const paneHealthId = hmuxPaneHealthId(undefined, `agent:${source.id}`);
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local")
		throw new Error("Missing QA binding");
	const historyEndpoint = convertFileSrc("list_conversations", "ipc");
	const createEndpoint = convertFileSrc(
		"hmux_managed_create_advance_v1",
		"ipc",
	);
	const originalFetch = window.fetch;
	let scans = 0;
	let creates = 0;
	let requestedConversation: string | undefined;
	let available = false;
	let deadInput = false;
	const container = document.createElement("div");
	container.style.cssText = "position:relative;width:480px;height:360px";
	document.body.append(container);
	let renderError: string | undefined;
	const root = createRoot(container, {
		onUncaughtError: (error) => {
			renderError = String(error);
		},
	});
	const response = (value: unknown) =>
		new Response(JSON.stringify(value), {
			headers: { "content-type": "application/json", "Tauri-Response": "ok" },
		});
	const waitFor = async (description: string, ready: () => boolean) => {
		const deadline = performance.now() + 5_000;
		while (!ready()) {
			if (performance.now() >= deadline) {
				const current = useStore.getState().agents;
				throw new Error(
					`Duplicate review: ${description}; ${JSON.stringify({
						renderError,
						available,
						deadInput,
						sourcePreserved: current[0] === source,
						peerPreserved: current[1] === peer,
						peers: conversationRegistrationPeers(current, source.id).length,
						buttons: container.querySelectorAll("button").length,
					})}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === label,
		);
	window.fetch = async (
		...args: Parameters<typeof fetch>
	): Promise<Response> => {
		const endpoint = String(args[0]);
		if (endpoint === historyEndpoint) {
			scans += 1;
			return response([{ id: "qa-exact-child", title: "QA child", mtime: 1 }]);
		}
		if (endpoint === createEndpoint) {
			creates += 1;
			const body = JSON.parse(String(args[1]?.body));
			requestedConversation = body.request?.conversationId;
			return response({
				state: "rejected",
				code: "hmux_managed_conversation_writer_conflict",
				message: "QA exact writer conflict",
			});
		}
		return originalFetch.apply(window, args);
	};
	try {
		const healthy = hmuxSessionSummaryFixture({
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			lifecycle: "ready",
			health: "current_healthy",
			inputAllowed: true,
		});
		const metadataKey = hmuxSessionMetadataKey(
			binding.workspaceId,
			binding.sessionId,
		);
		useStore.setState({
			agents: [source],
			accounts: [],
			agentActivity: { [source.id]: "working", [peer.id]: "waiting" },
			hmuxSessionMetadata: { [metadataKey]: healthy },
		});
		publishHmuxPaneHealthObservation(paneHealthId, {
			kind: "frame_received",
			terminalEpoch: healthy.terminalEpoch,
			sequence: "10",
		});
		flushSync(() =>
			root.render(
				<ManagedAgentRecoveryBar
					agentId={source.id}
					panelId={`agent:${source.id}`}
					binding={binding}
					onAvailabilityChange={(shown, blocked) => {
						available = shown;
						deadInput = blocked;
					}}
				/>,
			),
		);
		// Commit each real store notification in the hidden WebView. No provider
		// is probed or replaced: unknown census facts must not expose recovery.
		for (const health of [
			"unprobed",
			"generation_changed",
			"stale_transport",
		] as const) {
			for (const metadata of [
				{
					...healthy,
					lifecycle: "unavailable" as const,
					health,
					inputAllowed: false,
				},
				healthy,
			]) {
				flushSync(() => useStore.getState().setHmuxSessionMetadata(metadata));
				if (
					container.querySelector("button") ||
					available ||
					deadInput ||
					scans ||
					creates
				)
					throw new Error(`Unconfirmed health exposed recovery: ${health}`);
			}
		}
		flushSync(() => {
			useStore.getState().setHmuxSessionMetadata({
				...healthy,
				lifecycle: "unavailable",
				health: "stale_transport",
				inputAllowed: false,
			});
			publishHmuxPaneHealthObservation(paneHealthId, {
				kind: "connection",
				state: "error",
				reason: "host_disconnected",
			});
		});
		if (
			!button(t("sessions.recovery.resumeExactConversation")) ||
			!available ||
			!deadInput
		)
			throw new Error("Disconnected attachment lost recovery");
		flushSync(() =>
			publishHmuxPaneHealthObservation(paneHealthId, {
				kind: "frame_received",
				terminalEpoch: healthy.terminalEpoch,
				sequence: "11",
			}),
		);
		if (
			container.querySelector("button") ||
			available ||
			deadInput ||
			scans ||
			creates
		)
			throw new Error("Live attachment retained automatic recovery");
		useStore.getState().setHmuxSessionMetadata(healthy);
		useStore.setState({ agents: [source, peer] });
		await waitFor(
			"working pane notice missing",
			() => Boolean(button(t("sessions.duplicates.review"))) && available,
		);
		if ([scans, creates].some((count) => count !== 0) || deadInput)
			throw new Error("Notice performed work or disabled input");
		button(t("sessions.duplicates.review"))?.click();
		await waitFor("exact history picker missing", () =>
			Boolean(container.querySelector("select")),
		);
		const picker = container.querySelector("select")!;
		if (picker.value !== "" || creates)
			throw new Error("Review selected or resumed automatically");
		picker.value = "qa-exact-child";
		picker.dispatchEvent(new Event("change", { bubbles: true }));
		await waitFor(
			"exact action not enabled",
			() =>
				button(t("sessions.recovery.resumeExactConversation"))?.disabled ===
				false,
		);
		button(t("sessions.recovery.resumeExactConversation"))?.click();
		await waitFor(
			"native refusal missing",
			() =>
				container.textContent?.includes("QA exact writer conflict") === true,
		);
		if (
			scans !== 1 ||
			creates !== 1 ||
			requestedConversation !== "qa-exact-child" ||
			useStore.getState().agents[1] !== peer
		) {
			throw new Error(
				"Review changed the target, repeated a request or changed its peer",
			);
		}
		// Model a later authoritative projection; no repair success is fabricated
		// from the rejected request, and no provider is started by this probe.
		useStore.setState({
			agents: [{ ...source, conversationId: "qa-projected-child" }, peer],
		});
		await waitFor(
			"notice did not follow the newer registration",
			() => !available && !container.textContent?.includes(peer.name),
		);
		await durableAppStorage.flush();
		return {
			unconfirmedHealthTransitions: 3,
			attachmentReconnectVerified: true,
			scans,
			creates,
			requestedConversation,
			peerPreserved: useStore.getState().agents[1] === peer,
			deadInput,
		};
	} finally {
		root.unmount();
		clearHmuxPaneHealth(paneHealthId);
		container.remove();
		window.fetch = originalFetch;
		useStore.setState({
			agents: previous.agents,
			accounts: previous.accounts,
			agentActivity: previous.agentActivity,
			hmuxSessionMetadata: previous.hmuxSessionMetadata,
		});
		await durableAppStorage.flush();
	}
}
