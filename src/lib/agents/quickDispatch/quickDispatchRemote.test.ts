import { beforeEach, expect, it, vi } from "vitest";
import type { CanonicalAddAgentRunPolicy } from "@/lib/agents/addAgentCanonicalRun";
import { agentFixture } from "@/test/agentFixtures";
import { remoteHmuxManagedBinding } from "@/lib/terminal/terminalBinding";

const mocks = vi.hoisted(() => ({
	add: vi.fn(),
	ensure: vi.fn(),
	send: vi.fn(),
	defaults: vi.fn(),
	open: vi.fn(),
}));
vi.mock("@/lib/agents/agentRegistration", () => ({ addAgent: mocks.add }));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensure,
}));
vi.mock("@/lib/sessions/managed/managedAgentInput", () => ({
	sendHmuxInitialAgentPrompt: mocks.send,
}));
vi.mock("@/lib/settings/providerLaunchDefaults", () => ({
	ensureProviderLaunchDefaultsProjection: mocks.defaults,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: mocks.open,
}));
import { useStore } from "@/store";
import { runRemoteQuickDispatch } from "./quickDispatchRemote";
import { quickDispatchRemoteTarget } from "./quickDispatchDefaults";

const host = {
	id: "host-a",
	name: "Build",
	host: "build.test",
	user: "dev",
	port: 22,
	auth: "auto" as const,
};
const project = {
	id: "project-a",
	name: "Repo",
	path: "/srv/repo",
	kind: "ssh" as const,
	sshHostId: host.id,
	isRepo: true,
};
const target = quickDispatchRemoteTarget(project, [host])!;
const policy: CanonicalAddAgentRunPolicy = {
	project,
	provider: "codex",
	agentName: "test",
	actionId: "qd_abc",
	accountId: null,
	useWorktree: false,
	setupCommand: null,
	prompt: "Do the work",
	model: "gpt-test",
	effort: "high",
	permissionOverride: "require_approvals",
};
const pane = { spaceId: "space", windowLabel: "main" };
const agent = agentFixture({
	id: "agent-qd_abc",
	name: "test",
	projectId: project.id,
	provider: "codex",
	worktreePath: project.path,
	sessionKind: "ssh",
	runtimeBinding: remoteHmuxManagedBinding(
		"session",
		"workspace",
		host.id,
		"bridge",
		"create",
	),
});
beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({ projects: [project], sshHosts: [host], agents: [] });
	mocks.add.mockImplementation(async () => {
		useStore.setState({ agents: [agent] });
		return agent;
	});
	mocks.ensure.mockResolvedValue({ agent, initialPromptAccepted: true });
});
it("awaits remote creation before presenting and forwards exact launch choices", async () => {
	let finish!: (value: unknown) => void;
	mocks.ensure.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const work = runRemoteQuickDispatch(policy, pane, target);
	await vi.waitFor(() => expect(mocks.ensure).toHaveBeenCalledOnce());
	expect(mocks.open).not.toHaveBeenCalled();
	const launched = { ...agent, sessionId: "returned-session" };
	finish({ agent: launched, initialPromptAccepted: true });
	await work;
	expect(mocks.add).toHaveBeenCalledWith(
		expect.objectContaining({
			id: "agent-qd_abc",
			projectId: project.id,
			skipPermissions: false,
		}),
	);
	expect(mocks.ensure).toHaveBeenCalledWith(
		agent,
		expect.objectContaining({
			initialPrompt: policy.prompt,
			launchOptions: {
				model: "gpt-test",
				effort: "high",
				permissionOverride: "require_approvals",
				setupCommand: undefined,
			},
		}),
	);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.open).toHaveBeenCalledWith("space", launched);
});
it("uses Host input when the provider cannot accept an argv prompt", async () => {
	mocks.ensure.mockResolvedValue({ agent, initialPromptAccepted: false });
	await runRemoteQuickDispatch(policy, pane, target);
	expect(mocks.send).toHaveBeenCalledWith(agent, policy.prompt);
	expect(mocks.send).toHaveBeenCalledAfter(mocks.open);
	expect(useStore.getState().agents[0].runtimeBinding).toHaveProperty(
		"initialPromptDigest",
		expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
	);
	expect(mocks.open).toHaveBeenCalledWith("space", agent);
});
it("replays completed input without sending the prompt twice", async () => {
	mocks.ensure.mockImplementation(async (current) => ({
		agent: current,
		initialPromptAccepted: Boolean(current.runtimeBinding.initialPromptDigest),
	}));
	await runRemoteQuickDispatch(policy, pane, target);
	await runRemoteQuickDispatch(policy, pane, target);
	expect(mocks.add).toHaveBeenCalledOnce();
	expect(mocks.send).toHaveBeenCalledOnce();
	expect(mocks.open).toHaveBeenCalledTimes(2);
});
it("retains registration across failure and deduplicates concurrent retries", async () => {
	mocks.ensure.mockRejectedValueOnce(new Error("offline"));
	await expect(runRemoteQuickDispatch(policy, pane, target)).rejects.toThrow(
		"offline",
	);
	expect(mocks.open).not.toHaveBeenCalled();
	await Promise.all([
		runRemoteQuickDispatch(policy, pane, target),
		runRemoteQuickDispatch(policy, pane, target),
	]);
	expect(mocks.add).toHaveBeenCalledOnce();
	expect(mocks.ensure).toHaveBeenCalledTimes(2);
	expect(mocks.open).toHaveBeenCalledOnce();
});
it("refuses host retargeting during launch preparation before registration", async () => {
	mocks.defaults.mockImplementation(async () =>
		useStore.setState({ sshHosts: [{ ...host, host: "other.test" }] }),
	);
	await expect(runRemoteQuickDispatch(policy, pane, target)).rejects.toThrow(
		"quick_dispatch_target_changed",
	);
	expect(mocks.add).not.toHaveBeenCalled();
	expect(mocks.ensure).not.toHaveBeenCalled();
});
