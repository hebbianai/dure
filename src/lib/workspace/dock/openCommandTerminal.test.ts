import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createHmuxStandaloneTerminalOn: vi.fn(),
	showErrorToast: vi.fn(),
}));

vi.mock("@/lib/workspace/dock/standaloneShellTerminal", () => ({
	createHmuxStandaloneTerminalOn: mocks.createHmuxStandaloneTerminalOn,
}));

vi.mock("@/lib/toast", () => ({
	showErrorToast: mocks.showErrorToast,
}));

import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import type { DockviewApi } from "dockview-react";

const api = {} as DockviewApi;

beforeEach(() => {
	mocks.createHmuxStandaloneTerminalOn.mockReset().mockResolvedValue({
		sessionId: "term-1",
		workspaceId: "workspace-1",
	});
	mocks.showErrorToast.mockReset();
});

describe("openCommandTerminalOn", () => {
	it("runs the one-shot command as a standalone hmux session", async () => {
		openCommandTerminalOn(api, {
			title: "setup · pnpm install",
			command: "pnpm install",
			cwd: "/repo/.worktrees/agent",
			closeOnSuccess: true,
		});

		expect(mocks.createHmuxStandaloneTerminalOn).toHaveBeenCalledWith(
			api,
			"/repo/.worktrees/agent",
			undefined,
			undefined,
			undefined,
			{
				commandLine: "pnpm install",
				title: "setup · pnpm install",
				closeOnSuccess: true,
			},
		);
		await Promise.resolve();
		expect(mocks.showErrorToast).not.toHaveBeenCalled();
	});

	it("reports a failed command-session create instead of failing silently", async () => {
		mocks.createHmuxStandaloneTerminalOn.mockRejectedValue(
			new Error("hmux unavailable"),
		);

		openCommandTerminalOn(api, { title: "login", command: "codex login" });
		await vi.waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledOnce());
	});
});
