// @vitest-environment jsdom

import { openSelect } from "@/test/select";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPermissionModeDialog } from "@/components/agents/AgentPermissionModeDialog";

const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	inspect: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@/lib/sessions/managed/managedAgentRehost", async () => {
	const actual = await vi.importActual<
		typeof import("@/lib/sessions/managed/managedAgentRehost")
	>("@/lib/sessions/managed/managedAgentRehost");
	return { ...actual, inspectManagedAgentRehost: mocks.inspect };
});
vi.mock("@/lib/toast", () => ({ showToast: mocks.toast }));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("Agent permission-mode dialog", () => {
	it("previews current mode, target mode, and restart impact before confirmation", async () => {
		const inspection = {
			agentId: "agent-1",
			agentName: "worker",
			providerId: "codex",
			permissionMode: "default",
			conversationId: "conversation-1",
			sourceBinding: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
			},
		} as never;
		mocks.inspect.mockResolvedValue(inspection);
		mocks.execute.mockResolvedValue({
			receipt: { targetMode: "skip_permissions" },
			pane: { sessionId: "session-new" },
		});
		const onOpenChange = vi.fn();
		render(
			<AgentPermissionModeDialog
				agent={{
					id: "agent-1",
					name: "worker",
					provider: "codex",
					projectId: "project-1",
					worktreePath: "/repo/worktree",
					branch: "agent/worker",
					sessionId: "session-old",
					sessionKind: "pty",
				}}
				panelId="agent:agent-1"
				open
				onOpenChange={onOpenChange}
				busy={false}
				execute={mocks.execute}
			/>,
		);

		expect(await screen.findByText("기본 권한 확인")).toBeTruthy();
		expect(
			screen.getByLabelText("대상 모드").textContent,
		).toBe("권한 확인 건너뛰기");
		openSelect(screen.getByLabelText("대상 모드"));
		expect(
			(
				screen.getByRole("option", {
					name: "기본 권한 확인",
				}) as HTMLElement
			).getAttribute("aria-disabled"),
		).toBe("true");
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		expect(
			screen.getByText("Provider 프로세스가 다시 시작됩니다"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"정확한 대화, worktree, 에이전트 pane, 활성 Task와 Dispatch 신원은 유지됩니다.",
			),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "에이전트 다시 시작" }));
		await waitFor(() =>
			expect(mocks.execute).toHaveBeenCalledWith(
				inspection,
				"skip_permissions",
			),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("previews the two-way switch back to default from skip permissions", async () => {
		const inspection = {
			agentId: "agent-1",
			agentName: "worker",
			providerId: "codex",
			permissionMode: "bypass_approvals",
			conversationId: "conversation-1",
			sourceBinding: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
			},
		} as never;
		mocks.inspect.mockResolvedValue(inspection);
		mocks.execute.mockResolvedValue({
			receipt: { targetMode: "default" },
			pane: { sessionId: "session-new" },
		});
		render(
			<AgentPermissionModeDialog
				agent={{
					id: "agent-1",
					name: "worker",
					provider: "codex",
					projectId: "project-1",
					worktreePath: "/repo/worktree",
					branch: "agent/worker",
					sessionId: "session-old",
					sessionKind: "pty",
					skipPermissions: true,
				}}
				panelId="agent:agent-1"
				open
				onOpenChange={() => {}}
				busy={false}
				execute={mocks.execute}
			/>,
		);

		const select = (await screen.findByLabelText(
			"대상 모드",
		)) as HTMLButtonElement;
		await waitFor(() => expect(select.textContent).toBe("기본 권한 확인"));
		openSelect(screen.getByLabelText("대상 모드"));
		expect(
			(
				screen.getByRole("option", {
					name: "권한 확인 건너뛰기",
				}) as HTMLElement
			).getAttribute("aria-disabled"),
		).toBe("true");
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
		fireEvent.click(screen.getByRole("button", { name: "에이전트 다시 시작" }));
		await waitFor(() =>
			expect(mocks.execute).toHaveBeenCalledWith(inspection, "default"),
		);
	});
});
