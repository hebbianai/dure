// @vitest-environment jsdom

//
// 이 화면에서 조용히 무동작이 되기 쉬운 배선만 잡는다: 워크트리 토글, 고급의
// 워크트리 위치, 생성 후 setup 실행, 그리고 호출부가 지정한 프로젝트 선택.
// 전부 예전에 실제로 끊겨 있던 자리다.

import { chooseSelectValue, openSelect } from "@/test/select";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,

} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentRunPresentationWorktree, projectAgentRunWorkspace } from "@/lib/agents/agentRunWorkspacePresentation";
import { t } from "@/lib/i18n";
import { providerInstallCommand } from "@/lib/agents/providerInstallCommand";
import { createAgentRunBackendFixture } from "@/test/dureAgentRunFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent, Project, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	gitAvailability: vi.fn(),
	invoke: vi.fn(),
	openAgentPanelOnDesktop: vi.fn(),
	openCommandTerminalOn: vi.fn(),
	withDesktopDockview: vi.fn(),
	openRemoteSshTerminalOn: vi.fn(),
	requireProjectProvider: vi.fn(),
	listBranches: vi.fn(),
	scanWorktrees: vi.fn(),
	listExistingWorktrees: vi.fn(),
	inspectExistingWorktree: vi.fn(),
	recoverExistingWorktreeOwnership: vi.fn(),
	listDir: vi.fn(),
	listRemoteDir: vi.fn(),
	createSaga: vi.fn(),
	sagaReceipt: vi.fn(),
	runSpawnSaga: vi.fn(),
	presentManagedRun: vi.fn(),
	presentManagedRunInBackground: vi.fn(),
	ensureProjectForPath: vi.fn(),
	beginManagedRuntimeEnsure: vi.fn(),
	prepareRemoteAccountLogin: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/ipc/git", async (original) => ({
	...(await original<object>()),
	gitAvailability: mocks.gitAvailability,
}));
vi.mock("@/lib/agents/agentRegistration", () => ({
	addAgent: (...args: unknown[]) => addAgent(...args),
}));
vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	openAgentPanelOnDesktop: mocks.openAgentPanelOnDesktop,
	withDesktopDockview: mocks.withDesktopDockview,
	openRemoteSshTerminalOn: mocks.openRemoteSshTerminalOn,
}));
vi.mock("@/lib/workspace/dock/openCommandTerminal", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/openCommandTerminal")>()),
	openCommandTerminalOn: mocks.openCommandTerminalOn,
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	listBranches: mocks.listBranches,
	scanWorktrees: mocks.scanWorktrees,
	listExistingWorktrees: mocks.listExistingWorktrees,
	inspectExistingWorktree: mocks.inspectExistingWorktree,
	recoverExistingWorktreeOwnership: mocks.recoverExistingWorktreeOwnership,
	listDir: mocks.listDir,
	listRemoteDir: mocks.listRemoteDir,
	spawnJournal: {
		createSaga: mocks.createSaga,
		receipt: mocks.sagaReceipt,
	},
}));
vi.mock("@/lib/sessions/launch/spawnSaga", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/sessions/launch/spawnSaga")>()),
	runSpawnSagaFromCli: mocks.runSpawnSaga,
}));
vi.mock("@/lib/cli/cliManagedRunPresentation", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/cli/cliManagedRunPresentation")
	>()),
	presentManagedRun: mocks.presentManagedRun,
}));
vi.mock(
	"@/lib/cli/managedRunBackgroundPresentation",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/cli/managedRunBackgroundPresentation")
		>()),
		presentManagedRunInBackground: mocks.presentManagedRunInBackground,
	}),
);
vi.mock("@/lib/agents/providerPreflight", () => ({
	requireProjectProvider: mocks.requireProjectProvider,
}));
vi.mock("@/lib/sessions/launch/managedRuntimeEnsure", () => ({
	beginManagedRuntimeEnsure: mocks.beginManagedRuntimeEnsure,
}));
vi.mock("@/lib/agents/remoteAccountOverlay", async (original) => ({
	...(await original<object>()),
	prepareRemoteAccountLogin: mocks.prepareRemoteAccountLogin,
}));
vi.mock("@/lib/agents/agentInstalls", async (original) => ({
	...(await original<typeof import("@/lib/agents/agentInstalls")>()),
	useAvailableProviders: () => ["claude", "codex"],
}));

import { AddAgentBody } from "@/components/agents/addAgent/AddAgentBody";
import { useStore } from "@/store";

const repo: Project = {
	id: "project-repo",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const other: Project = {
	id: "project-other",
	name: "other",
	path: "/other",
	kind: "local",
	isRepo: true,
};

const homeLocation: Project = {
	id: "location-home",
	name: "jwan",
	path: "/Users/jwan",
	kind: "local",
	isRepo: false,
};

const createdAgent: Agent = {
	id: "agent-created",
	name: "claude-1",
	provider: "claude",
	projectId: repo.id,
	worktreePath: "/repo/.worktrees/feature",
	branch: "feature",
	sessionId: "agent-created",
	sessionKind: "pty",
};

const claudePersonal = {
	id: "account-claude-personal",
	provider: "claude" as const,
	name: "Personal",
	dir: "/credentials/claude-personal",
};

const claudeWork = {
	id: "account-claude-work",
	provider: "claude" as const,
	name: "Work",
	dir: "/credentials/claude-work",
};

const codexWork = {
	id: "account-codex-work",
	provider: "codex" as const,
	name: "Codex Work",
	dir: "/credentials/codex-work",
};

const ready = {
	ready: true,
	commandPath: "claude",
	resolvedPath: "/opt/homebrew/bin/claude",
	version: "claude 1.0.0",
	suggestedRecovery: [],
};

const existingWorktreeRef = {
	canonicalPath: "/repo/.worktrees/existing",
	gitCommonDir: "/repo/.git",
	gitDir: "/repo/.git/worktrees/existing",
	branch: "agent/existing",
	head: "0123456789abcdef0123456789abcdef01234567",
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** existingWorktreeRef 하나짜리 목록 응답 — ownership 상태만 시나리오별로 다르다. */
function worktreeListing(ownershipState: "unowned" | "ambiguous" = "unowned") {
	return {
		repository: { canonicalPath: "/repo", gitCommonDir: "/repo/.git" },
		worktrees: [
			{
				reference: existingWorktreeRef,
				isMain: false,
				ownership: { state: ownershipState },
			},
		],
		limit: 128,
		truncated: false,
	};
}

/** 공통 saga receipt 껍데기 — 시나리오는 state와 steps만 바꾼다. */
function sagaReceipt(
	state: "succeeded" | "failed",
	steps: Array<Record<string, unknown>>,
) {
	return {
		v: 1,
		receiptId: "sp_test",
		request: null,
		state,
		updatedAt: 0,
		steps,
	};
}

/** hostProjects[0]가 repo가 되도록 순서를 고정한다. */
const renderBody = (props: Partial<Parameters<typeof AddAgentBody>[0]> = {}) =>
	render(
		<AddAgentBody
			desktopId="desktop-1"
			initialHostId={null}
			onClose={vi.fn()}
			onBrowse={vi.fn()}
			onAddHost={vi.fn()}
			{...props}
		/>,
	);

const submitButton = () =>
	screen.getByRole("button", {
		name: new RegExp(`${t("agents.add.submit")}|${t("common.retry")}`),
	}) as HTMLButtonElement;

/** 이 저장소는 jest-dom 매처를 쓰지 않는다 — DOM 속성을 그대로 본다. */
const waitForSubmitEnabled = () =>
	waitFor(() => expect(submitButton().disabled).toBe(false));

const makeAddAgent = () => vi.fn().mockResolvedValue(createdAgent);
let addAgent: ReturnType<typeof makeAddAgent>;
let defaultBackend: ReturnType<typeof createAgentRunBackendFixture>;
const invokeMock = mocks.invoke;

function backendRequestBody(operation: string): Record<string, unknown> {
	const call = invokeMock.mock.calls.find(
		([command, arguments_]) =>
			command === "dure_backend_request" &&
			(arguments_ as { operation?: string }).operation === operation,
	);
	if (!call) throw new Error(`Expected a ${operation} backend request`);
	return (call[1] as { body: Record<string, unknown> }).body;
}

const commandDockApi = (addPanel = vi.fn()) => ({
	addPanel,
	panels: [{ id: "agent:existing" }],
	groups: [],
	activeGroup: undefined,
});

beforeEach(() => {
	// The existing-worktree/advanced flows are pro surfaces; basic (the
	// fresh store default) folds them.
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const, defaultAgentPane: "terminal" },
	}));
	vi.clearAllMocks();
	mocks.gitAvailability.mockReset().mockResolvedValue({ status: "available" });
	invokeMock.mockReset();
	defaultBackend = createAgentRunBackendFixture({ projectId: repo.id });
	invokeMock.mockImplementation(async (command, arguments_) => {
		const request = (arguments_ ?? {}) as {
			operation?: string;
			body?: Record<string, unknown>;
		};
		if (command === "git_exec") {
			return { stdout: `${"d".repeat(40)}\n`, stderr: "", code: 0 };
		}
		if (command === "dure_backend_route_assert") {
			return defaultBackend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		}
		if (
			command === "dure_backend_request" &&
			request.operation === "provider_launch_defaults.get"
		) {
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration: "generation-1",
				routeAuthority: testDureBackendRouteAuthority(
					"dure-local",
					"generation-1",
				),
				result: {
					schemaVersion: 1,
					document: {
						schemaVersion: 1,
						revision: 1,
						defaults: {},
						fingerprint: `sha256:${"d".repeat(64)}`,
					},
				},
			};
		}
		if (
			command === "dure_backend_request" &&
			request.operation === "provider_credential_profile.register"
		) {
			return {
				schemaVersion: 1,
				backendId: "dure-local",
				backendGeneration: "generation-1",
				routeAuthority: testDureBackendRouteAuthority(
					"dure-local",
					"generation-1",
				),
				result: {
					schemaVersion: 1,
					profile: {
						schemaVersion: 1,
						providerId: request.body?.providerId,
						referenceId: request.body?.referenceId,
						credentialGeneration: "credential-v1-fixture",
					},
				},
			};
		}
		if (
			command === "dure_backend_request" &&
			(request.operation === "agent_spawn.preview" ||
				request.operation === "agent_spawn.apply")
		) {
			return defaultBackend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		}
		throw new Error(`${command}:${request.operation ?? "unknown"}`);
	});
	mocks.requireProjectProvider.mockResolvedValue(ready);
	mocks.listBranches.mockResolvedValue([]);
	mocks.scanWorktrees.mockResolvedValue([]);
	mocks.listExistingWorktrees.mockResolvedValue(worktreeListing());
	mocks.inspectExistingWorktree.mockResolvedValue({
		reference: existingWorktreeRef,
		isMain: false,
		ownership: { state: "unowned" },
	});
	mocks.recoverExistingWorktreeOwnership.mockResolvedValue({
		state: "recovered",
		outcome: "owners_released",
	});
	// 최상위에 pnpm-lock.yaml이 있는 저장소 — setup 명령이 정해진다.
	mocks.listDir.mockResolvedValue([{ name: "pnpm-lock.yaml", isDir: false }]);
	mocks.listRemoteDir.mockResolvedValue([]);
	mocks.beginManagedRuntimeEnsure.mockReset().mockReturnValue(undefined);
	// 실제로는 데스크탑 마운트를 기다리지만, 테스트에서는 즉시 실행한다.
	mocks.withDesktopDockview.mockImplementation(
		(_desktopId: string, action: (api: unknown) => void) => action(commandDockApi()),
	);
	addAgent = makeAddAgent();
	mocks.createSaga.mockResolvedValue({ receiptId: "sp_test" });
	mocks.runSpawnSaga.mockResolvedValue(undefined);
	mocks.presentManagedRun.mockImplementation(async (raw) => {
		const request = raw as {
			agentId: string;
			agentName: string;
			providerId: Agent["provider"];
			executionProfile?:
				| { kind: "provider_default" }
				| {
						kind: "credential_reference";
						reference_id: string;
						credential_generation: string | null;
					};
			projectId: string;
			projectPath?: string;
			sessionId: string;
			workspaceId: string;
			worktree: AgentRunPresentationWorktree;
		};
		const credentialId =
			request.executionProfile?.kind === "credential_reference"
				? request.executionProfile.reference_id
				: undefined;
		const projectedProject =
			useStore
				.getState()
				.projects.find((candidate) => candidate.path === request.projectPath) ?? repo;
		const workspace = projectAgentRunWorkspace(request.worktree, projectedProject.path);
		useStore.setState((state) => ({
			agents: [
				...state.agents,
				{
					id: request.agentId,
					name: request.agentName,
					provider: request.providerId,
					projectId: projectedProject.id,
					worktreePath: workspace.path,
					branch: workspace.branch,
					sessionId: request.sessionId,
					sessionKind: "pty" as const,
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1" as const,
						source: "local" as const,
						hostId: "local" as const,
						sessionId: request.sessionId,
						workspaceId: request.workspaceId,
						...(credentialId ? { credentialId } : {}),
					},
					...(request.executionProfile
						? { accountId: credentialId ?? null, credentialId }
						: {}),
				},
			],
		}));
		return {
			ok: true,
			pane: {
				spaceId: "desktop-1",
				panelId: `agent:${request.agentId}`,
				agentId: request.agentId,
				sessionId: request.sessionId,
				workspaceId: request.workspaceId,
				runtime: "hmux_managed_v1",
				outcome: "created",
			},
		};
	});
	mocks.presentManagedRunInBackground.mockImplementation(
		async (run, target) => {
			await mocks.presentManagedRun({
				...(run as Record<string, unknown>),
				projectPath: (target as { projectPath: string }).projectPath,
			});
			const agent = useStore
				.getState()
				.agents.find(
					(candidate) => candidate.id === (run as { agentId: string }).agentId,
				);
			if (!agent) throw new Error("agent_run_projection_missing");
			return agent;
		},
	);
	mocks.sagaReceipt.mockResolvedValue(
		sagaReceipt("succeeded", [
			{
				step: "worktree",
				status: "ok",
				artifacts: [
					{
						kind: "worktree",
						id: createdAgent.worktreePath,
						disposition: "created",
					},
				],
			},
		]),
	);
	mocks.ensureProjectForPath.mockImplementation(async (path: string) =>
		path === other.path ? other : repo,
	);
	useStore.setState({
		projects: [repo, other],
		agents: [],
		accounts: [claudePersonal, claudeWork, codexWork],
		activeAccounts: { claude: claudePersonal.id, codex: codexWork.id },
		sshHosts: [],
		activeSpaceId: "desktop-1",
		spaces: [{ id: "desktop-1", name: "Main" }],
		providerLaunchDefaults: {
			schemaVersion: 1,
			revision: 1,
			defaults: {},
			fingerprint: `sha256:${"d".repeat(64)}`,
		},
		providerLaunchDefaultsBackend: {
			id: "dure-local",
			generation: "generation-1",
		},
		providerLaunchDefaultsProfileId: "local",
		legacySkipPermissions: undefined,
		ensureProjectForPath: mocks.ensureProjectForPath,
	});
});

afterEach(() => {
	cleanup();
});

describe("location", () => {
	it("blocks dedicated worktrees without Git but preserves explicit project-folder use", async () => {
		mocks.gitAvailability.mockResolvedValue({ status: "missing" });
		renderBody();
		await screen.findByText(t("panels.git.availability.missing"));
		expect(submitButton().disabled).toBe(true);
		expect(mocks.listBranches).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") }));
		await waitForSubmitEnabled();
		expect(mocks.runSpawnSaga).not.toHaveBeenCalled();
	});

	it("retains the requested worktree and branch while Git is installed and rechecked", async () => {
		mocks.gitAvailability.mockResolvedValueOnce({ status: "missing" }).mockResolvedValue({ status: "available" });
		renderBody();
		await screen.findByText(t("panels.git.availability.missing"));
		const query = screen.getByRole("textbox", { name: "" });
		fireEvent.change(query, { target: { value: "feature/kept" } });
		fireEvent.click(screen.getByRole("button", { name: t("panels.git.availability.recheck") }));
		await waitForSubmitEnabled();
		expect((query as HTMLInputElement).value).toBe("feature/kept");
		expect(screen.getByRole("switch", { name: t("agents.worktree.isolateDedicated") }).getAttribute("aria-checked")).toBe("true");
	});

	it("routes an empty SSH host location control to that host browser", () => {
		const remote: SshHostConfig = {
			id: "host-remote",
			name: "Remote",
			host: "remote.example.test",
			port: 22,
			user: "dev",
			auth: "auto",
		};
		const onBrowse = vi.fn();
		useStore.setState({ projects: [], sshHosts: [remote] });
		renderBody({ initialHostId: remote.id, onBrowse });

		fireEvent.click(
			screen.getByRole("button", { name: t("common.location") }),
		);

		expect(onBrowse).toHaveBeenCalledWith(remote.id);
	});
});

describe("managed runtime creation", () => {
	it.each([false, true])("waits for SSH creation before presenting and preserves retry (callback: %s)", async (withCallback) => {
		const host: SshHostConfig = {
			id: "host-remote",
			name: "Remote",
			host: "remote.example.test",
			port: 22,
			user: "dev",
			auth: "auto",
		};
		const project: Project = {
			id: "project-remote",
			name: "Remote folder",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: host.id,
			isRepo: false,
		};
		const agent: Agent = {
			id: "agent-remote",
			name: "claude-1",
			provider: "claude",
			projectId: project.id,
			worktreePath: project.path,
			branch: "",
			sessionId: "agent-remote",
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: host.id,
				sessionId: "agent-remote",
				workspaceId: project.id,
				createIdempotencyKey: "create-remote",
				commandBridgeNonce: "bridge-remote",
			},
		};
		const create = deferred<unknown>();
		const remoteAddAgent = vi.fn().mockResolvedValue(agent);
		addAgent = remoteAddAgent;
		mocks.ensureProjectForPath.mockResolvedValue(project);
		mocks.beginManagedRuntimeEnsure.mockReturnValue({
			source: "ssh",
			receipt: create.promise,
		});
		useStore.setState({
			projects: [project],
			sshHosts: [host],
			agents: [],
			ensureProjectForPath: mocks.ensureProjectForPath,
		});
		const onClose = vi.fn();
		const onCreated = withCallback ? vi.fn() : undefined;
		renderBody({ initialHostId: host.id, onClose, onCreated });
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(mocks.beginManagedRuntimeEnsure).toHaveBeenCalledWith(agent, {
				columns: 120,
				rows: 30,
			}),
		);
		expect(onClose).not.toHaveBeenCalled();
		expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
		if (onCreated) expect(onCreated).not.toHaveBeenCalled();

		await act(async () => {
			create.reject(new Error("remote create failed"));
		});

		await screen.findByText("Error: remote create failed");
		expect(onClose).not.toHaveBeenCalled();
		expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
		if (onCreated) expect(onCreated).not.toHaveBeenCalled();
		const launched = { ...agent, sessionId: "remote-successor" };
		mocks.beginManagedRuntimeEnsure.mockReturnValue({
			source: "ssh",
			receipt: Promise.resolve({ agent: launched }),
		});
		expect(submitButton().textContent).toContain(t("common.retry"));
		expect(screen.queryByRole("button", { name: t("agents.account.loginOnHost") })).toBeNull();
		fireEvent.click(submitButton());
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(remoteAddAgent).toHaveBeenCalledOnce();
		if (onCreated) {
			expect(onCreated).toHaveBeenCalledExactlyOnceWith(launched);
			expect(mocks.openAgentPanelOnDesktop).not.toHaveBeenCalled();
		} else {
			expect(mocks.openAgentPanelOnDesktop).toHaveBeenCalledExactlyOnceWith(
				expect.anything(), launched,
			);
		}
		expect(mocks.beginManagedRuntimeEnsure).toHaveBeenLastCalledWith(agent, {
			columns: 120,
			rows: 30,
		});
	});

	it.each([
		new Error("remote_credential_unavailable: remote profile has no credential"),
		"remote_credential_unavailable: remote profile has no credential",
		{ code: "remote_credential_unavailable" },
	])("offers login in the selected remote profile without creating another Agent (%s)", async (failure) => {
		const host: SshHostConfig = {
			id: "host-login", name: "Remote", host: "remote.example.test",
			port: 22, user: "dev", auth: "auto",
		};
		const project: Project = {
			...repo, id: "remote-login", kind: "ssh", sshHostId: host.id,
			path: "/srv/repo", isRepo: true,
		};
		const agent: Agent = {
			...createdAgent, projectId: project.id, provider: "codex",
			accountId: codexWork.id, worktreePath: "/srv/repo/.worktrees/feature", sessionKind: "ssh",
		};
		const register = vi.fn().mockResolvedValue(agent);
		addAgent = register;
		const create = deferred<unknown>();
		mocks.ensureProjectForPath.mockResolvedValue(project);
		mocks.beginManagedRuntimeEnsure.mockReturnValue({ source: "ssh", receipt: create.promise });
		mocks.prepareRemoteAccountLogin.mockResolvedValue("remote-login-command");
		mocks.listRemoteDir.mockResolvedValue([{ name: "pnpm-lock.yaml", isDir: false }]);
		useStore.setState({ projects: [project], sshHosts: [host], agents: [] });
		const onClose = vi.fn();
		renderBody({ initialHostId: host.id, initialProvider: "codex", onClose });
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());
		await waitFor(() => expect(mocks.beginManagedRuntimeEnsure).toHaveBeenCalledOnce());
		expect(mocks.openRemoteSshTerminalOn).toHaveBeenCalledOnce();
		expect(mocks.openRemoteSshTerminalOn).toHaveBeenCalledWith(
			expect.anything(), host.id, host.name, agent.worktreePath, undefined,
			expect.objectContaining({ commandLine: expect.stringMatching(/pnpm install$/) }),
		);
		await act(async () => create.reject(failure));
		fireEvent.click(await screen.findByRole("button", { name: t("agents.account.loginOnHost") }));
		await waitFor(() => expect(mocks.openRemoteSshTerminalOn).toHaveBeenCalledTimes(2));
		expect(mocks.prepareRemoteAccountLogin).toHaveBeenCalledWith(host, agent.worktreePath, codexWork);
		expect(mocks.openRemoteSshTerminalOn).toHaveBeenLastCalledWith(
			expect.anything(), host.id, host.name, agent.worktreePath, undefined,
			expect.objectContaining({ commandLine: "remote-login-command" }),
		);
		expect(onClose).toHaveBeenCalledOnce();
		expect(register).toHaveBeenCalledOnce();
		expect(mocks.beginManagedRuntimeEnsure).toHaveBeenCalledOnce();
	});
});

describe("canonical backend Run", () => {
	it("opens and copies provider setup guidance without losing the original Run", async () => {
		const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
		const copy = vi.fn().mockResolvedValue(undefined);
		const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
		Object.defineProperty(navigator, "clipboard", {
			configurable: true, value: { writeText: copy },
		});
		const originalInvoke = invokeMock.getMockImplementation()!;
		const applyBodies: unknown[] = [];
		let preview: unknown;
		let unavailable = true;
		invokeMock.mockImplementation(async (command, args) => {
			const request = args as { operation?: string; body?: unknown };
			if (command === "dure_backend_request") {
				if (request.operation === "agent_spawn.status") return preview;
				if (request.operation === "agent_spawn.apply") {
					applyBodies.push(request.body);
					if (unavailable) throw {
						code: "agent_spawn_provider_unavailable",
						message: "Provider executable not found.",
						details: { reasonCode: "provider_executable_not_found", disposition: "retry_same" },
					};
				}
			}
			const result = await originalInvoke(command, args);
			if (request.operation === "agent_spawn.preview") preview = result;
			return result;
		});
		const onClose = vi.fn();
		try {
			renderBody({ initialProvider: "claude", onClose });
			await waitForSubmitEnabled();
			await act(async () => { fireEvent.click(submitButton()); });
			expect(document.body.textContent).toContain(t("ipc.dureRun.providerNotFound"));
			const guide = screen.getByText(t("agents.add.installationGuide"));
			fireEvent.click(guide);
			const command = providerInstallCommand("claude", "macos")!;
			chooseSelectValue(screen.getByRole("combobox", { name: t("common.agent") }), "codex");
			// An edited selection does not relabel the failure or replace its Run.
			fireEvent.click(screen.getByRole("button", {
				name: t("onboarding.checklist.copyCommand", { command }),
			}));
			await waitFor(() => expect(copy).toHaveBeenCalledWith(command));
			fireEvent.click(guide);
			expect(onClose).not.toHaveBeenCalled();
			expect(mocks.openCommandTerminalOn).not.toHaveBeenCalled();
			expect(mocks.presentManagedRun).not.toHaveBeenCalled();
			expect(applyBodies).toHaveLength(1);
			unavailable = false;
			fireEvent.click(submitButton());
			await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
			expect(applyBodies).toHaveLength(2);
			expect(applyBodies[1]).toEqual(applyBodies[0]);
			expect(mocks.presentManagedRun).toHaveBeenCalledOnce();
		} finally {
			if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
			else Reflect.deleteProperty(navigator, "clipboard");
			platform.mockRestore();
		}
	});

	it("launches an existing branch through Run at the selected branch commit", async () => {
		mocks.listBranches.mockResolvedValue([{ name: "feature-existing" }]);
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		invokeMock.mockImplementation((command, arguments_) => {
			if (command === "git_exec") {
				const { args } = arguments_ as { args: string[] };
				return Promise.resolve({
					stdout: (args[2] === "refs/heads/feature-existing^{commit}"
						? "b"
						: "a"
					).repeat(40),
					stderr: "",
					code: 0,
				});
			}
			return backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		});
		useStore.setState({ accounts: [], activeAccounts: {} });
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.change(
			await screen.findByPlaceholderText("이름 · #1234 · 브랜치 · GitHub URL"),
			{ target: { value: "feature-existing" } },
		);
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());

		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(backend.operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
		]);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			worktree: {
				kind: "dedicated",
				branch: "feature-existing",
				branch_mode: "existing",
				base_commit_sha: "b".repeat(40),
			},
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(addAgent).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps the completed Run as a background projection when no Space is available", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		invokeMock.mockImplementation((command, arguments_) =>
			backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			),
		);
		useStore.setState({
			accounts: [],
			activeAccounts: {},
			spaces: [],
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(backend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(mocks.presentManagedRunInBackground).toHaveBeenCalledOnce();
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(addAgent).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("uses agent_spawn as the only writer for a compatible local launch", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		invokeMock.mockImplementation((command, arguments_) =>
			backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			),
		);
		useStore.setState({
			accounts: [],
			activeAccounts: {},
			spaces: [{ id: "desktop-1", name: "Main" }],
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(backend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		// Registration is admission-on-miss only (addAgentCanonicalRun.test.ts):
		// a project the backend already resolves must not pay a registration
		// round-trip, which would conflict with pre-registered roots.
		expect(invokeMock).not.toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({ operation: "projects.register" }),
		);
		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("pins the basic-mode launch to the PTY surface on the wire request", async () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
		renderBody();
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			interactionPreference: "native_cli",
		});
	});

	it("uses the selected Pro Chat preference in the actual new-agent request", async () => {
		useStore.setState((state) => ({ uiPrefs: { ...state.uiPrefs, interfaceMode: "pro", defaultAgentPane: "chat" } }));
		renderBody();
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());
		await waitFor(() => expect(defaultBackend.operations).toContain("agent_spawn.preview"));
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty("interactionPreference");
	});

	it("continues one durable Run to a pane after a recoverable launch failure", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		useStore.setState({ accounts: [], activeAccounts: {} });
		let applyCount = 0;
		invokeMock.mockImplementation(async (command, arguments_) => {
			const response = await backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
			const operation = (arguments_ as { operation?: string } | undefined)
				?.operation;
			if (operation !== "agent_spawn.apply") return response;
			applyCount += 1;
			if (applyCount !== 1) {
				return response;
			}
			const retry = structuredClone(response) as {
				result: {
					receipt: {
						state: string;
						lastSequence: number;
						completed: unknown[];
						recovery: Record<string, unknown>;
					};
				};
			};
			retry.result.receipt.state = "retry_required";
			retry.result.receipt.lastSequence = 5;
			retry.result.receipt.completed = [];
			retry.result.receipt.recovery = {
				kind: "retry_required",
				stage: "structured_launch",
				failed_attempt: 1,
				error_code: "claude_conversation_host_attach_failed",
				inputs: { stage: "structured_launch" },
			};
			return retry;
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(backend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
				"agent_spawn.apply",
			]),
		);
		expect(mocks.presentManagedRun).toHaveBeenCalledOnce();
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("reuses the frozen action after apply and status are both unreachable", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		const previewBodies: Record<string, unknown>[] = [];
		let loseFirstOutcome = true;
		invokeMock.mockImplementation(async (command, arguments_) => {
			const call = arguments_ as
				| { operation?: string; body?: Record<string, unknown> }
				| undefined;
			if (call?.operation === "agent_spawn.preview" && call.body) {
				previewBodies.push(structuredClone(call.body));
			}
			if (call?.operation === "agent_spawn.apply" && loseFirstOutcome) {
				await backend.invokeCommand(
					command,
					(arguments_ ?? {}) as Record<string, unknown>,
				);
				throw { code: "backend_transport_timeout", message: "response lost" };
			}
			if (call?.operation === "agent_spawn.status" && loseFirstOutcome) {
				loseFirstOutcome = false;
				throw { code: "backend_transport_unreachable", message: "offline" };
			}
			return backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		});
		useStore.setState({
			accounts: [],
			activeAccounts: {},
			spaces: [{ id: "desktop-1", name: "Main" }],
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());
		await waitFor(() => expect(loseFirstOutcome).toBe(false));
		await waitForSubmitEnabled();
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(submitButton());
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(previewBodies).toHaveLength(2);
		expect(previewBodies[1]).toEqual(previewBodies[0]);
	});

	it("reuses the completed Run when its projected Agent is still missing", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		const previewBodies: Record<string, unknown>[] = [];
		invokeMock.mockImplementation((command, arguments_) => {
			const call = arguments_ as
				| { operation?: string; body?: Record<string, unknown> }
				| undefined;
			if (call?.operation === "agent_spawn.preview" && call.body) {
				previewBodies.push(structuredClone(call.body));
			}
			return backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		});
		mocks.presentManagedRun.mockResolvedValue({
			ok: true,
			pane: { outcome: "created" },
		});
		useStore.setState({
			accounts: [],
			activeAccounts: {},
			spaces: [{ id: "desktop-1", name: "Main" }],
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());
		await waitFor(() => expect(previewBodies).toHaveLength(1));
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());
		await waitFor(() => expect(previewBodies).toHaveLength(2));

		expect(previewBodies[1]).toEqual(previewBodies[0]);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("reprepares after a pre-journal route resolution failure", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		let routeCalls = 0;
		invokeMock.mockImplementation((command, arguments_) => {
			if (command === "dure_backend_route_assert") {
				routeCalls += 1;
				if (routeCalls === 1) {
					return Promise.reject({
						code: "backend_transport_unreachable",
						message: "offline",
					});
				}
			}
			if (command === "git_exec") {
				return Promise.resolve({
					stdout: `${"d".repeat(40)}\n`,
					stderr: "",
					code: 0,
				});
			}
			return backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			);
		});
		useStore.setState({
			accounts: [],
			activeAccounts: {},
			spaces: [{ id: "desktop-1", name: "Main" }],
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());
		await waitFor(() => expect(routeCalls).toBe(1));
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(routeCalls).toBe(2);
		expect(backend.operations).toEqual([
			"agent_spawn.preview",
			"agent_spawn.apply",
		]);
	});

	it("keeps a structured-capable default dedicated launch free of setup", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		const baseCommit = "d".repeat(40);
		invokeMock.mockImplementation((command, arguments_) =>
			command === "git_exec"
				? Promise.resolve({ stdout: `${baseCommit}\n`, stderr: "", code: 0 })
				: backend.invokeCommand(
						command,
						(arguments_ ?? {}) as Record<string, unknown>,
					),
		);
		useStore.setState({ accounts: [], activeAccounts: {} });
		renderBody();
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(backend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		const previewCall = invokeMock.mock.calls.find(
			([, arguments_]) =>
				(arguments_ as { operation?: string }).operation ===
				"agent_spawn.preview",
		);
		if (!previewCall) throw new Error("Expected an agent_spawn.preview call");
		expect(
			(previewCall[1] as { body: Record<string, unknown> }).body,
		).toMatchObject({
			worktree: { kind: "dedicated", base_commit_sha: baseCommit },
		});
		expect(
			(previewCall[1] as { body: Record<string, unknown> }).body,
		).not.toHaveProperty("setupCommand");
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
	});
});

describe("워크트리 토글", () => {
	/** Switch가 바깥 button 안에 있으면 클릭이 두 번 반영돼 서로 상쇄된다.
	 *  실제로 그렇게 짜여 있었고 토글이 전혀 먹지 않았다. */
	it("스위치를 직접 눌러도 꺼진다", async () => {
		renderBody();
		const toggle = await screen.findByRole("switch", { name: "전용 워크트리에 격리" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");

		fireEvent.click(toggle);

		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
	});

	it("설명 줄을 눌러도 꺼진다", async () => {
		renderBody();
		const toggle = await screen.findByRole("switch", { name: "전용 워크트리에 격리" });

		fireEvent.click(screen.getByText("새 워크트리를 만들어 그 안에서 실행"));

		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
	});

	it("끄면 canonical Run에 project_root를 고정한다", async () => {
		renderBody();
		const toggle = await screen.findByRole("switch", { name: "전용 워크트리에 격리" });
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			worktree: { kind: "project_root" },
		});
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty(
			"setupCommand",
		);
		// Pro pins the PTY surface as well (owner decision 2026-09-01) — the
		// provider default no longer decides where a new agent lands.
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			interactionPreference: "native_cli",
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});
});

describe("기존 linked worktree", () => {
	it("목록 응답이 멈춰도 무한 로딩에 남지 않고 다시 시도할 수 있다", async () => {
		mocks.listExistingWorktrees.mockReturnValueOnce(new Promise(() => {}));
		renderBody();
		const existing = await screen.findByRole("radio", { name: "기존 워크트리" });
		vi.useFakeTimers();
		try {
			fireEvent.click(existing);
			expect(screen.getByText("워크트리 목록 불러오는 중…")).toBeTruthy();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(30_000);
			});

			expect(screen.queryByText("워크트리 목록 불러오는 중…")).toBeNull();
			const retry = screen.getByRole("button", { name: "워크트리 목록 다시 시도" });
			fireEvent.click(retry);
			await act(async () => {
				await Promise.resolve();
			});
			expect(mocks.listExistingWorktrees).toHaveBeenCalledTimes(2);
			openSelect(screen.getByRole("combobox", { name: "기존 워크트리" }));
			expect(
				screen.getByRole("option", { name: /agent\/existing/ }),
			).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("새 워크트리 계획이 linked checkout과 충돌하면 그 exact ref로 명시 전환한다", async () => {
		mocks.listBranches.mockResolvedValue([
			{ name: existingWorktreeRef.branch, checkedOutAt: existingWorktreeRef.canonicalPath },
		]);
		mocks.scanWorktrees.mockResolvedValue([
			{
				path: existingWorktreeRef.canonicalPath,
				branch: existingWorktreeRef.branch,
				isMain: false,
			},
		]);
		renderBody();
		const branch = await screen.findByPlaceholderText("이름 · #1234 · 브랜치 · GitHub URL");
		fireEvent.change(branch, { target: { value: existingWorktreeRef.branch } });

		const chooseExisting = await screen.findByRole("button", {
			name: "이 기존 워크트리 사용",
		});
		fireEvent.click(chooseExisting);

		const existing = screen.getByRole("radio", { name: "기존 워크트리" });
		expect((existing as HTMLInputElement).checked).toBe(true);
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "기존 워크트리" }).textContent,
			).toContain(existingWorktreeRef.canonicalPath),
		);
		expect(mocks.listExistingWorktrees).toHaveBeenCalledWith(
			repo.path,
			existingWorktreeRef.canonicalPath,
		);
	});

	it("요청한 exact ref 하나만 검사해 stale 점유의 명시 복구 경로를 연다", async () => {
		mocks.listExistingWorktrees.mockResolvedValueOnce(
			worktreeListing("ambiguous"),
		);
		mocks.inspectExistingWorktree.mockResolvedValueOnce({
			reference: existingWorktreeRef,
			isMain: false,
			ownership: {
				state: "stale_owned",
				claimReceiptId: "sp_stale",
				owners: [],
			},
		});
		renderBody();
		fireEvent.click(await screen.findByRole("radio", { name: "기존 워크트리" }));
		const selector = await screen.findByRole("combobox", {
			name: "기존 워크트리",
		});
		chooseSelectValue(selector, existingWorktreeRef.canonicalPath);
		fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));

		await waitFor(() =>
			expect(mocks.inspectExistingWorktree).toHaveBeenCalledWith(
				repo.path,
				existingWorktreeRef,
			),
		);
		expect(
			await screen.findByRole("button", {
				name: "stale 점유 복구 · existing",
			}),
		).toBeTruthy();
	});

	it("종료된 channel의 stale owner를 명시적으로 복구한 뒤 시작을 허용한다", async () => {
		mocks.listExistingWorktrees
			.mockResolvedValueOnce(worktreeListing("ambiguous"))
			.mockResolvedValueOnce(worktreeListing());
		mocks.inspectExistingWorktree.mockResolvedValueOnce({
			reference: existingWorktreeRef,
			isMain: false,
			ownership: {
				state: "stale_owned",
				owners: [
					{
						agentId: "agent-stale",
						provider: "codex",
						channel: "dev-retired",
						runtimeLiveness: "dead",
						paneLiveness: "dead",
					},
				],
			},
		});

		renderBody();
		fireEvent.click(await screen.findByRole("radio", { name: "기존 워크트리" }));
		chooseSelectValue(await screen.findByRole("combobox", { name: "기존 워크트리" }), existingWorktreeRef.canonicalPath);
		fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));

		const recover = await screen.findByRole("button", {
			name: "stale 점유 복구 · existing",
		});
		fireEvent.click(recover);

		await waitFor(() =>
			expect(mocks.recoverExistingWorktreeOwnership).toHaveBeenCalledWith(
				repo.path,
				existingWorktreeRef,
				undefined,
			),
		);
		await waitForSubmitEnabled();
	});

	it("keeps the selected existing checkout on the canonical Run path", async () => {
		renderBody();

		const fresh = await screen.findByRole("radio", { name: "새 워크트리" });
		expect((fresh as HTMLInputElement).checked).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: "기존 워크트리" }));

		const selector = await screen.findByRole("combobox", {
			name: "기존 워크트리",
		});
		chooseSelectValue(selector, existingWorktreeRef.canonicalPath);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			projectPath: repo.path,
			worktree: { kind: "existing_checkout", reference: existingWorktreeRef },
		});
		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(mocks.presentManagedRun).toHaveBeenCalledWith(
			expect.objectContaining({
				projectPath: repo.path,
				worktree: {
					kind: "existing_checkout",
					rootPath: existingWorktreeRef.canonicalPath,
					branch: existingWorktreeRef.branch,
				},
			}),
		);
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(addAgent).not.toHaveBeenCalled();
		expect(useStore.getState().agents.find((agent) => agent.id === "agent-run-1")).toMatchObject({
			projectId: repo.id, worktreePath: existingWorktreeRef.canonicalPath, branch: existingWorktreeRef.branch,
		});
	});

	it("allows an explicitly selected worktree that already has a live agent", async () => {
		mocks.listExistingWorktrees.mockResolvedValueOnce({
			repository: { canonicalPath: repo.path, gitCommonDir: `${repo.path}/.git` },
			worktrees: [
				{
					reference: existingWorktreeRef,
					isMain: false,
					ownership: {
						state: "live_owned",
						owners: [
							{
								agentId: "agent-researcher",
								provider: "codex",
								channel: "dev-researcher",
								runtimeLiveness: "live",
								paneLiveness: "live",
							},
						],
					},
				},
			],
			limit: 128,
			truncated: false,
		});
		renderBody();
		fireEvent.click(await screen.findByRole("radio", { name: "기존 워크트리" }));
		chooseSelectValue(await screen.findByRole("combobox", { name: "기존 워크트리" }), existingWorktreeRef.canonicalPath);

		await waitForSubmitEnabled();
		fireEvent.click(submitButton());

		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			worktree: { kind: "existing_checkout", reference: existingWorktreeRef },
			providerConversationRef: null,
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});

	it("does not run checkout setup over existing work", async () => {
		renderBody();
		fireEvent.click(await screen.findByRole("radio", { name: "기존 워크트리" }));
		chooseSelectValue(await screen.findByRole("combobox", { name: "기존 워크트리" }), existingWorktreeRef.canonicalPath);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty("setupCommand");
		expect(mocks.runSpawnSaga).not.toHaveBeenCalled();
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
	});

	it("keeps a rejected checkout selection visible without opening a pane", async () => {
		const invoke = invokeMock.getMockImplementation();
		invokeMock.mockImplementation(async (command, args) => {
			if (command === "dure_backend_request" && (args as { operation?: string })?.operation === "agent_spawn.preview") {
				throw new Error("worktree_identity_changed: selected checkout branch or HEAD changed");
			}
			return invoke?.(command, args);
		});
		renderBody();
		fireEvent.click(await screen.findByRole("radio", { name: "기존 워크트리" }));
		chooseSelectValue(await screen.findByRole("combobox", { name: "기존 워크트리" }), existingWorktreeRef.canonicalPath);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		expect(
			await screen.findByText(
				/selected checkout branch or HEAD changed/,
			),
		).toBeTruthy();
		expect(mocks.presentManagedRun).not.toHaveBeenCalled();
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});
});

describe("고급 · 워크트리 위치", () => {
	// The selected root must reach the backend, not fall back to .worktrees/.
	it("고른 위치가 실제 워크트리 경로에 반영된다", async () => {
		defaultBackend = createAgentRunBackendFixture({
			projectId: repo.id,
			checkoutRoot: "/canonical/repo/.claude/worktrees/destination-check",
		});
		const onClose = vi.fn();
		renderBody({ onClose });
		fireEvent.change(
			await screen.findByPlaceholderText("이름 · #1234 · 브랜치 · GitHub URL"),
			{ target: { value: "destination-check" } },
		);
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		chooseSelectValue(screen.getByRole("combobox", { name: "워크트리 위치" }), ".claude/worktrees/");
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			worktree: {
				kind: "dedicated",
				branch: "destination-check",
				checkout_path: "/repo/.claude/worktrees/destination-check",
			},
		});
		await waitFor(() => expect(mocks.presentManagedRun).toHaveBeenCalledOnce());
		expect(mocks.presentManagedRun).toHaveBeenCalledWith(
			expect.objectContaining({
				worktree: {
					kind: "dedicated",
					branch: "destination-check",
					directoryName: "destination-check",
					rootPath: "/canonical/repo/.claude/worktrees/destination-check",
				},
			}),
		);
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(addAgent).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe("고급 · 자격 증명", () => {
	it("고른 계정을 재개 가능한 생성 요청에 고정한다", async () => {
		renderBody();
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		const credential = screen.getByRole("combobox", { name: "자격 증명" });
		expect(credential.textContent).toBe(claudePersonal.name);

		chooseSelectValue(credential, claudeWork.id);
		await waitForSubmitEnabled();
		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		const operations = invokeMock.mock.calls.flatMap(([command, arguments_]) =>
			command === "dure_backend_request"
				? [(arguments_ as { operation: string }).operation]
				: [],
		);
		expect(operations).toEqual([
			"provider_credential_profile.register",
			"agent_spawn.preview",
			"agent_spawn.apply",
		]);
		expect(
			backendRequestBody("provider_credential_profile.register"),
		).toEqual({
			schemaVersion: 1,
			providerId: "claude",
			referenceId: claudeWork.id,
			profileDirectoryName: "claude-work",
		});
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			executionProfile: {
				kind: "credential_reference",
				reference_id: claudeWork.id,
				credential_generation: "credential-v1-fixture",
			},
		});
		await waitFor(() =>
			expect(mocks.presentManagedRun).toHaveBeenCalledWith(
				expect.objectContaining({
					executionProfile: expect.objectContaining({
						reference_id: claudeWork.id,
					}),
				}),
			),
		);
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});

	it("기본 계정 선택은 credential override 없이 canonical Run을 사용한다", async () => {
		const backend = createAgentRunBackendFixture({ projectId: repo.id });
		invokeMock.mockImplementation((command, arguments_) =>
			backend.invokeCommand(
				command,
				(arguments_ ?? {}) as Record<string, unknown>,
			),
		);
		renderBody();
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		chooseSelectValue(screen.getByRole("combobox", { name: "자격 증명" }), "");
		fireEvent.click(
			await screen.findByRole("switch", { name: "전용 워크트리에 격리" }),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(backend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		const previewCall = invokeMock.mock.calls.find(
			([, arguments_]) =>
				(arguments_ as { operation?: string }).operation ===
				"agent_spawn.preview",
		);
		if (!previewCall) throw new Error("Expected an agent_spawn.preview call");
		expect(
			(previewCall[1] as { body: Record<string, unknown> }).body,
		).not.toHaveProperty("credentialId");
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});

	it("provider를 바꾸면 이전 provider 계정을 남기지 않는다", async () => {
		renderBody();
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		const credential = screen.getByRole("combobox", { name: "자격 증명" });

		chooseSelectValue(screen.getByRole("combobox", { name: "에이전트" }), "codex");

		await waitFor(() =>
			expect(credential.textContent).toBe(codexWork.name),
		);
		openSelect(credential);
		expect(screen.queryByRole("option", { name: claudeWork.name })).toBeNull();
		fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
	});

	it("동기 생성 경로에도 같은 계정을 전달한다", async () => {
		const onCreated = vi.fn();
		renderBody({ onCreated });
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		chooseSelectValue(screen.getByRole("combobox", { name: "자격 증명" }), claudeWork.id);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
		expect(addAgent).not.toHaveBeenCalled();
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			executionProfile: {
				kind: "credential_reference",
				reference_id: claudeWork.id,
			},
		});
		expect(onCreated).toHaveBeenCalledWith(
			expect.objectContaining({ credentialId: claudeWork.id }),
		);
	});
});

describe("생성 후 setup 실행", () => {
	it("Codex keeps setup off by default so Chat remains eligible", async () => {
		renderBody({ initialProvider: "codex" });
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));

		expect(
			screen
				.getByRole("switch", { name: "생성 후 setup 실행" })
				.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("켜져 있으면 backend-owned worktree launch에 setup을 포함한다", async () => {
		renderBody();
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		fireEvent.click(screen.getByRole("switch", { name: "생성 후 setup 실행" }));
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			setupCommand: expect.stringMatching(/\.node-version[\s\S]*pnpm install$/),
		});
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
		expect(mocks.openCommandTerminalOn).not.toHaveBeenCalled();
	});

	it("structured-capable provider는 setup을 기본으로 끄고 pane을 열지 않는다", async () => {
		renderBody();
		fireEvent.click(await screen.findByRole("button", { name: /고급/ }));
		expect(
			screen
				.getByRole("switch", { name: "생성 후 setup 실행" })
				.getAttribute("aria-checked"),
		).toBe("false");
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty(
			"setupCommand",
		);
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
	});

	/** 워크트리를 끄면 cwd가 사용자의 본 체크아웃이다 — 요청하지도 않은
	 *  install이 거기서 돌면 안 된다(스위치는 접힌 고급 섹션 안에 있다). */
	it("워크트리를 끄면 본 체크아웃에서 setup을 돌리지 않는다", async () => {
		mocks.sagaReceipt.mockResolvedValue(
			sagaReceipt("succeeded", [{ step: "worktree", status: "skipped" }]),
		);
		renderBody();
		const toggle = await screen.findByRole("switch", { name: "전용 워크트리에 격리" });
		fireEvent.click(toggle);
		await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			worktree: { kind: "project_root" },
		});
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty(
			"setupCommand",
		);
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
	});

	/** 돌릴 것이 없으면 빈 명령으로 터미널만 띄우지 않는다. */
	it("setup 명령을 못 찾으면 pane을 열지 않는다", async () => {
		mocks.listDir.mockResolvedValue([{ name: "README.md", isDir: false }]);
		renderBody();
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).not.toHaveProperty(
			"setupCommand",
		);
		expect(mocks.withDesktopDockview).not.toHaveBeenCalled();
	});
});

describe("ordinary folder locations", () => {
	it("submits Home as the default location when no project is registered", async () => {
		const registeredHome = { ...homeLocation, id: "project-home" };
		const ensureProjectForPath = vi.fn().mockResolvedValue(registeredHome);
		useStore.setState({
			projects: [],
			ensureProjectForPath,
		});

		renderBody({ defaultProject: homeLocation });
		await waitForSubmitEnabled();

		expect(
			screen.getByRole("combobox", {
				name: "위치",
			}).textContent,
		).toBe(`${t("agents.location.home")}~`);
		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(ensureProjectForPath).toHaveBeenCalledWith(homeLocation.path, undefined),
		);
		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			projectPath: registeredHome.path,
			worktree: { kind: "project_root" },
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});
});

describe("selectProjectId", () => {
	/** 호출부가 확보한 프로젝트를 버리면 목록 첫 항목이 계속 선택돼 있어,
	 *  '이 폴더에 에이전트 추가'가 엉뚱한 프로젝트를 만든다. */
	it("호출부가 지정한 프로젝트를 고른다", async () => {
		renderBody({ selection: { projectId: other.id, seq: 1 } });

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: "위치" }).textContent,
			).toBe(`${other.name}${other.path}`),
		);
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			projectPath: other.path,
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});

	it("지정이 없으면 목록의 첫 프로젝트를 쓴다", async () => {
		renderBody();
		await waitForSubmitEnabled();

		fireEvent.click(submitButton());

		await waitFor(() =>
			expect(defaultBackend.operations).toEqual([
				"agent_spawn.preview",
				"agent_spawn.apply",
			]),
		);
		expect(backendRequestBody("agent_spawn.preview")).toMatchObject({
			projectPath: repo.path,
		});
		expect(mocks.createSaga).not.toHaveBeenCalled();
	});

	it("pre-selects the stored default agent in the provider control", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, defaultProvider: "codex" as const },
		}));
		renderBody();
		const control = screen.getByRole("combobox", {
			name: t("common.agent"),
		}) as HTMLButtonElement;
		expect(control.textContent).toBe("Codex");
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, defaultProvider: undefined },
		}));
	});
});

it("resolves an explicit Pro-only initial provider before offering a Basic launch", () => {
	useStore.setState({
		uiPrefs: {
			...useStore.getState().uiPrefs,
			interfaceMode: "basic",
			defaultProvider: "codex",
		},
	});
	renderBody({ initialProvider: "gemini" });
	expect(
		screen.getByRole("combobox", { name: t("common.agent") }).textContent,
	).toBe("Codex");
});
