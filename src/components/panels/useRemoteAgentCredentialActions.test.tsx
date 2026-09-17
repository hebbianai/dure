// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { useRemoteAgentCredentialActions } from "@/components/panels/useRemoteAgentCredentialActions";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	preflight: vi.fn(),
	prepareLogin: vi.fn(),
	copy: vi.fn(),
	openTerminal: vi.fn(),
	message: vi.fn(),
}));

vi.mock("@/lib/agents/remoteAccountOverlay", () => ({
	preflightRemoteAccountLaunch: mocks.preflight,
	prepareRemoteAccountLogin: mocks.prepareLogin,
}));
vi.mock("@/lib/ipc", () => ({
	hostToOpts: (host: { id: string }) => ({ hostId: host.id }),
	sshCopyAccount: mocks.copy,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openRemoteSshTerminalOn: mocks.openTerminal,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));

const host = {
	id: "host-a",
	name: "Build host",
	host: "build.example",
	user: "runner",
	port: 22,
	auth: "auto" as const,
};
const account = {
	id: "account-b",
	provider: "codex" as const,
	name: "Account B",
	dir: "/credentials/codex-account-b",
};
const agent = {
	id: "agent-1",
	provider: "codex",
	worktreePath: "/repo/worktree",
} as Agent;
const containerApi = {} as AgentPanelDockProps["containerApi"];

beforeEach(() => vi.resetAllMocks());

describe("remote Agent credential actions", () => {
	it("opens the shared login command only on an explicit action", async () => {
		mocks.prepareLogin.mockResolvedValue("profile-codex-login --device-auth");
		const actions = renderHook(() =>
			useRemoteAgentCredentialActions({ agent, host, containerApi }),
		);
		expect(mocks.prepareLogin).not.toHaveBeenCalled();
		await act(async () => actions.result.current.openRemoteLogin(account));
		expect(mocks.prepareLogin).toHaveBeenCalledWith(host, agent.worktreePath, account);
		expect(mocks.openTerminal).toHaveBeenCalledWith(
			containerApi,
			host.id,
			host.name,
			undefined,
			undefined,
			expect.objectContaining({ commandLine: "profile-codex-login --device-auth" }),
		);
		expect(mocks.copy).not.toHaveBeenCalled();
	});

	it("reports login preparation failure without copying credentials or opening a terminal", async () => {
		mocks.prepareLogin.mockRejectedValue(new Error("SSH connection closed"));
		const actions = renderHook(() =>
			useRemoteAgentCredentialActions({ agent, host, containerApi }),
		);
		await act(async () => actions.result.current.openRemoteLogin(account));
		expect(mocks.message).toHaveBeenCalledWith(
			"Error: SSH connection closed",
			expect.objectContaining({ kind: "error" }),
		);
		expect(mocks.openTerminal).not.toHaveBeenCalled();
		expect(mocks.copy).not.toHaveBeenCalled();
	});

	it("preflights and copies only after the user invokes the target action", async () => {
		mocks.preflight.mockResolvedValue(undefined);
		mocks.copy.mockResolvedValue(["auth.json"]);
		mocks.message.mockResolvedValue(undefined);
		const actions = renderHook(() =>
			useRemoteAgentCredentialActions({ agent, host, containerApi }),
		);

		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.copy).not.toHaveBeenCalled();
		await act(async () => actions.result.current.copyAccountToHost(account));

		expect(mocks.preflight).toHaveBeenCalledWith(
			host,
			"codex",
			"/repo/worktree",
			account,
			{ requireCredential: false },
		);
		expect(mocks.copy).toHaveBeenCalledWith(
			{ hostId: "host-a" },
			"codex",
			"/credentials/codex-account-b",
			expect.any(String),
		);
	});
});
