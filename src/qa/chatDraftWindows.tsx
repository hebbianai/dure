import { emit, emitTo } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { createDockview, type DockviewApi } from "dockview-react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import { deliverAgentChatDraft } from "@/lib/agents/chat/agentChatDraftDelivery";
import { prepareAgentChatDraftTarget } from "@/lib/agents/chat/agentChatDraftInput";
import { agentChatDraftKey } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import type { AgentChatDraft } from "@/lib/agents/chat/agentChatDraftTypes";
import {
	type AgentChatPaneDropRequest,
	parseAgentChatPaneDropRequest,
} from "@/lib/agents/chat/agentChatPaneDropRequest";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { computeTextDigest } from "@/lib/agents/promptIdentity";
import { webviewStorageOptions } from "@/lib/ipc/core";
import {
	rehydrateDurableStore,
	subscribeDurableStoreLayoutProjection,
} from "@/lib/persistence/durableStoreRehydration";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { qaLog } from "@/lib/qa/qaLog";
import { movePanelsToDesktop } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import {
	registerDockview,
	runDockviewProjectionOnly,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { movePanelToDesktopDrop } from "@/lib/workspace/pane/paneDropCoordinator";
import { requestAgentSessionPaneDrop } from "@/lib/workspace/window/agentSessionWindowCommand";
import { mountedWindowGeneration } from "@/lib/workspace/window/mountedWindowIdentity";
import { startWindowSync } from "@/lib/workspace/window/windows";
import {
	probeSubmittedChatPaneSelection,
	submittedChatPaneSelectionCases,
} from "@/qa/submittedChatPaneSelection";
import { durableAppStorage, useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import draftFixture from "@/test/chatDraftFixtures.json";

const {
	nativeChatDraftEditedText: editedText,
	nativeChatDraftImageName,
	nativeChatDraftText: originalText,
} = draftFixture;

const REPORT = "qa:chat-draft-windows-report";
const ACTION = "qa:chat-draft-windows-action";
const identity = {
	agentId: "native-draft-qa",
	backendProfileId: "local",
	interactionSessionId: "native-draft-conversation",
};
const panelId = "pane:native-draft-qa";
const draftKey = agentChatDraftKey(identity);
interface Report {
	proof: string;
	phase: string;
	label: string;
	generation: string;
	userAgent: string;
	draft: AgentChatDraft | null;
	paneIds: string[];
	panes: ReturnType<typeof dockPanelReference>[];
	layout: unknown;
	composerText: string | null;
	imageSources: string[];
	interactionProfile: unknown;
	submissions: number;
	commandResults: unknown[];
	lastDrop?: AgentChatPaneDropRequest;
	receipt?: unknown;
	error?: string;
}

async function waitFor(description: string, ready: () => boolean) {
	const deadline = Date.now() + 25_000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
}
function check(condition: unknown, description: string): asserts condition {
	if (!condition) throw new Error(description);
}

function draftMatches(
	actual: AgentChatDraft | null,
	expected: AgentChatDraft,
): boolean {
	return (
		actual?.text === expected.text &&
		actual.attachments.length === expected.attachments.length &&
		actual.attachments.every(
			(attachment, index) =>
				attachment.fileName === expected.attachments[index].fileName &&
				attachment.dataB64 === expected.attachments[index].dataB64,
		)
	);
}

/** The provider session is a fixture. Window transport, storage, Dockview and
 * composer are real; no provider submission or physical OS input is simulated. */
export async function runChatDraftWindowsProbe(): Promise<void> {
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaChatDraftWindows");
	if (!import.meta.env.DEV || !proof) return;
	const peerMode = params.get("peer") === "1";
	const label = getCurrentWebviewWindow().label;
	const desktopId = peerMode ? "draft-target" : "draft-source";
	const peerLabel = `win-${Date.now()}-583`;
	const reports = new Map<string, Report>();
	const observations: Report[] = [];
	const paneSelections: ReturnType<typeof probeSubmittedChatPaneSelection>[] =
		[];
	const stops: Array<() => void> = [];
	let peer: WebviewWindow | undefined;
	let api: DockviewApi | undefined;
	let createdPane: ReturnType<typeof dockPanelReference> | undefined;
	let lastDrop: AgentChatPaneDropRequest | undefined;
	let submissions = 0;
	const commandResults: unknown[] = [];
	const element = document.createElement("section");
	element.style.cssText = "position:absolute;inset:0;width:800px;height:600px";
	document.body.append(element);
	const session: AgentChatSessionView = {
		draftIdentity: identity,
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		putGoal: async () => {
			throw new Error("Native draft QA must not change goals");
		},
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		retryConnection() {},
		loadOlder: async () => {},
		send: async () => {
			submissions += 1;
			throw new Error("Native draft QA must not submit");
		},
		queueMessage: () => {
			submissions += 1;
		},
		steerOrQueue: async () => {
			submissions += 1;
			return "queued";
		},
		dequeueMessage: () => undefined,
		retryTurn: async () => {},
		editRetryableTurn: () => undefined,
		answerPending: async () => {},
		interrupt: async () => {},
		dismissActionError() {},
	};
	function snapshot(phase: string, receipt?: unknown): Report {
		return {
			proof: proof!,
			phase,
			label,
			generation: mountedWindowGeneration,
			userAgent: navigator.userAgent,
			draft:
				useStore.getState().chatDrafts[identity.agentId]?.[draftKey] ?? null,
			paneIds: api?.panels.map((pane) => pane.id) ?? [],
			panes: structuredClone(api?.panels.map(dockPanelReference) ?? []),
			layout: api?.toJSON(),
			composerText: element.querySelector("textarea")?.value ?? null,
			imageSources: [...element.querySelectorAll("img")].map(
				(image) => image.src,
			),
			interactionProfile: useStore
				.getState()
				.agents.find((agent) => agent.id === identity.agentId)
				?.interactionProfile,
			submissions,
			commandResults: [...commandResults],
			lastDrop,
			receipt,
		};
	}
	async function report(phase: string, receipt?: unknown) {
		const draft = useStore.getState().chatDrafts[identity.agentId]?.[draftKey];
		if (draft && api?.getPanel(panelId))
			await waitFor(
				"actual composer observes received text",
				() => element.querySelector("textarea")?.value === draft.text,
			);
		await emit(REPORT, snapshot(phase, receipt));
	}
	try {
		stops.push(
			await listenWhenReady<Report>(REPORT, ({ payload }) => {
				if (payload.proof === proof) reports.set(payload.label, payload);
			}),
		);
		stops.push(
			await listenWhenReady<unknown>(
				"dure://agent-session/source-command",
				({ payload }) => {
					const parsed = parseAgentChatPaneDropRequest(payload);
					if (parsed) lastDrop = parsed;
				},
			),
		);
		stops.push(
			await listenWhenReady<unknown>(
				"dure://agent-session/source-command-result",
				({ payload }) => {
					commandResults.push(payload);
				},
			),
		);
		await rehydrateDurableStore();
		if (!peerMode) {
			for (const scenario of submittedChatPaneSelectionCases)
				paneSelections.push(probeSubmittedChatPaneSelection(scenario));
			const fixture = agentFixture({
				id: identity.agentId,
				name: "Native draft QA",
				projectId: "draft-project",
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: identity.backendProfileId,
					interactionSessionId: identity.interactionSessionId,
				},
			});
			useStore.setState({
				projects: [
					{
						id: "draft-project",
						name: "Draft QA",
						path: "/repo",
						kind: "local",
						isRepo: false,
					},
				],
				agents: [fixture],
				spaces: [
					{ id: "draft-source", name: "Source" },
					{ id: "draft-target", name: "Target" },
				],
				layouts: {},
				chatDrafts: {},
				chatDraftMoves: {},
				chatDraftMoveReceipts: {},
				chatDraftEpochs: {},
			});
		}
		const currentAgent = useStore
			.getState()
			.agents.find((agent) => agent.id === identity.agentId);
		check(
			currentAgent &&
				normalizeAgentInteractionProfileV1(currentAgent.interactionProfile),
			"Native QA requires the canonical structured Agent profile in both windows",
		);
		useStore.setState({ activeSpaceId: desktopId });
		api = createDockview(element, {
			createComponent: () => {
				const pane = document.createElement("div");
				let root: ReturnType<typeof createRoot> | undefined;
				return {
					element: pane,
					init(parameters) {
						if (parameters.api.id === panelId) {
							root = createRoot(pane);
							root.render(<ChatComposer session={session} disabled={false} />);
						} else pane.textContent = "Reference pane";
					},
					dispose() {
						root?.unmount();
					},
				};
			},
		});
		api.layout(800, 600);
		const initialPane = api.addPanel({
			id: peerMode ? "draft-reference" : panelId,
			component: "agent",
			params: { agentRef: peerMode ? null : { agentId: identity.agentId } },
			title: peerMode ? "Reference" : "Source draft",
		});
		createdPane = structuredClone(dockPanelReference(initialPane));
		registerDockview(desktopId, api);
		const mounted = api;
		stops.push(() => {
			unregisterDockview(desktopId, mounted);
			mounted.dispose();
			element.remove();
		});
		stops.push(
			subscribeDurableStoreLayoutProjection(desktopId, () => {
				const layout = useStore.getState().layouts[desktopId];
				if (layout)
					runDockviewProjectionOnly(mounted, () =>
						mounted.fromJSON(layout as Parameters<DockviewApi["fromJSON"]>[0], {
							reuseExistingPanels: true,
						}),
					);
				return true;
			}),
		);
		useStore.getState().saveLayout(desktopId, api.toJSON());
		await durableAppStorage.flush();
		stops.push(startWindowSync());
		stops.push(
			await listenWhenReady<{ proof: string; action: string }>(
				ACTION,
				({ payload }) => {
					if (payload.proof !== proof) return;
					void (async () => {
						let receipt: unknown;
						if (payload.action === "drop") {
							receipt = await movePanelToDesktopDrop(
								{ panelId, fromDesktopId: "draft-source" },
								desktopId,
								{
									referenceGroup: mounted.getPanel("draft-reference")!.group,
									direction: "right",
								},
							);
						} else if (payload.action === "edit") {
							useStore.getState().updateChatDraft(identity, (draft) => ({
								...draft,
								text: editedText,
							}));
							mounted.getPanel(panelId)!.api.setTitle("Edited after transfer");
						} else if (payload.action === "return") {
							receipt = await movePanelsToDesktop(
								[{ panelId, fromDesktopId: desktopId }],
								"draft-source",
							);
						}
						await report(payload.action, receipt);
					})().catch((error) =>
						emit(REPORT, { ...snapshot(payload.action), error: String(error) }),
					);
				},
				{ target: { kind: "WebviewWindow", label } },
			),
		);
		if (peerMode) {
			await report("ready");
			window.addEventListener(
				"pagehide",
				() => {
					for (const stop of stops.splice(0).reverse()) stop();
				},
				{ once: true },
			);
			return;
		}
		const canvas = document.createElement("canvas");
		canvas.width = 16;
		canvas.height = 16;
		const context = canvas.getContext("2d");
		check(context, "Canvas unavailable");
		context.fillStyle = "#156fa8";
		context.fillRect(0, 0, 16, 16);
		const image = {
			fileName: nativeChatDraftImageName,
			dataB64: canvas.toDataURL("image/png").split(",")[1],
		};
		const original = { text: originalText, attachments: [image] };
		await deliverAgentChatDraft(
			prepareAgentChatDraftTarget(useStore.getState().agents[0]),
			originalText,
			[image],
		);
		await report("source-ready");
		observations.push(snapshot("source-ready"));
		peer = new WebviewWindow(peerLabel, {
			...(await webviewStorageOptions()),
			url: `index.html?qaWindowSmokeController=1&qaChatDraftWindows=${proof}&peer=1&desktop=draft-target`,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
		await waitFor(
			"independent native peer",
			() => reports.get(peerLabel)?.phase === "ready",
		);
		const peerReady = reports.get(peerLabel)!;
		check(
			peerReady.generation !== mountedWindowGeneration &&
				peerReady.draft === null,
			"Peer did not start with independent volatile state",
		);
		observations.push(peerReady);
		async function action(name: string) {
			await emitTo(peerLabel, ACTION, { proof, action: name });
			await waitFor(
				`peer ${name}`,
				() => reports.get(peerLabel)?.phase === name,
			);
			const received = reports.get(peerLabel)!;
			check(!received.error, `Peer ${name} failed: ${received.error}`);
			observations.push(received);
			return received;
		}
		const dropped = await action("drop");
		check(
			draftMatches(dropped.draft, original),
			"Native drop lost draft/image bytes",
		);
		check(
			dropped.paneIds.includes(panelId),
			"Destination does not show moved pane",
		);
		await waitFor(
			"native source layout removal",
			() => !mounted.getPanel(panelId),
		);
		check(
			!useStore.getState().chatDrafts[identity.agentId],
			"Source draft was not released",
		);
		observations.push(snapshot("source-released"));
		const appended = {
			text: `${original.text}\n\nAdditional capture`,
			attachments: [...original.attachments, image],
		};
		await deliverAgentChatDraft(
			prepareAgentChatDraftTarget(useStore.getState().agents[0]),
			"Additional capture",
			[image],
		);
		const receivedAppend = await action("appended");
		check(
			draftMatches(receivedAppend.draft, appended),
			"Native append lost text/image bytes",
		);
		check(
			!useStore.getState().chatDrafts[identity.agentId],
			"Remote append created a hidden source draft",
		);
		const edited = await action("edit");
		check(dropped.lastDrop, "Native command observer has no drop packet");
		await requestAgentSessionPaneDrop(dropped.lastDrop);
		const replayed = await action("replayed");
		check(
			JSON.stringify(replayed.layout) === JSON.stringify(edited.layout),
			"Replay reverted native layout edits",
		);
		check(
			replayed.draft?.text === editedText,
			"Replay reverted newer draft edits",
		);
		const returned = await action("return");
		check(
			returned.draft === null && !returned.paneIds.includes(panelId),
			"Returning window retained composition ownership",
		);
		await waitFor(
			"original window receives returned draft and pane",
			() =>
				Boolean(mounted.getPanel(panelId)) &&
				useStore.getState().chatDrafts[identity.agentId]?.[draftKey]?.text ===
					editedText,
		);
		await report("returned");
		observations.push(snapshot("returned"));
		check(submissions === 0, "Draft migration submitted a provider turn");
		qaLog("chat-draft-windows", {
			proof,
			result: "passed",
			createdPane,
			observations,
			paneSelections,
			original,
			appended,
			editedText,
			submissions,
			imageDigest: await computeTextDigest(image.dataB64),
			limitation:
				"Actual hidden WKWebViews, native events/storage and ChatComposer with fixture Agent/session/image. Dockview projection subscriber is a QA adapter; physical OS input, full Workspace shell and provider submission are not claimed.",
		});
	} catch (error) {
		qaLog("chat-draft-windows", {
			proof,
			result: "failed",
			createdPane,
			error: String(error),
			observations,
			paneSelections,
			current: snapshot("failed"),
		});
	} finally {
		if (!peerMode) {
			if (peer)
				await peer.destroy().catch((error) =>
					qaLog("chat-draft-windows-cleanup", {
						proof,
						error: String(error),
					}),
				);
			for (const stop of stops.splice(0).reverse()) stop();
		}
	}
}
