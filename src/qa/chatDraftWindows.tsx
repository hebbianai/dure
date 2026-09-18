import { emit, emitTo } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { createDockview, type DockviewApi } from "dockview-react";
import { useSyncExternalStore } from "react";
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
import { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { AgentChatSubmission } from "@/lib/agents/chat/agentChatSubmission";
import { agentChatSubmissionStore } from "@/lib/agents/chat/agentChatSubmissionStore";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { computeTextDigest } from "@/lib/agents/promptIdentity";
import { t } from "@/lib/i18n";
import { homeDir, readFile, writeFile } from "@/lib/ipc";
import { webviewStorageOptions } from "@/lib/ipc/core";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
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
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

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
	queuedCancellations: number;
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
	let recovery: AgentChatSessionController | undefined;
	let releaseRemoval: (() => void) | undefined;
	let restoration: Promise<void> | undefined;
	const restoredInput = "Native unconfirmed input";
	const queuedInput = "Native queued input restored after moving its composer";
	let queuedCancellations = 0;
	let queuedEditing: Promise<string> | undefined;
	let holdQueueRead = false;
	let queueReadStarted = false;
	let releaseQueueRead: (() => void) | undefined;
	const queueRead = new Promise<void>((resolve) => {
		releaseQueueRead = resolve;
	});
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
		queueMessage: async () => {
			submissions += 1;
		},
		steerOrQueue: async () => {
			submissions += 1;
			return "queued";
		},
		dequeueMessage: async () => "",
		loadMoreQueued: async () => {},
		retryTurn: async () => {},
		editRetryableTurn: async () => undefined,
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
			queuedCancellations,
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
		const routeAuthority = testDureBackendRouteAuthority("native-qa", proof);
		const page: AgentTimelinePageV1 = {
			binding: {
				schemaVersion: 1,
				...identity,
				providerId: "codex",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: {
					runtimeGeneration: "native-qa",
					providerEpoch: "native-qa",
				},
				timelineEpoch: "native-qa",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "native-qa", sequence: 0 },
			hasMore: false,
		};
		const input: AgentChatSubmission = {
			agentId: identity.agentId,
			kind: "start",
			routeAuthority,
			request: {
				schemaVersion: 1,
				interactionSessionId: identity.interactionSessionId,
				runtime: page.binding.runtime,
				turnId: "native-unconfirmed-turn",
				clientMessageId: "native-unconfirmed-input",
				input: restoredInput,
				requestedAtMs: 1,
			},
		};
		if (!peerMode) await agentChatSubmissionStore.put(input);
		const forbidden = async (): Promise<never> => {
			submissions += 1;
			throw new Error("Native draft QA must not submit provider work");
		};
		const home = (await homeDir()).replace(/\/$/, "");
		check(
			home.includes("/dure-chat-draft-windows.") && home.endsWith("/home"),
			"Native draft QA escaped its disposable HOME",
		);
		const queueFile = `${home}/queued-input-state.txt`;
		if (!peerMode) await writeFile(queueFile, "inactive");
		const queuedIntent = {
			...input.request,
			turnId: "native-queued-turn",
			clientMessageId: "native-queued-input",
			input: queuedInput,
		};
		async function read() {
			return {
				backend: routeAuthority.backend,
				routeAuthority,
				read: {
					type: "page" as const,
					page: {
						...page,
						queuedInputs: {
							interactionSessionId: identity.interactionSessionId,
							inputs:
								(await readFile(queueFile)).content === "queued"
									? [
											{
												clientMessageId: queuedIntent.clientMessageId,
												sequence: 1,
												preview: queuedInput,
											},
										]
									: [],
							nextAfter: null,
						},
					},
				},
			};
		}
		const client: DureAgentConversationClient = {
			inspect: async () => ({
				backend: routeAuthority.backend,
				routeAuthority,
				binding: page.binding,
			}),
			recover: async (binding) => binding,
			read,
			subscribe: async () => {
				const observed = await read();
				return {
					...observed,
					initial: observed.read,
					subscriptionId: "native-qa",
					close: async () => {},
				};
			},
			inspectInput: async (request) => {
				if (request.clientMessageId !== queuedIntent.clientMessageId)
					return null;
				if (holdQueueRead) {
					queueReadStarted = true;
					await queueRead;
				}
				const state = (await readFile(queueFile)).content;
				if (state === "inactive") return null;
				check(
					state === "queued" || state === "canceled",
					"Invalid fixture queue state",
				);
				return { kind: "queued", intent: queuedIntent, state };
			},
			cancelQueuedTurn: async (request) => {
				check(
					request.clientMessageId === queuedIntent.clientMessageId,
					"Unexpected cancellation",
				);
				await writeFile(queueFile, "canceled");
				queuedCancellations += 1;
				return {
					intent: queuedIntent,
					state: "canceled",
					timelineCursor: { epoch: "native-qa", sequence: 2 },
				};
			},
			readQueue: forbidden,
			enqueueTurn: forbidden,
			continueTurn: async () => {
				throw new Error("Unexpected automatic continuation in this fixture");
			},
			startTurn: forbidden,
			steerTurn: forbidden,
			answerPending: forbidden,
			interruptTurn: forbidden,
			putGoal: forbidden,
		};
		const removing = new Promise<void>((resolve) => {
			releaseRemoval = resolve;
		});
		const controller = new AgentChatSessionController({
			...identity,
			client,
			submissionStore: {
				...agentChatSubmissionStore,
				remove: async (submission) => {
					if (!peerMode && submission.kind !== "edit") await removing;
					await agentChatSubmissionStore.remove(submission);
				},
			},
		});
		recovery = controller;
		controller.start();
		await waitFor(
			"persisted recovery input",
			() => controller.getSnapshot().phase === "ready",
		);

		session.editRetryableTurn = (restore) => {
			restoration = controller.editRetryableTurn(restore);
			return restoration;
		};
		session.dequeueMessage = (id, restore) => {
			queuedEditing = controller.dequeueMessage(id, restore);
			return queuedEditing;
		};
		function Composer() {
			const snapshot = useSyncExternalStore(
				controller.subscribe,
				controller.getSnapshot,
			);
			return (
				<ChatComposer session={{ ...session, ...snapshot }} disabled={false} />
			);
		}
		function queueEditButton() {
			return [...element.querySelectorAll("button")].find(
				(button) =>
					button.getAttribute("aria-label") === t("agents.chat.queuedEdit"),
			);
		}

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
							root.render(<Composer />);
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
						if (payload.action === "drop" || payload.action === "queued-drop") {
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
						} else if (payload.action === "queued-edit") {
							await waitFor(
								"late queued edit reaches the connected destination",
								() =>
									controller.getSnapshot().pendingQueueEdits?.length === 1 &&
									Boolean(queueEditButton()),
							);
							queueEditButton()!.click();
							await queuedEditing;
						} else if (
							payload.action === "return" ||
							payload.action === "queued-return"
						) {
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
					controller.stop();
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
		const original = {
			text: `${restoredInput}\n${originalText}`,
			attachments: [image],
		};
		await deliverAgentChatDraft(
			prepareAgentChatDraftTarget(useStore.getState().agents[0]),
			originalText,
			[image],
		);
		await waitFor("unconfirmed input recovery button", () =>
			[...element.querySelectorAll("button")].some(
				(button) => button.textContent === t("agents.chat.editUncertainSend"),
			),
		);
		[...element.querySelectorAll("button")]
			.find(
				(button) => button.textContent === t("agents.chat.editUncertainSend"),
			)!
			.click();
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
		check(
			(
				await agentChatSubmissionStore.list(
					identity.agentId,
					identity.interactionSessionId,
				)
			).length === 1,
			"Recovery retirement was not held across the native window move",
		);
		releaseRemoval!();
		await restoration;
		check(
			(
				await agentChatSubmissionStore.list(
					identity.agentId,
					identity.interactionSessionId,
				)
			).length === 0,
			"Completed draft recovery retained its submission record",
		);
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
		await writeFile(queueFile, "queued");
		controller.retryConnection();
		await waitFor(
			"queued input available to edit",
			() =>
				controller.getSnapshot().phase === "ready" &&
				Boolean(queueEditButton()),
		);
		holdQueueRead = true;
		queueEditButton()!.click();
		await waitFor("edit original read is held", () => queueReadStarted);
		await action("queued-drop");
		await waitFor(
			"source composer retires before the edit intent is persisted",
			() => !mounted.getPanel(panelId),
		);
		holdQueueRead = false;
		releaseQueueRead!();
		await queuedEditing;
		check(
			(
				await agentChatSubmissionStore.list(
					identity.agentId,
					identity.interactionSessionId,
				)
			).length === 1,
			"Canceled edit lost its original after the source composer retired",
		);
		const recovered = await action("queued-edit");
		check(
			draftMatches(recovered.draft, {
				...appended,
				text: `${editedText}\n${queuedInput}`,
			}),
			"Destination did not restore the canceled input and existing attachments",
		);
		check(
			recovered.queuedCancellations === 1 && queuedCancellations === 1,
			"Queue recovery repeated or skipped the explicit cancellation",
		);
		check(
			(
				await agentChatSubmissionStore.list(
					identity.agentId,
					identity.interactionSessionId,
				)
			).length === 0,
			"Completed queued edit retained its durable recovery record",
		);
		await action("queued-return");
		await waitFor(
			"recovered queued edit returns to source",
			() =>
				Boolean(mounted.getPanel(panelId)) &&
				element.querySelector("textarea")?.value ===
					`${editedText}\n${queuedInput}`,
		);
		await report("queued-returned");
		observations.push(snapshot("queued-returned"));
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
			restoredInput,
			recoveryRetiredAfterMove: true,
			queuedEditRestored: true,
			queuedInput,
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
		releaseRemoval?.();
		releaseQueueRead?.();
		if (!peerMode) {
			recovery?.stop();
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
