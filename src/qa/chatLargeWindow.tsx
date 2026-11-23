import { emitTo } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { type DockviewApi, DockviewReact } from "dockview-react";
import { createRoot } from "react-dom/client";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { StructuredAgentPanel } from "@/components/panels/StructuredAgentPanel";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { serveAgentChatFixtureForQa } from "@/lib/agents/chat/agentChatSessionRuntime";
import type { AgentTimelinePageV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { webviewStorageOptions } from "@/lib/ipc/core";
import type { DureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import type { DureAgentRuntimeSourceStopPolicyV1 } from "@/lib/ipc/dureAgentRuntime";
import { rehydrateDurableStore } from "@/lib/persistence/durableStoreRehydration";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { qaLog } from "@/lib/qa/qaLog";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { SECONDARY_WINDOW_LABEL_PREFIX } from "@/lib/workspace/window/windowLabel";
import { startWindowSync } from "@/lib/workspace/window/windows";
import { durableAppStorage, useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

/** Native QA for a Chat Agent's large window (#674). The source pane, the
 * large window, the agent-session bridge, durable store sync and the Chat
 * surface are the product's own; only the provider conversation is a fixture.
 * Every window is created hidden and unfocusable, so nothing takes focus. */

const REPORT = "qa:chat-large-window-report";
const ACTION = "qa:chat-large-window-action";
const AGENT_ID = "chat-large-window-qa";
const DESKTOP_ID = "chat-large-window-source";
const PANEL_ID = `agent:${AGENT_ID}`;
const SOURCE_PANE_OWNER = `${DESKTOP_ID}:${PANEL_ID}`;
const TYPED = "Sent from the large window";
const PROFILE = {
	schemaVersion: 1,
	kind: "structured_protocol",
	backendProfileId: "local",
	interactionSessionId: "chat-large-window-conversation",
} as const;

interface LargeWindowReport {
	proof: string;
	phase: string;
	label: string;
	error?: string;
	toolbar: boolean;
	viewControl: boolean;
	viewEnabled: boolean;
	composer: boolean;
	sent: string[];
	agentView: "chat" | "terminal" | "missing";
}

async function waitFor(description: string, ready: () => boolean) {
	const deadline = Date.now() + 30_000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
}

function check(condition: unknown, description: string): asserts condition {
	if (!condition) throw new Error(description);
}

/** The provider conversation: an empty, ready timeline that records every
 * message started on it and refuses any other provider action. */
function fixtureConversation(
	proof: string,
	onStart: (input: string) => void,
): DureAgentConversationClient {
	const routeAuthority = testDureBackendRouteAuthority("chat-large-qa", proof);
	const page: AgentTimelinePageV1 = {
		binding: {
			schemaVersion: 1,
			agentId: AGENT_ID,
			interactionSessionId: PROFILE.interactionSessionId,
			providerId: "claude",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: { runtimeGeneration: "chat-large-qa", providerEpoch: "chat-large-qa" },
			timelineEpoch: "chat-large-qa",
			bindingRevision: 1,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		rows: [],
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		recovery: null,
		latestFailure: null,
		goal: null,
		finalCursor: { epoch: "chat-large-qa", sequence: 0 },
		hasMore: false,
	};
	const read = async () => ({
		backend: routeAuthority.backend,
		routeAuthority,
		read: { type: "page" as const, page },
	});
	const refuse = async (): Promise<never> => {
		throw new Error("The large-window QA conversation offers no such action");
	};
	return {
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
				subscriptionId: "chat-large-qa",
				close: async () => {},
			};
		},
		inspectInput: async () => null,
		cancelQueuedTurn: refuse,
		readQueue: refuse,
		enqueueTurn: refuse,
		continueTurn: refuse,
		startTurn: async (request) => {
			onStart(request.input);
			return "accepted";
		},
		steerTurn: refuse,
		answerPending: refuse,
		interruptTurn: refuse,
		putGoal: refuse,
	};
}

function agentView(): LargeWindowReport["agentView"] {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === AGENT_ID);
	if (!agent) return "missing";
	return agent.interactionProfile ? "chat" : "terminal";
}

/** The Agent record after the source pane's View moved it. */
function projectAgent(view: "chat" | "terminal") {
	useStore.setState((state) => ({
		agents: state.agents.map((agent): Agent => {
			if (agent.id !== AGENT_ID) return agent;
			return view === "terminal"
				? {
						...agent,
						interactionProfile: undefined,
						runtimeBinding: hmuxManagedBinding(
							agent.sessionId,
							"chat-large-window-workspace",
						),
					}
				: { ...agent, runtimeBinding: undefined, interactionProfile: PROFILE };
		}),
	}));
}

function viewControl(): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		`[aria-label="${t("agents.runtime.viewLabel")}"]`,
	);
}

// --- Large window ------------------------------------------------------------

/** Installs the fixture conversation in the large window before it renders,
 * and answers the source window's steps from this window's own DOM. */
export function prepareChatLargeWindowQa(sourceWindowLabel: string): void {
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaChatLargeWindow");
	if (!import.meta.env.DEV || !proof) return;
	const sent: string[] = [];
	serveAgentChatFixtureForQa(fixtureConversation(proof, (input) => sent.push(input)));
	const label = getCurrentWebviewWindow().label;
	const observe = (phase: string, error?: string): LargeWindowReport => {
		const control = viewControl();
		return {
			proof,
			phase,
			label,
			...(error ? { error } : {}),
			toolbar: Boolean(document.querySelector("[data-agent-panel-toolbar]")),
			viewControl: Boolean(control),
			viewEnabled: Boolean(control && !control.hasAttribute("disabled")),
			composer: Boolean(document.querySelector("textarea")),
			sent: [...sent],
			agentView: agentView(),
		};
	};
	const report = (phase: string, error?: string) =>
		emitTo(sourceWindowLabel, REPORT, observe(phase, error));
	const steps: Record<string, () => Promise<void>> = {
		ready: async () => {
			await waitFor(
				"the Chat toolbar follows the source pane",
				() => observe("").viewEnabled && observe("").composer,
			);
		},
		send: async () => {
			const textarea = document.querySelector("textarea");
			check(textarea, "The large window has no composer");
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setValue?.call(textarea, TYPED);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
			const submit = () =>
				textarea.form?.querySelector<HTMLButtonElement>(
					'button[type="submit"]',
				);
			await waitFor("the send button is enabled", () => !submit()?.disabled);
			submit()!.click();
			await waitFor("the message reaches the conversation", () =>
				sent.includes(TYPED),
			);
		},
		"view-terminal": async () => {
			const control = viewControl();
			check(control, "The large window has no View control");
			control.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
			await waitFor("the View menu opens", () =>
				Boolean(document.querySelector('[role="option"][data-value="terminal"]')),
			);
			document
				.querySelector<HTMLElement>('[role="option"][data-value="terminal"]')!
				.click();
		},
		"terminal-followed": async () => {
			await waitFor(
				"the large window follows the Agent into its Terminal",
				() => agentView() === "terminal" && !document.querySelector("textarea"),
			);
		},
		"chat-followed": async () => {
			await waitFor(
				"the large window follows the Agent back into Chat",
				() => agentView() === "chat" && observe("").composer,
			);
		},
	};
	void listenWhenReady<{ proof: string; action: string }>(
		ACTION,
		({ payload }) => {
			if (payload.proof !== proof) return;
			const step = steps[payload.action];
			if (!step) return;
			void step().then(
				() => report(payload.action),
				(error: unknown) => report(payload.action, String(error)),
			);
		},
	).then(() => report("loaded"));
}

// --- Source window -----------------------------------------------------------

const launchSelection: AgentRuntimeLaunchSelectionView = {
	ownerKey: "chat-large-window-qa",
	loaded: true,
	hydrationError: false,
	model: "claude-sonnet",
	effort: null,
	permissionMode: "default",
	switching: false,
	error: null,
	switchSelection: async () => {
		throw new Error("The large-window QA does not change launch settings");
	},
	retryHydration: () => {},
	dismissError: () => {},
};
const historyActionLease = {
	busy: false,
	async run(action: () => Promise<void>) {
		await action();
		return true;
	},
};
const switchRequests: {
	sourceStopPolicy?: DureAgentRuntimeSourceStopPolicyV1;
	expectedSourceRevision?: number;
}[] = [];

/** The Agent pane as the workspace mounts it, with the backend transitions
 * replaced by the projection the backend would commit. */
function QaAgentPane(props: AgentPanelDockProps) {
	const agent = useStore((state) =>
		state.agents.find((candidate) => candidate.id === AGENT_ID),
	);
	if (!agent) return null;
	if (!agent.interactionProfile)
		return <div data-qa-terminal-pane="">Terminal</div>;
	return (
		<StructuredAgentPanel
			agent={agent}
			historyActionLease={historyActionLease}
			profile={agent.interactionProfile}
			panelProps={props}
			launchSelection={launchSelection}
			onRuntimeInvalidated={() => false}
			switchCredential={async () => {
				throw new Error("The large-window QA does not switch accounts");
			}}
			switchToNativeTerminal={async (
				_agentId,
				sourceStopPolicy,
				expectedSourceRevision,
			) => {
				switchRequests.push({ sourceStopPolicy, expectedSourceRevision });
				projectAgent("terminal");
				await durableAppStorage.flush();
			}}
		/>
	);
}

export async function runChatLargeWindowProbe(): Promise<void> {
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaChatLargeWindow");
	if (!import.meta.env.DEV || !proof || params.has("sessionWindow")) return;
	const label = getCurrentWebviewWindow().label;
	const reports = new Map<string, LargeWindowReport>();
	const observations: LargeWindowReport[] = [];
	const stops: Array<() => void> = [];
	let large: WebviewWindow | undefined;
	let proxyShown = false;
	let sourceSent = 0;
	serveAgentChatFixtureForQa(
		fixtureConversation(proof, () => {
			sourceSent += 1;
		}),
	);
	const element = document.createElement("section");
	element.style.cssText = "position:absolute;inset:0;width:900px;height:640px";
	document.body.append(element);
	try {
		stops.push(
			await listenWhenReady<LargeWindowReport>(REPORT, ({ payload }) => {
				if (payload.proof === proof) reports.set(payload.phase, payload);
			}),
		);
		await rehydrateDurableStore();
		useStore.setState({
			projects: [
				{
					id: "chat-large-window-project",
					name: "Chat large window QA",
					path: "/repo",
					kind: "local",
					isRepo: false,
				},
			],
			agents: [
				agentFixture({
					id: AGENT_ID,
					name: "Chat large window QA",
					provider: "claude",
					projectId: "chat-large-window-project",
					sessionId: "chat-large-window-session",
					runtimeBinding: undefined,
					interactionProfile: PROFILE,
				}),
			],
			spaces: [{ id: DESKTOP_ID, name: "Source" }],
			activeSpaceId: DESKTOP_ID,
			layouts: {},
		});
		let api: DockviewApi | undefined;
		const root = createRoot(element);
		stops.push(() => root.unmount());
		root.render(
			<WorkspaceRuntimeProvider
				desktopId={DESKTOP_ID}
				active
				presentationRoleStore={new TerminalPresentationRoleStore()}
				commitLayout={() => true}
			>
				<DockviewReact
					components={{ agent: QaAgentPane }}
					onReady={(event) => {
						api = event.api;
					}}
				/>
			</WorkspaceRuntimeProvider>,
		);
		await waitFor("Dockview is ready", () => Boolean(api));
		const mounted = api!;
		mounted.layout(900, 640);
		mounted.addPanel({
			id: PANEL_ID,
			component: "agent",
			params: { agentRef: { agentId: AGENT_ID } },
			title: "Chat large window QA",
		});
		registerDockview(DESKTOP_ID, mounted);
		stops.push(() => unregisterDockview(DESKTOP_ID, mounted));
		useStore.getState().saveLayout(DESKTOP_ID, mounted.toJSON());
		await durableAppStorage.flush();
		stops.push(startWindowSync());
		await waitFor("the source Chat pane renders its composer", () =>
			Boolean(element.querySelector("textarea")),
		);

		const largeLabel = `${SECONDARY_WINDOW_LABEL_PREFIX}session-${AGENT_ID}`;
		large = new WebviewWindow(largeLabel, {
			...(await webviewStorageOptions()),
			url: `index.html?sessionWindow=${encodeURIComponent(AGENT_ID)}&sourceWindow=${encodeURIComponent(label)}&sourcePane=${encodeURIComponent(SOURCE_PANE_OWNER)}&qaChatLargeWindow=${encodeURIComponent(proof)}`,
			width: 1180,
			height: 880,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
		await waitFor("the large window loads", () => reports.has("loaded"));
		const step = async (action: string) => {
			reports.delete(action);
			await emitTo(largeLabel, ACTION, { proof, action });
			await waitFor(`large window ${action}`, () => reports.has(action));
			const received = reports.get(action)!;
			observations.push(received);
			check(!received.error, `Large window ${action} failed: ${received.error}`);
			return received;
		};

		const ready = await step("ready");
		check(ready.toolbar && ready.viewEnabled, "The Chat toolbar is missing");
		// The pane hands its conversation to the window that shows it.
		await waitFor("the source pane shows the large-window proxy", () =>
			Boolean(element.querySelector("[data-agent-session-window-proxy]")),
		);
		proxyShown = !element.querySelector("textarea");
		check(proxyShown, "The source pane kept a second composer");

		const sent = await step("send");
		check(sent.sent.includes(TYPED), "The message did not reach the session");

		await step("view-terminal");
		await waitFor(
			"the View switch runs on the source pane",
			() => switchRequests.length === 1,
		);
		check(
			switchRequests[0].sourceStopPolicy === "preserve",
			"The View switch did not preserve its source first",
		);
		const terminal = await step("terminal-followed");
		check(terminal.agentView === "terminal", "The window lost the Agent");

		projectAgent("chat");
		await durableAppStorage.flush();
		const chat = await step("chat-followed");
		check(chat.composer && chat.toolbar, "The window did not return to Chat");
		// Hidden windows never focus, so the window is retired without the
		// user-facing close path, which brings the source window forward.
		await large.destroy();
		large = undefined;
		qaLog("chat-large-window", {
			proof,
			result: "passed",
			label,
			largeLabel,
			typed: TYPED,
			proxyShown,
			switchRequests,
			sourceSent,
			observations,
			userAgent: navigator.userAgent,
		});
	} catch (error) {
		qaLog("chat-large-window", {
			proof,
			result: "failed",
			error: error instanceof Error ? error.message : String(error),
			proxyShown,
			switchRequests,
			observations,
		});
	} finally {
		await large?.destroy().catch(() => {});
		for (const stop of stops.reverse()) stop();
		element.remove();
	}
}
