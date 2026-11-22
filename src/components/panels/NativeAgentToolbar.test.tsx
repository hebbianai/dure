// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NativeAgentToolbar,
	type NativeAgentToolbarRuntime,
} from "@/components/panels/NativeAgentToolbar";
import type { AgentLaunchSelectionSurface } from "@/lib/agents/agentLaunchSelectionSurface";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import {
	AGENT_TOOLBAR_CONTROLS,
	type AgentToolbarControlId,
	type AgentToolbarSurface,
	agentToolbarControlOffered,
} from "@/lib/workspace/pane/agentToolbarControls";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";

vi.mock("@/components/scm/useGitAvailability", () => ({
	useGitAvailability: () => ({ state: { status: "available" } }),
}));

const agent = managedAgentFixture({ runtimeBinding: hmuxManagedBinding("session-1", "workspace-1") });
const binding = hmuxManagedBinding("session-1", "workspace-1");

function launchSelection(): AgentLaunchSelectionSurface {
	return {
		presentation: {
			loaded: true,
			hydrationError: false,
			model: "gpt-fixture",
			effort: "high",
			permissionMode: "default",
			switching: false,
			error: null,
			observedModel: null,
			catalog: { offered: true, status: "idle" },
			modelOptions: [{ value: "gpt-fixture", label: "GPT Fixture" }],
			effortOptions: [{ value: "high", label: "High" }],
			permissionOptions: [{ value: "default", label: "Default" }],
		},
		run: vi.fn(async () => {}),
	};
}

/** Everything a pane supplies, so only the surface rule can remove a control. */
function completeRuntime(surface: AgentToolbarSurface): NativeAgentToolbarRuntime {
	return {
		surface,
		transitioning: false,
		setTransitioning: vi.fn(),
		conversationViewDisabled: false,
		presentFork: vi.fn(),
		account: {
			switch: vi.fn(async () => {}),
			applyPending: vi.fn(async () => {}),
			cancelPending: vi.fn(async () => {}),
		},
		view: {
			setView: vi.fn(async () => {}),
			requestChat: vi.fn(async () => {}),
			applyChatNow: vi.fn(async () => {}),
			cancelChat: vi.fn(async () => {}),
		},
		projectMove: { prepare: vi.fn() },
		launchSelection: launchSelection(),
		history: {
			actionLease: {
				busy: false,
				run: async (action: () => Promise<void>) => {
					await action();
					return true;
				},
			},
			activeConversationId: null,
			activity: "waiting",
			conversations: [],
			mutationAllowed: true,
			mutationDisabledTitle: "",
			onError: vi.fn(),
			onLoad: vi.fn(),
			onSwitchExisting: vi.fn(async () => {}),
			paneDesktopId: "desktop-1",
			panelId: "agent:agent-1",
			projectKind: "local",
			resuming: false,
		},
	};
}

function renderedControls(runtime: NativeAgentToolbarRuntime) {
	const { container } = render(
		<NativeAgentToolbar agent={agent} binding={binding} runtime={runtime} />,
	);
	const ids = [...container.querySelectorAll("[data-agent-toolbar-control]")]
		.map((node) => node.getAttribute("data-agent-toolbar-control"))
		.sort();
	cleanup();
	return ids;
}

function offeredOn(surface: AgentToolbarSurface): AgentToolbarControlId[] {
	return AGENT_TOOLBAR_CONTROLS.map((control) => control.id)
		.filter((id) => agentToolbarControlOffered(id, surface))
		.sort();
}

beforeEach(() => {
	useStore.setState((state) => ({
		uiPrefs: {
			...state.uiPrefs,
			interfaceMode: "pro" as const,
			hiddenToolbarControls: [],
		},
		agents: [agent],
		projects: [
			{
				id: agent.projectId,
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		accounts: [
			{ id: "account-1", provider: "codex", name: "Work", dir: "/a/work" },
		],
		gitStatuses: {},
		gitStatusErrors: {},
		sessionAgentRuntimeState: {},
	}));
});

afterEach(cleanup);

describe("NativeAgentToolbar surfaces", () => {
	it("renders every catalog control in the pane", () => {
		expect(renderedControls(completeRuntime("pane"))).toEqual(
			offeredOn("pane"),
		);
		expect(offeredOn("pane")).toEqual(
			AGENT_TOOLBAR_CONTROLS.map((control) => control.id).sort(),
		);
	});

	it("drops a control from the large window only by the catalog's rule", () => {
		// The same complete runtime: a control can leave the large window only
		// through its `largeWindow` rule, never through what a surface supplies.
		expect(renderedControls(completeRuntime("large_window"))).toEqual(
			offeredOn("large_window"),
		);
	});

	it("offers the account switch in the large window while its source pane is known", async () => {
		const { container } = render(
			<NativeAgentToolbar
				agent={agent}
				binding={binding}
				runtime={completeRuntime("large_window")}
			/>,
		);
		fireEvent.pointerDown(
			container.querySelector(
				'[data-agent-toolbar-control="account"] button',
			) as HTMLButtonElement,
			{ button: 0 },
		);
		const item = (await screen.findByText("Work")).closest(
			'[role="menuitemradio"], [role="menuitem"]',
		);
		expect(item?.getAttribute("aria-disabled")).not.toBe("true");
	});

	it("disables every source-pane control while the source pane is unknown", async () => {
		const { container } = render(
			<NativeAgentToolbar
				agent={agent}
				binding={binding}
				runtime={{
					...completeRuntime("large_window"),
					sourceUnavailableTitle: "source pane missing",
				}}
			/>,
		);
		const view = container.querySelector(
			'[data-agent-toolbar-control="view-switch"] button',
		) as HTMLButtonElement | null;
		expect(view?.disabled).toBe(true);
		const projectMove = container.querySelector(
			'[data-agent-toolbar-control="project-move"] button',
		) as HTMLButtonElement | null;
		expect(projectMove?.disabled).toBe(true);
		expect(projectMove?.title).toBe("source pane missing");
		// The account menu still opens for account management; only the
		// switch itself, which runs in the source pane, is unavailable.
		const account = container.querySelector(
			'[data-agent-toolbar-control="account"] button',
		) as HTMLButtonElement;
		fireEvent.pointerDown(account, { button: 0 });
		const item = (await screen.findByText("Work")).closest(
			'[role="menuitemradio"], [role="menuitem"]',
		);
		expect(item?.getAttribute("aria-disabled")).toBe("true");
	});
});
