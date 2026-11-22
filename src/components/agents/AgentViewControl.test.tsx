// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentViewControl } from "@/components/agents/AgentViewControl";
import {
	type ChatHandoverSwitch,
	localNativeAgentViewPort,
	setNativeAgentView,
} from "@/lib/agents/chatHandoverRuntime";
import { t } from "@/lib/i18n";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";

const AGENT_ID = "agent-claude";

function sourceBusy(revision = 7) {
	const code = "agent_runtime_source_busy";
	return new DureAgentRuntimeSourceActiveError(
		new DureBackendRequestError(code, "busy", {
			schemaVersion: 1,
			kind: "invalid",
			code,
			message: "busy",
		} as never),
		revision,
	);
}

function Harness({
	onSwitch,
	onViewChange = (view) => setNativeAgentView(AGENT_ID, view),
}: {
	onSwitch: ChatHandoverSwitch;
	onViewChange?(view: "terminal" | "conversation"): void;
}) {
	const agent = useStore((state) =>
		state.agents.find((candidate) => candidate.id === AGENT_ID),
	);
	return (
		<AgentViewControl
			agentId={AGENT_ID}
			view={agent?.nativeView ?? "terminal"}
			pending={agent?.pendingChatHandover}
			conversationOffered
			conversationAvailable
			chatAvailable
			port={{
				...localNativeAgentViewPort(AGENT_ID, onSwitch),
				setView: async (view) => onViewChange(view),
			}}
		/>
	);
}

const trigger = () =>
	screen.getByRole("button", { name: t("agents.runtime.viewLabel") });
function openMenu() {
	fireEvent.pointerDown(trigger(), {
		button: 0,
		ctrlKey: false,
		pointerType: "mouse",
	});
}
const pending = () =>
	useStore.getState().agents.find((agent) => agent.id === AGENT_ID)
		?.pendingChatHandover;

beforeEach(() => {
	useStore.setState({
		agents: [
			managedAgentFixture({
				id: AGENT_ID,
				provider: "claude",
				sessionId: "session-claude",
			}),
		],
		sessionAgentRuntimeState: {
			"session-claude": {
				terminalEpoch: "epoch-1",
				revision: "4",
				observedThroughOutputSeq: "9",
				lifecycle: "running",
				activity: "working",
				attention: "none",
				source: "provider_event",
				turnCompletedCount: "2",
			},
		},
	});
});
afterEach(cleanup);

describe("AgentViewControl", () => {
	it("offers Terminal, Conversation and Chat in one menu", async () => {
		render(<Harness onSwitch={vi.fn()} />);
		openMenu();
		for (const name of [
			t("common.terminal"),
			t("agents.nativeChat.conversation"),
			t("agents.runtime.chatTarget"),
		]) {
			expect(await screen.findByRole("menuitemradio", { name })).toBeTruthy();
		}
	});

	it("shows 'switches when idle' for a busy agent instead of a discard prompt", async () => {
		const onSwitch = vi.fn().mockRejectedValueOnce(sourceBusy());
		render(<Harness onSwitch={onSwitch} />);
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		expect(
			(await screen.findByRole("status")).textContent,
		).toBe(t("agents.runtime.switchesWhenIdle"));
		expect(onSwitch).toHaveBeenCalledTimes(1);
		expect(onSwitch).toHaveBeenCalledWith("preserve");
		expect(pending()).toBeDefined();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(trigger().getAttribute("data-view-state")).toBe("pending");
	});

	it("switches an idle agent immediately", async () => {
		const onSwitch = vi.fn().mockResolvedValue(undefined);
		render(<Harness onSwitch={onSwitch} />);
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("preserve"));
		expect(pending()).toBeUndefined();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("cancels a scheduled switch, or stops the turn only after an explicit confirmation", async () => {
		const onSwitch = vi
			.fn()
			.mockRejectedValueOnce(sourceBusy())
			.mockRejectedValueOnce(sourceBusy(11))
			.mockResolvedValueOnce(undefined);
		render(<Harness onSwitch={onSwitch} />);
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		await screen.findByRole("status");

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("agents.runtime.interruptAndSwitchNow"),
			}),
		);
		const dialog = await screen.findByRole("dialog");
		expect(onSwitch).toHaveBeenCalledTimes(1);
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", {
					name: t("agents.runtime.discardSourceAction"),
				}),
			);
		});
		expect(onSwitch.mock.calls).toEqual([
			["preserve"],
			["preserve"],
			["discard", 11],
		]);
		await waitFor(() => expect(dialog.isConnected).toBe(false));
		expect(pending()).toBeUndefined();
	});

	it("drops a scheduled switch when the user picks a terminal view again", async () => {
		const onSwitch = vi.fn().mockRejectedValueOnce(sourceBusy());
		const onViewChange = vi.fn();
		render(<Harness onSwitch={onSwitch} onViewChange={onViewChange} />);
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		await screen.findByRole("status");
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", {
				name: t("agents.runtime.cancelScheduledSwitch"),
			}),
		);
		expect(pending()).toBeUndefined();

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		await waitFor(() => expect(pending()).toBeUndefined());
		onSwitch.mockRejectedValueOnce(sourceBusy());
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.runtime.chatTarget"),
			}),
		);
		await waitFor(() => expect(pending()).toBeDefined());
		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitemradio", {
				name: t("agents.nativeChat.conversation"),
			}),
		);
		expect(pending()).toBeUndefined();
		await waitFor(() =>
			expect(onViewChange).toHaveBeenCalledWith("conversation"),
		);
	});
});
