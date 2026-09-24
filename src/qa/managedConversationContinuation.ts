import { emit, emitTo } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { webviewStorageOptions } from "@/lib/ipc/core";
import { DURABLE_STORE_REHYDRATED_EVENT } from "@/lib/persistence/durableStoreRehydration";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { qaLog } from "@/lib/qa/qaLog";
import { applyProjectedConversationIdentity } from "@/lib/sessions/managed/managedConversationIdentity";
import { startWindowSync } from "@/lib/workspace/window/windows";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

interface Observation {
	proof: string;
	realm: string;
	window: string;
	conversation?: string;
	stored?: string;
	session?: string;
}
const OBSERVE = "qa:conversation-continuation-observe";
const RELOAD = "qa:conversation-continuation-reload";

/** Real native WebViews and durable storage, synthetic Host projections. */
export async function runManagedConversationContinuationProbe(proof: string) {
	const peer = new URLSearchParams(location.search).get("peer") === "1";
	const label = getCurrentWebviewWindow().label;
	const realm = crypto.randomUUID();
	const peerLabel = `win-conversation-${proof}`;
	const reports = new Map<string, Observation>();
	const stops: Array<() => void> = [];
	const snapshot = (): Observation => ({
		proof,
		realm,
		window: label,
		conversation: useStore.getState().agents[0]?.conversationId,
		session: useStore.getState().agents[0]?.sessionId,
		stored: JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null")
			?.state?.agents[0]?.conversationId,
	});
	const report = () => {
		void emit(OBSERVE, snapshot());
	};
	const wait = async (description: string, condition: () => boolean) => {
		const deadline = Date.now() + 20_000;
		while (!condition()) {
			if (Date.now() > deadline)
				throw new Error(
					`${description}: ${JSON.stringify([...reports.values()])}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	try {
		await durableAppStorage.flush();
		await useStore.persist.rehydrate();
		stops.push(
			await listenWhenReady<Observation>(OBSERVE, ({ payload }) => {
				if (payload.proof === proof) reports.set(payload.window, payload);
			}),
		);
		window.addEventListener(DURABLE_STORE_REHYDRATED_EVENT, report);
		stops.push(() =>
			window.removeEventListener(DURABLE_STORE_REHYDRATED_EVENT, report),
		);
		stops.push(startWindowSync());
		if (peer) {
			stops.push(
				await listenWhenReady<{ proof: string }>(RELOAD, ({ payload }) => {
					if (payload.proof === proof) location.reload();
				}),
			);
			report();
			window.addEventListener(
				"pagehide",
				() => {
					for (const stop of stops) stop();
				},
				{ once: true },
			);
			return;
		}
		const agent = managedRehostAgentFixture(9);
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || !binding.stopFence)
			throw new Error("fixture binding missing");
		const original = {
			...binding.stopFence,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			providerId: agent.provider,
			conversationId: "original-conversation",
			revision: "1",
			observedThroughOutputSeq: "10",
			source: "provider_event" as const,
		};
		useStore.setState({
			agents: [...applyProjectedConversationIdentity([agent], original)],
		});
		await durableAppStorage.flush();
		new WebviewWindow(peerLabel, {
			...(await webviewStorageOptions()),
			url: `index.html?qaWindowSmokeController=1&qaManagedRehostSync=${proof}&conversationOnly=1&peer=1`,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
		await wait(
			"initial peer identity",
			() => reports.get(peerLabel)?.stored === "original-conversation",
		);
		const continued = applyProjectedConversationIdentity(
			useStore.getState().agents,
			{ ...original, revision: "2", conversationId: "continued-conversation" },
		);
		useStore.setState({
			agents: [...applyProjectedConversationIdentity(continued, original)],
		});
		await durableAppStorage.flush();
		report();
		const both = () =>
			[label, peerLabel].every((window) => {
				const value = reports.get(window);
				return (
					value?.conversation === "continued-conversation" &&
					value.stored === "continued-conversation" &&
					value.session === "session-9"
				);
			});
		await wait("continued identity in both windows", both);
		const previousRealm = reports.get(peerLabel)?.realm;
		await emitTo(peerLabel, RELOAD, { proof });
		await wait(
			"continued identity after WebView restart",
			() => reports.get(peerLabel)?.realm !== previousRealm && both(),
		);
		qaLog("managed-rehost-sync", {
			proof,
			result: "passed",
			scenario: "conversation-continuation",
			evidence:
				"Two native WebViews, durable-only invalidation, stale projection refused, peer reload preserves latest conversation",
			reports: [...reports.values()],
		});
	} catch (error) {
		qaLog("managed-rehost-sync", {
			proof,
			result: "failed",
			scenario: "conversation-continuation",
			error: String(error),
			reports: [...reports.values()],
		});
	} finally {
		if (!peer) for (const stop of stops) stop();
	}
}
