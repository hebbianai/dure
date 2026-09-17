// @vitest-environment jsdom
import { openSelect, chooseSelectValue } from "@/test/select";

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DelegateTaskControl } from "@/components/agents/DelegateTaskControl";
import { requestDelegateTaskDialog } from "@/lib/workspace/pane/paneMenuSignals";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	delegateOnce: vi.fn(),
	resolveWorkflowAction: vi.fn(),
}));

vi.mock("@/lib/agents/agentInstalls", () => ({
	useWorkflowDelegateProviders: () => ["codex", "claude"],
}));
vi.mock("@/components/plugins/usePluginViewCatalog", () => ({
	usePluginCatalog: () => ({ catalog: [{}] }),
}));
vi.mock("@/lib/plugins/durePlugins", () => ({
	pluginLocalizedText: (text: { default: string }) => text.default,
	uniquePluginWorkflowAction: mocks.resolveWorkflowAction,
}));
vi.mock("@/lib/workflows/delegateOnceRuntime", () => ({
	delegateOnceFromAgent: mocks.delegateOnce,
}));

const fence = {
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "terminal",
};

const agent: Agent = agentFixture({
	name: "coordinator",
	worktreePath: "/repo",
	branch: "agent/coordinator",
	sessionId: "coordinator-session",
	// Intentionally no createIdempotencyKey — keep the literal binding.
	runtimeBinding: {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId: "coordinator-session",
		workspaceId: "workspace-1",
		stopFence: fence,
	},
});

const existingTarget: Agent = {
	...agent,
	id: "agent-2",
	name: "existing-target",
	displayName: "Existing target",
	sessionId: "target-session",
	runtimeBinding: managedBindingFixture({
		sessionId: "target-session",
		createIdempotencyKey: "create-target",
		stopFence: { ...fence, terminalEpoch: "target-terminal" },
	}),
};

beforeEach(() => {
	localStorage.clear();
	useStore.setState({ agents: [agent, existingTarget] });
	mocks.delegateOnce.mockReset();
	mocks.delegateOnce.mockResolvedValue({ id: "agent-worker" });
	mocks.resolveWorkflowAction.mockReset();
	mocks.resolveWorkflowAction.mockReturnValue({
		contributionId: "dure.core.delegate-once",
		workflow: {
			title: { default: "작업 위임" },
			description: {
				default:
					"현재 작업공간에 worker 하나를 만들고 일반 에이전트 pane으로 엽니다.",
			},
		},
	});
});

afterEach(() => cleanup());

describe("DelegateTaskControl", () => {
	it("does not commit while closed for unrelated Agent updates and opens with current targets", () => {
		let commitCount = 0;
		render(
			<Profiler id="delegate-task" onRender={() => commitCount++}>
				<DelegateTaskControl
					agent={agent}
					desktopId="desktop-1"
					hiddenTrigger
					panelId="agent:agent-1"
				/>
			</Profiler>,
		);
		const settledCommitCount = commitCount;

		const updatedTarget = {
			...existingTarget,
			conversationId: "conversation-new",
		};
		act(() => useStore.setState({ agents: [agent, updatedTarget] }));
		expect(commitCount).toBe(settledCommitCount);

		const lateTarget: Agent = {
			...existingTarget,
			id: "agent-3",
			name: "late-target",
			displayName: "Late target",
			sessionId: "late-target-session",
			runtimeBinding: managedBindingFixture({
				sessionId: "late-target-session",
				createIdempotencyKey: "create-late-target",
				stopFence: { ...fence, terminalEpoch: "late-target-terminal" },
			}),
		};
		act(() =>
			useStore.setState({ agents: [agent, updatedTarget, lateTarget] }),
		);
		expect(commitCount).toBe(settledCommitCount);

		act(() => requestDelegateTaskDialog("agent:agent-1"));
		openSelect(screen.getByRole("combobox", {name: "대상"}));
		expect(screen.getByRole("option", { name: "Late target" })).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("listbox"), {key: "Escape"});
	});

	it("opens from the pane menu signal without occupying toolbar space", () => {
		render(
			<DelegateTaskControl
				agent={agent}
				desktopId="desktop-1"
				hiddenTrigger
				panelId="agent:agent-1"
			/>,
		);
		expect(screen.queryByRole("button", { name: "작업 위임" })).toBeNull();
		act(() => requestDelegateTaskDialog("agent:agent-1"));
		expect(screen.getByRole("dialog", { name: "작업 위임" })).toBeTruthy();
	});

	it("submits one bounded task from a local managed agent pane", async () => {
		render(<DelegateTaskControl agent={agent} desktopId="desktop-1" />);
		fireEvent.click(screen.getByRole("button", { name: "작업 위임" }));
		fireEvent.change(screen.getByLabelText("작업 이름"), {
			target: { value: "변경사항 검토" },
		});
		fireEvent.change(screen.getByLabelText("작업 설명"), {
			target: { value: "범위를 벗어나지 말고 결과를 보고하세요." },
		});
		chooseSelectValue(screen.getByLabelText("프로바이더"), "claude");
		fireEvent.click(screen.getByRole("button", { name: "worker 시작" }));

		await waitFor(() =>
			expect(mocks.delegateOnce).toHaveBeenCalledWith({
				contributionId: "dure.core.delegate-once",
				desktopId: "desktop-1",
				coordinator: agent,
				task: {
					summary: "변경사항 검토",
					instructions: "범위를 벗어나지 말고 결과를 보고하세요.",
				},
				providerId: "claude",
			}),
		);
	});

	it("selects one existing eligible Agent as the exact durable target", async () => {
		render(<DelegateTaskControl agent={agent} desktopId="desktop-1" />);
		fireEvent.click(screen.getByRole("button", { name: "작업 위임" }));
		chooseSelectValue(screen.getByLabelText("대상"), existingTarget.id);
		fireEvent.change(screen.getByLabelText("작업 이름"), {
			target: { value: "기존 pane 검토" },
		});
		fireEvent.change(screen.getByLabelText("작업 설명"), {
			target: { value: "현재 세션에서 결과를 durable Message로 보고하세요." },
		});
		fireEvent.click(screen.getByRole("button", { name: "기존 Agent에 할당" }));

		await waitFor(() =>
			expect(mocks.delegateOnce).toHaveBeenCalledWith({
				contributionId: "dure.core.delegate-once",
				desktopId: "desktop-1",
				coordinator: agent,
				task: {
					summary: "기존 pane 검토",
					instructions: "현재 세션에서 결과를 durable Message로 보고하세요.",
				},
				providerId: existingTarget.provider,
				target: existingTarget,
			}),
		);
	});

	it("fails closed when no task delegation contribution was negotiated", () => {
		mocks.resolveWorkflowAction.mockReturnValue(undefined);
		render(<DelegateTaskControl agent={agent} desktopId="desktop-1" />);
		const button = screen.getByRole("button", { name: "작업 위임" });
		expect(button.hasAttribute("disabled")).toBe(true);
		expect(button.getAttribute("title")).toBe(
			"작업 위임 확장을 찾지 못했습니다.",
		);
	});

	it("does not offer mutation from a standalone pane", () => {
		const standalone: Agent = {
			...agent,
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_standalone_v1",
				source: "local",
				hostId: "local",
				sessionId: "coordinator-session",
				workspaceId: "workspace-1",
			},
		};
		render(<DelegateTaskControl agent={standalone} desktopId="desktop-1" />);
		expect(
			screen
				.getByRole("button", { name: "작업 위임" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("keeps nested delegation disabled on a delegated worker", () => {
		render(
			<DelegateTaskControl
				agent={{
					...agent,
					workflowDispatch: {
						schemaVersion: 1,
						taskId: "task.one",
						dispatchId: "dispatch.one",
						generation: 1,
					},
				}}
				desktopId="desktop-1"
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: "작업 위임" })
				.hasAttribute("disabled"),
		).toBe(true);
	});
});
