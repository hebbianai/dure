// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureProjectForPath: vi.fn(),
	message: vi.fn(),
	showErrorToast: vi.fn(),
	prepare: vi.fn(),
	runPrepared: vi.fn(),
	addAgent: vi.fn(),
	ensureRuntime: vi.fn(),
	ensureDefaults: vi.fn(),
	openAgentPanel: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: mocks.message }));
vi.mock("@/lib/agents/agentRegistration", () => ({ addAgent: mocks.addAgent }));
vi.mock("@/lib/sessions/launch/managedRuntimeEnsure", () => ({
	beginManagedRuntimeEnsure: mocks.ensureRuntime,
}));
vi.mock("@/lib/settings/providerLaunchDefaults", () => ({
	ensureProviderLaunchDefaultsProjection: mocks.ensureDefaults,
}));
vi.mock("@/lib/toast", () => ({ showErrorToast: mocks.showErrorToast }));
vi.mock("@/components/spaces/useSpacesPaneState", () => ({
	ensureProjectForPath: mocks.ensureProjectForPath,
	readAccounts: () => [],
	readActiveAccountId: () => undefined,
	readAgents: () => [],
	readSpaceById: () => ({ id: "space-1", name: "Main" }),
	readSshHosts: () => [],
}));
vi.mock("@/lib/agents/addAgentCanonicalRun", () => ({
	prepareCanonicalAddAgentRun: mocks.prepare,
	runPreparedCanonicalAddAgentPresenting: mocks.runPrepared,
	shouldRetryCanonicalAddAgentAction: (cause: unknown) =>
		typeof cause === "object" &&
		cause !== null &&
		(cause as { details?: { retry?: string } }).details?.retry ===
			"same_intent",
	supportsCanonicalAddAgentRun: (policy: { project: { kind: string } }) =>
		policy.project.kind === "local",
}));
vi.mock("@/lib/workspace/dock", () => ({
	openLocalTerminalOn: vi.fn(),
	openRemoteSshTerminalOn: vi.fn(),
	withDesktopDockview: (_id: string, action: () => void) => action(),
	openAgentPanel: mocks.openAgentPanel,
}));
vi.mock("@/lib/workspace/window/windowLabel", () => ({
	spaceWindowLabel: () => "main",
}));

import { useRepositoryQuickAdd } from "@/components/spaces/useRepositoryQuickAdd";

const project = {
	id: "project-1",
	name: "Repo",
	path: "/repo",
	kind: "local" as const,
	isRepo: true,
};
const target = { label: "Repo", path: "/repo" };

describe("repository quick Add Agent action", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.ensureProjectForPath.mockResolvedValue(project);
		mocks.addAgent.mockResolvedValue({
			id: "remote-1",
			runtimeBinding: { runtime: "hmux_managed_v1", source: "ssh" },
		});
		mocks.ensureRuntime.mockReturnValue({
			source: "ssh",
			receipt: Promise.resolve({ agent: { id: "remote-1" } }),
		});
		mocks.openAgentPanel.mockReturnValue(true);
		mocks.ensureDefaults.mockResolvedValue(undefined);
		mocks.message.mockResolvedValue(undefined);
		mocks.prepare.mockImplementation(async (policy) => ({ policy }));
		mocks.runPrepared.mockResolvedValue({
			run: { agentId: "agent-1" },
			disposition: "pane",
		});
	});

	it("creates an SSH agent in the selected repository without opening options", async () => {
		mocks.ensureProjectForPath.mockResolvedValue({
			...project,
			kind: "ssh",
			sshHostId: "host-1",
		});
		const openDialog = vi.fn();
		const position = {
			referencePanel: "launcher:reserved",
			direction: "within",
		};
		const { result } = renderHook(() =>
			useRepositoryQuickAdd(openDialog, position),
		);
		await act(() =>
			result.current.onAddRepositoryAgent(
				"space-1",
				{ ...target, hostId: "host-1" },
				"codex",
			),
		);
		expect(mocks.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				provider: "codex",
				accountId: null,
				useWorktree: false,
			}),
		);
		expect(mocks.openAgentPanel).toHaveBeenCalledWith(
			"space-1",
			expect.objectContaining({ id: "remote-1" }),
			position,
		);
		expect(mocks.ensureRuntime).toHaveBeenCalledOnce();
		expect(openDialog).not.toHaveBeenCalled();
		expect(mocks.prepare).not.toHaveBeenCalled();
	});

	it("waits for remote creation before presenting the returned Agent", async () => {
		mocks.ensureProjectForPath.mockResolvedValue({
			...project,
			kind: "ssh",
			sshHostId: "host-1",
		});
		const launched = { id: "remote-1", sessionId: "remote-successor" };
		let complete!: (receipt: { agent: typeof launched }) => void;
		const receipt = new Promise<{ agent: typeof launched }>((resolve) => {
			complete = resolve;
		});
		mocks.ensureRuntime.mockReturnValue({ source: "ssh", receipt });
		const { result } = renderHook(() => useRepositoryQuickAdd(vi.fn()));
		const pending = result.current.onAddRepositoryAgent(
			"space-1", target, "codex",
		);
		try {
			await waitFor(() => expect(mocks.ensureRuntime).toHaveBeenCalledOnce());
			expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		} finally {
			await act(async () => {
				complete({ agent: launched });
				await pending;
			});
		}
		expect(mocks.openAgentPanel).toHaveBeenCalledExactlyOnceWith(
			"space-1", launched, undefined,
		);
	});

	it("retries the same SSH registration after a failed create", async () => {
		mocks.ensureProjectForPath.mockResolvedValue({
			...project,
			kind: "ssh",
			sshHostId: "host-1",
		});
		mocks.ensureRuntime.mockImplementationOnce(() => ({
			source: "ssh",
			receipt: Promise.reject(new Error("remote unavailable")),
		}));
		const { result } = renderHook(() => useRepositoryQuickAdd(vi.fn()));
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "codex"),
		);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "codex"),
		);
		expect(mocks.addAgent).toHaveBeenCalledOnce();
		expect(mocks.ensureRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.ensureRuntime.mock.calls[0]?.[0]).toBe(
			mocks.ensureRuntime.mock.calls[1]?.[0],
		);
		expect(mocks.showErrorToast).toHaveBeenCalledWith(
			expect.stringContaining("remote unavailable"),
		);
	});

	it("coalesces concurrent SSH clicks and creates a new agent after success", async () => {
		mocks.ensureProjectForPath.mockResolvedValue({
			...project,
			kind: "ssh",
			sshHostId: "host-1",
		});
		let complete!: (receipt: { agent: { id: string } }) => void;
		const receipt = new Promise<{ agent: { id: string } }>((resolve) => {
			complete = resolve;
		});
		mocks.ensureRuntime.mockReturnValue({ source: "ssh", receipt });
		const { result } = renderHook(() => useRepositoryQuickAdd(vi.fn()));
		const first = result.current.onAddRepositoryAgent(
			"space-1",
			target,
			"codex",
		);
		const second = result.current.onAddRepositoryAgent(
			"space-1",
			target,
			"codex",
		);
		await act(async () => {
			complete({ agent: { id: "remote-1" } });
			await Promise.all([first, second]);
		});
		expect(mocks.addAgent).toHaveBeenCalledOnce();
		expect(mocks.ensureRuntime).toHaveBeenCalledOnce();
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "codex"),
		);
		expect(mocks.addAgent).toHaveBeenCalledTimes(2);
	});

	it("still opens explicit options without registering an SSH agent", () => {
		const openDialog = vi.fn();
		const { result } = renderHook(() => useRepositoryQuickAdd(openDialog));
		act(() =>
			result.current.onAddRepositoryAgentWithOptions(
				"space-1",
				target,
				"codex",
			),
		);
		expect(openDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				desktopId: "space-1",
				initialPath: "/repo",
				initialProvider: "codex",
			}),
		);
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("reuses one prepared Run after an unknown outcome, then retires it on success", async () => {
		mocks.runPrepared.mockRejectedValueOnce(
			Object.assign(new Error("outcome unknown"), {
				details: { retry: "same_intent" },
			}),
		);
		const openDialog = vi.fn();
		const { result } = renderHook(() => useRepositoryQuickAdd(openDialog));

		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);

		expect(mocks.prepare).toHaveBeenCalledOnce();
		expect(mocks.runPrepared).toHaveBeenCalledTimes(2);
		expect(mocks.runPrepared.mock.calls[1]?.[0]).toBe(
			mocks.runPrepared.mock.calls[0]?.[0],
		);

		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);
		expect(mocks.prepare).toHaveBeenCalledTimes(2);
		expect(openDialog).not.toHaveBeenCalled();
	});

	it("retires a terminal failure so the next click is a new action", async () => {
		mocks.runPrepared.mockRejectedValueOnce(new Error("terminal failure"));
		const { result } = renderHook(() => useRepositoryQuickAdd(vi.fn()));

		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);

		expect(mocks.prepare).toHaveBeenCalledTimes(2);
		expect(mocks.runPrepared.mock.calls[1]?.[0]).not.toBe(
			mocks.runPrepared.mock.calls[0]?.[0],
		);
	});

	it("passes the reserved split slot to canonical presentation without using the active pane", async () => {
		const position = {
			referencePanel: "launcher:reserved",
			direction: "within",
		};
		const { result } = renderHook(() =>
			useRepositoryQuickAdd(vi.fn(), position),
		);
		await act(() =>
			result.current.onAddRepositoryAgent("space-1", target, "claude"),
		);
		expect(mocks.runPrepared).toHaveBeenCalledWith(expect.any(Object), {
			spaceId: "space-1",
			windowLabel: "main",
			position,
		});
	});

	it("settles a failed launch without waiting for native modal acknowledgement", async () => {
		let acknowledge: (() => void) | undefined;
		mocks.message.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					acknowledge = resolve;
				}),
		);
		mocks.prepare.mockRejectedValue(new Error("profile unavailable"));
		const { result } = renderHook(() => useRepositoryQuickAdd(vi.fn()));
		let settled = false;
		const action = result.current
			.onAddRepositoryAgent("space-1", target, "claude")
			.then(() => {
				settled = true;
			});
		try {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(settled).toBe(true);
			expect(mocks.message).not.toHaveBeenCalled();
			expect(mocks.showErrorToast).toHaveBeenCalledWith(
				expect.stringContaining("profile unavailable"),
			);
			expect(mocks.runPrepared).not.toHaveBeenCalled();
		} finally {
			acknowledge?.();
			await action;
		}
	});
});
