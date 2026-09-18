import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DockviewReact, type DockviewApi } from "dockview-react";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { AgentRuntimeProfileSwitch } from "@/components/agents/AgentRuntimeProfileSwitch";
import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import { useAgentLaunchControlsPresentation } from "@/components/agents/useAgentToolbarControls";
import { AgentPanelToolbarFrame } from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/ipc/dureAgentRuntime";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";
import "dockview-react/dist/styles/dockview.css";
import "@/index.css";

declare global {
	interface Window {
		__PANE_TOOLBAR_FIXTURE__: {
			dock?: DockviewApi;
			selections: number;
			switches: number;
		};
	}
}

// Real pane controls and Dockview geometry, disposable data and no runtime operations.
const evidence = (window.__PANE_TOOLBAR_FIXTURE__ = {
	selections: 0,
	switches: 0,
} as Window["__PANE_TOOLBAR_FIXTURE__"]);
const agent = managedAgentFixture();
const account = {
	id: "toolbar-account",
	provider: "codex" as const,
	name: "crispy",
	dir: "/fixture/credentials",
};
useStore.setState({
	language: "en",
	uiPrefs: {
		...useStore.getState().uiPrefs,
		interfaceMode: "pro",
		hiddenToolbarControls: ["launch-permissions"],
	},
});
useDiffBadges.setState({
	badges: {
		[agent.id]: {
			added: 20,
			deleted: 4,
			binary: 0,
			files: 5,
			committed: { added: 12, deleted: 1, binary: 0, files: 2 },
			worktree: { added: 8, deleted: 3, binary: 0, files: 3 },
			ahead: 1,
			behind: 10,
		},
	},
});
const catalogSource = {
	key: "fixture-catalog",
	load: async () => codexModelCatalog,
};
const noop = () => {};

function useLaunch(
	ownerKey: string,
	permissionMode: DureAgentRuntimeLaunchSelectionV1["permissionMode"] = "default",
): AgentRuntimeLaunchSelectionView {
	const [settings, setSettings] = useState<DureAgentRuntimeLaunchSelectionV1>({
		model: null,
		effort: null,
		permissionMode,
	});
	return {
		...settings,
		ownerKey,
		loaded: true,
		hydrationError: false,
		switching: false,
		error: null,
		retryHydration: noop,
		dismissError: noop,
		switchSelection: async (update) => {
			const next = update(settings);
			setSettings({
				model: next.model,
				effort: next.effort,
				permissionMode: next.permissionMode ?? settings.permissionMode,
			});
			evidence.selections += 1;
			return { outcome: "applied" };
		},
	};
}

function ToolbarPane() {
	const [chat, setChat] = useState(false);
	const launch = useLaunch("fixture-toolbar");
	const presentation = useAgentLaunchControlsPresentation(launch);
	return (
		<div className="h-full bg-surface-pane" data-toolbar-fixture-pane>
			<AgentPanelToolbarFrame agent={agent} hmux presentFork={noop}>
				<AgentCredentialSwitcher
					provider="codex"
					accounts={[account]}
					currentAccount={account}
					followsGlobal={false}
					accountBusy={false}
					disabled={false}
					disabledTitle="Account"
					onSwitch={noop}
					onApplyNow={noop}
					onCancel={noop}
					onRemoteLogin={noop}
					onCopyToHost={noop}
					onManageAccounts={noop}
				/>
				<AgentLaunchSelectionControls
					provider="codex"
					launch={launch}
					busy={false}
					catalog={codexModelCatalog}
					catalogSource={catalogSource}
					presentation={presentation}
				/>
				<AgentRuntimeProfileSwitch
					target={chat ? "terminal" : "chat"}
					onSwitch={async () => {
						setChat(!chat);
						evidence.switches += 1;
					}}
				/>
				<AgentPanelWindowActions agent={agent} showDiff />
			</AgentPanelToolbarFrame>
		</div>
	);
}

function FormPane() {
	const [value, setValue] = useState("recent");
	return (
		<div className="w-56 p-4">
			<SelectField
				aria-label="Tab order"
				value={value}
				onValueChange={setValue}
			>
				<SelectOption value="recent">Most recent</SelectOption>
				<SelectOption value="name">Name</SelectOption>
			</SelectField>
		</div>
	);
}

const ready = async () => {};
const chatSession: AgentChatSessionView = {
	draftIdentity: {
		agentId: "chat-fixture",
		backendProfileId: "local",
		interactionSessionId: "chat-session",
	},
	phase: "ready",
	reconnecting: false,
	sending: false,
	retryTurnAvailable: false,
	interrupting: false,
	loadingOlder: false,
	queuedMessages: [],
	page: {
		binding: {
			schemaVersion: 1,
			interactionSessionId: "chat-session",
			agentId: "chat-fixture",
			providerId: "codex",
			executionProfile: { kind: "provider_default" },
			providerConversationRef: null,
			runtime: { runtimeGeneration: "fixture", providerEpoch: "fixture" },
			timelineEpoch: "fixture",
			bindingRevision: 1,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
		rows: [],
		liveText: [],
		pendingRequests: [],
		activeTurn: null,
		latestFailure: null,
		finalCursor: { epoch: "fixture", sequence: 0 },
		hasMore: false,
	},
	retryConnection: noop,
	loadOlder: ready,
	send: ready,
	retryTurn: ready,
	editRetryableTurn: () => undefined,
	answerPending: ready,
	interrupt: ready,
	dismissActionError: noop,
	queueMessage: noop,
	steerOrQueue: async () => "queued",
	dequeueMessage: () => undefined,
};

function ChatPane() {
	const launch = useLaunch("fixture-chat", "skip_permissions");
	return (
		<div className="h-full" data-chat-fixture-pane>
			<AgentChatSurface
				session={chatSession}
				launchSelection={launch}
				catalogSource={catalogSource}
				typography={{ fontSize: 13, lineHeight: 1.5 }}
			/>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<DockviewReact
		className="dockview-theme-abyss size-full"
		components={{ toolbar: ToolbarPane, form: FormPane, chat: ChatPane }}
		onReady={({ api }) => {
			evidence.dock = api;
			api.addPanel({
				id: "toolbar",
				component: "toolbar",
				title: "Agent toolbar",
			});
			api.addPanel({
				id: "form",
				component: "form",
				title: "Form selector",
				position: { referencePanel: "toolbar", direction: "right" },
			});
			api.addPanel({
				id: "chat",
				component: "chat",
				title: "Chat composer",
				position: { referencePanel: "form", direction: "right" },
			});
		}}
	/>,
);
