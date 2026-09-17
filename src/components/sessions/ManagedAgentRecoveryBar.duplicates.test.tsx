// @vitest-environment jsdom

import { chooseSelectValue } from "@/test/select";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { beginManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	resume: vi.fn(),
	fresh: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
	...(await original<typeof import("@/lib/ipc")>()),
	listConversations: mocks.list,
}));
vi.mock("@/lib/sessions/managed/managedConversationLaunch", () => ({
	recoverExitedManagedConversationPane: mocks.resume,
}));
vi.mock("@/lib/sessions/managed/managedAgentFreshStart", () => ({
	startFreshManagedAgentPane: mocks.fresh,
}));

import { ManagedAgentRecoveryBar } from "./ManagedAgentRecoveryBar";

const source = managedRehostAgentFixture(0);
const peer = {
	...managedRehostAgentFixture(1),
	id: "agent-peer",
	name: "linked-fork",
	conversationId: source.conversationId,
};
const availability = vi.fn();

function Harness() {
	const agent = useStore((state) =>
		state.agents.find((item) => item.id === source.id),
	);
	return (
		<ManagedAgentRecoveryBar
			agentId={source.id}
			panelId={`agent:${source.id}`}
			binding={
				agent?.runtimeBinding?.runtime === "hmux_managed_v1" &&
				agent.runtimeBinding.source === "local"
					? agent.runtimeBinding
					: undefined
			}
			onAvailabilityChange={availability}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([
		{ id: "child-conversation", title: "Fork", mtime: 1 },
	]);
	mocks.resume.mockResolvedValue("child-conversation");
	mocks.fresh.mockResolvedValue({});
	useStore.setState({
		agents: [source, peer],
		accounts: [],
		agentActivity: { [source.id]: "working", [peer.id]: "waiting" },
		hmuxSessionMetadata: {},
	});
});
afterEach(cleanup);

function review() {
	fireEvent.click(
		screen.getByRole("button", { name: t("sessions.duplicates.review") }),
	);
}

describe("duplicate conversation registration review", () => {
	it("does not offer alias repair during an already-owned credential transition", () => {
		const finish = beginManagedCredentialSwitchTransition(source.id);
		try {
			render(<Harness />);
			expect(
				screen.queryByRole("button", { name: t("sessions.duplicates.review") }),
			).toBeNull();
			expect(mocks.list).not.toHaveBeenCalled();
		} finally {
			act(finish);
		}
	});

	it("shows linked records on a working pane without scanning, mutation or dead-input state", async () => {
		render(<Harness />);
		expect(
			screen.getByText(t("sessions.duplicates.notice", { names: peer.name })),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: t("sessions.duplicates.review") }),
		).toBeTruthy();
		await act(async () => {});
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.resume).not.toHaveBeenCalled();
		expect(mocks.fresh).not.toHaveBeenCalled();
		expect(availability).toHaveBeenLastCalledWith(true, false);
		expect(useStore.getState().agents).toEqual([source, peer]);
	});

	it("requires review and an exact choice, then clears the notice after this registration changes", async () => {
		render(<Harness />);
		review();
		const picker = await screen.findByRole("combobox");
		expect(picker.textContent).toBe(t("sessions.exactResume.selectConversation"));
		expect(mocks.resume).not.toHaveBeenCalled();
		chooseSelectValue(picker, "child-conversation");
		fireEvent.click(
			screen.getByRole("button", {
				name: t("sessions.recovery.resumeExactConversation"),
			}),
		);
		await waitFor(() =>
			expect(mocks.resume).toHaveBeenCalledWith({
				agentId: source.id,
				panelId: `agent:${source.id}`,
				target: { kind: "id", id: "child-conversation" },
			}),
		);
		await act(async () =>
			useStore.setState({
				agents: [{ ...source, conversationId: "child-conversation" }, peer],
			}),
		);
		expect(
			screen.queryByText(t("sessions.duplicates.notice", { names: peer.name })),
		).toBeNull();
		expect(availability).toHaveBeenLastCalledWith(false, false);
		expect(useStore.getState().agents[1]).toBe(peer);
	});

	it("keeps a failed explicit fresh repair actionable without altering either registration", async () => {
		mocks.fresh.mockRejectedValue(new Error("exact source unavailable"));
		render(<Harness />);
		review();
		await screen.findByRole("combobox");
		fireEvent.click(
			screen.getByRole("button", { name: t("common.newConversation") }),
		);
		await screen.findByText(/exact source unavailable/);
		expect(mocks.fresh).toHaveBeenCalledWith(source.id, `agent:${source.id}`);
		expect(useStore.getState().agents).toEqual([source, peer]);
		expect(
			screen
				.getByRole("button", { name: t("common.newConversation") })
				.hasAttribute("disabled"),
		).toBe(false);
	});

	it("discards an old review and pending history results when the source generation changes", async () => {
		let finishHistory!: (
			value: Array<{ id: string; title: string; mtime: number }>,
		) => void;
		mocks.list.mockReturnValue(
			new Promise((resolve) => {
				finishHistory = resolve;
			}),
		);
		render(<Harness />);
		review();
		await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
		await act(async () =>
			useStore.setState({
				agents: [
					{
						...managedRehostAgentFixture(2),
						conversationId: source.conversationId,
					},
					peer,
				],
			}),
		);
		await act(async () =>
			finishHistory([{ id: "stale-choice", title: "Old history", mtime: 1 }]),
		);
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByText("Old history")).toBeNull();
		expect(
			screen.getByRole("button", { name: t("sessions.duplicates.review") }),
		).toBeTruthy();
		expect(mocks.resume).not.toHaveBeenCalled();
		expect(mocks.fresh).not.toHaveBeenCalled();
	});

	it("removes the notice when an explicit fresh replacement clears only this saved reference", async () => {
		mocks.fresh.mockImplementation(async () => {
			useStore.setState({
				agents: [
					{ ...managedRehostAgentFixture(2), conversationId: undefined },
					peer,
				],
			});
		});
		render(<Harness />);
		review();
		await screen.findByRole("combobox");
		fireEvent.click(
			screen.getByRole("button", { name: t("common.newConversation") }),
		);
		await waitFor(() =>
			expect(
				screen.queryByText(
					t("sessions.duplicates.notice", { names: peer.name }),
				),
			).toBeNull(),
		);
		expect(mocks.fresh).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[1]).toBe(peer);
		expect(useStore.getState().agentActivity[source.id]).toBe("working");
	});
});
