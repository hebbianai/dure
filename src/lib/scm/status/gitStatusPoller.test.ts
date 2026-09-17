// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDiffBadges } from "./diffBadgesStore";
import { startGitStatusPoller } from "./gitStatusPoller";

const fixture = vi.hoisted(() => ({
	agents: [] as {
		id: string;
		worktreePath: string;
		branch: string;
		sessionId: string;
	}[],
	status: vi.fn(),
	diff: vi.fn(),
	setStatus: vi.fn(),
	setError: vi.fn(),
	sshExec: vi.fn(),
	remoteHostId: null as string | null,
	background: false,
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({
			agents: fixture.agents,
			projects: [],
			sshHosts: [{ id: "host-1", host: "example.invalid" }],
			gitStatuses: {},
			activeSpaceId: "desktop",
			layouts: {},
			setGitStatus: fixture.setStatus,
			setGitStatusError: fixture.setError,
		}),
		subscribe: () => () => undefined,
	},
}));
vi.mock("@/lib/ipc", () => ({
	gitStatus: fixture.status,
	agentDiffStat: fixture.diff,
	hostToOpts: (host: { id: string }) => ({ hostId: host.id }),
	sshExecOnce: fixture.sshExec,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: () => {
		const panels = fixture.background
			? []
			: fixture.agents.map(({ id }) => ({
					id: `slot-${id}`,
					params: { agentRef: { agentId: id } },
					api: { component: "agent", getParameters: () => ({}) },
				}));
		return { panels, activePanel: panels[0] };
	},
}));
vi.mock("@/lib/workspace/layout/layoutLifecycle", () => ({
	panelsFromLayout: () => [],
}));
vi.mock("@/lib/terminal/terminalBinding", () => ({
	bindingForAgent: () =>
		fixture.remoteHostId
			? { source: "ssh", hostId: fixture.remoteHostId }
			: null,
}));
vi.mock("@/lib/agents/agentAttentionStore", () => ({
	useAgentAttention: { getState: () => ({ prune: vi.fn() }) },
}));

let stop: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	fixture.background = false;
	fixture.remoteHostId = null;
	fixture.status.mockResolvedValue({
		isRepo: true,
		branch: "feature",
		staged: 1,
		unstaged: 0,
		untracked: 0,
		ahead: 1,
		behind: 0,
	});
	fixture.diff.mockResolvedValue({
		baseRef: "main",
		mergeBase: "base",
		files: [],
		committedFiles: [],
		worktreeFiles: [],
		ahead: 1,
		behind: 0,
	});
	useDiffBadges.setState({ badges: {} });
});
afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

function agents(count: number, shared: boolean) {
	fixture.agents = Array.from({ length: count }, (_, index) => ({
		id: `agent-${index}`,
		sessionId: `session-${index}`,
		branch: "feature",
		worktreePath: `/fixture/worktree-${shared ? 0 : index}`,
	}));
}

it.each([1, 20])(
	"shares one diff observation across %i same-worktree consumers",
	async (count) => {
		agents(count, true);
		stop = startGitStatusPoller();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fixture.status).toHaveBeenCalledTimes(1);
		expect(fixture.diff).toHaveBeenCalledTimes(1);
		expect(Object.keys(useDiffBadges.getState().badges)).toHaveLength(count);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(fixture.diff).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.diff).toHaveBeenCalledTimes(2);
	},
);

it("observes distinct worktrees separately without a startup burst", async () => {
	agents(20, false);
	stop = startGitStatusPoller();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(fixture.diff).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(240_000);
	expect(new Set(fixture.diff.mock.calls.map(([path]) => path)).size).toBe(20);
	expect(Object.keys(useDiffBadges.getState().badges)).toHaveLength(20);
});

it("does no hidden-window Git work and respects the background interval", async () => {
	agents(20, true);
	fixture.background = true;
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
	stop = startGitStatusPoller();
	await vi.advanceTimersByTimeAsync(1_000_000);
	expect(fixture.status).not.toHaveBeenCalled();
	expect(fixture.diff).not.toHaveBeenCalled();
	vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
	document.dispatchEvent(new Event("visibilitychange"));
	await vi.advanceTimersByTimeAsync(10_000 + 599_999);
	expect(fixture.status).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(fixture.status).toHaveBeenCalledTimes(1);
	expect(fixture.diff).toHaveBeenCalledTimes(1);
});

const REMOTE_STATUS =
	"# branch.head feature\n# branch.ab +1 -2\n1 .M N... 100644 100644 100644 abc def src/a.ts\n? untracked.txt\n";
const REMOTE_DIFF = [
	"base origin/main\nmerge-base abc123\nab 1\t2\n",
	"@committed 1\n3\t1\tsrc/a.ts\0",
	"@worktree 2\n1\t0\tsrc/a.ts\x002\t0\tuntracked.txt\0",
	"@files 2\n4\t1\tsrc/a.ts\x002\t0\tuntracked.txt\0",
].join("");

it("publishes SSH worktree diff badges on the same cadence as local ones", async () => {
	agents(2, true);
	fixture.remoteHostId = "host-1";
	fixture.sshExec.mockImplementation(async (_opts, command: string) =>
		command.startsWith("git ")
			? { code: 0, stdout: REMOTE_STATUS, stderr: "" }
			: { code: 0, stdout: REMOTE_DIFF, stderr: "" },
	);
	stop = startGitStatusPoller();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(fixture.status).not.toHaveBeenCalled();
	expect(fixture.diff).not.toHaveBeenCalled();
	expect(fixture.sshExec).toHaveBeenCalledTimes(2);
	expect(fixture.sshExec.mock.calls[0]?.[0]).toEqual({ hostId: "host-1" });
	expect(fixture.setStatus).toHaveBeenCalledWith(
		"agent-0",
		expect.objectContaining({
			branch: "feature",
			ahead: 1,
			behind: 2,
			untracked: 1,
		}),
	);
	expect(useDiffBadges.getState().badges["agent-1"]).toMatchObject({
		committed: { files: 1 },
		worktree: { files: 2 },
		ahead: 1,
		behind: 2,
	});
	// Status refreshes at the focused cadence; the diff waits for its own.
	await vi.advanceTimersByTimeAsync(15_000);
	expect(fixture.sshExec).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(45_000);
	expect(fixture.sshExec).toHaveBeenCalledTimes(7);
});

it("skips the remote diff exec when the status exec already failed", async () => {
	agents(1, true);
	fixture.remoteHostId = "host-1";
	fixture.sshExec.mockResolvedValue({
		code: 255,
		stdout: "",
		stderr: "connect timed out",
	});
	stop = startGitStatusPoller();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(fixture.sshExec).toHaveBeenCalledTimes(1);
	expect(fixture.setError).toHaveBeenCalledWith(
		"agent-0",
		expect.stringContaining("connect timed out"),
	);
	expect(fixture.setStatus).not.toHaveBeenCalled();
});

it("clears the SSH badge when the remote diff fails but keeps the status", async () => {
	agents(1, true);
	fixture.remoteHostId = "host-1";
	useDiffBadges.getState().setBadge("agent-0", {
		added: 1,
		deleted: 0,
		binary: 0,
		files: 1,
		committed: { added: 1, deleted: 0, binary: 0, files: 1 },
		worktree: { added: 0, deleted: 0, binary: 0, files: 0 },
		ahead: 0,
		behind: 0,
	});
	fixture.sshExec.mockImplementation(async (_opts, command: string) =>
		command.startsWith("git ")
			? { code: 0, stdout: REMOTE_STATUS, stderr: "" }
			: { code: 3, stdout: "", stderr: "Could not find a base branch" },
	);
	stop = startGitStatusPoller();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(fixture.sshExec).toHaveBeenCalledTimes(2);
	expect(String(fixture.sshExec.mock.calls[1]?.[1])).toContain(
		"dure-diff-stat",
	);
	expect(fixture.setStatus).toHaveBeenCalledTimes(1);
	expect(fixture.setError).not.toHaveBeenCalled();
	expect(useDiffBadges.getState().badges["agent-0"]).toBeUndefined();
});
