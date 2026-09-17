// Agent registry store slice — the durable agent records plus the
// PATH-detected provider CLIs. Registration actions are composed outside the
// store so their durable projection recovery can safely depend on the store.
import { nanoid } from "nanoid";
import {
	buildInitialAgentRegistration,
	initialAgentRuntimeBinding,
	resolveAgentLaunchCredential,
} from "@/lib/agents/agentLaunchCredential";
import type { AgentRegistrationOptions } from "@/lib/agents/agentRegistrationTypes";
import { provisionAgentWorktree } from "@/lib/agents/agentWorktreeProvision";
import {
	sameAgentOperationalIdentity,
	sameProjectOperationalIdentity,
} from "@/lib/agents/resourceOperationalIdentity";
import { t } from "@/lib/i18n";
import { reorder } from "@/lib/persistence/storeCollections";
import type { AppStats } from "@/lib/settings/notifyPrefs";
import {
	type AccountProfile,
	type Agent,
	type AgentActivity,
	PROVIDERS,
	type Project,
	type Provider,
	type SshHostConfig,
} from "@/types";

export interface AgentRegistryStoreSlice {
	agents: Agent[];
	/** PATH에서 발견한 에이전트 CLI — 메뉴에 어떤 에이전트를 띄울지 정한다.
	 *  앱 시작 때 한 번 훑는다(persist 제외 — 기기 상태라 매번 새로 본다). */
	installedAgents: Provider[];

	setInstalledAgents: (providers: Provider[]) => void;
	moveAgent: (dragId: string, targetId: string) => void;
	markAgentStarted: (id: string) => void;
}

interface AgentRegistrationActions {
	addAgent: (opts: AgentRegistrationOptions) => Promise<Agent>;
	adoptAgent: (opts: {
		projectId: string;
		provider: Provider;
		worktreePath: string;
		branch: string;
		/** false면 세션 이어받기 대신 새 대화로 시작 (기본 true) */
		resume?: boolean;
	}) => Promise<Agent>;
}

/** Registration snapshots Projects, SSH Hosts, and launch credentials. */
type AgentRegistryHostState = AgentRegistryStoreSlice & {
	projects: Project[];
	sshHosts: SshHostConfig[];
	accounts: AccountProfile[];
	activeAccounts: Partial<Record<Provider, string>>;
	agentActivity: Record<string, AgentActivity>;
	stats: AppStats;
};

type SliceSet = (
	updater: (
		state: AgentRegistryHostState,
	) => AgentRegistryHostState | Partial<AgentRegistryHostState>,
) => void;

export function createAgentRegistryStoreSlice(
	set: SliceSet,
): AgentRegistryStoreSlice {
	return {
		agents: [],
		installedAgents: [],
		setInstalledAgents: (providers) =>
			set(() => ({ installedAgents: providers })),
		moveAgent: (dragId, targetId) =>
			set((s) => ({ agents: reorder(s.agents, dragId, targetId) })),
		markAgentStarted: (id) =>
			set((s) => ({
				agents: s.agents.map((a) =>
					a.id === id ? { ...a, started: true, pendingCmd: undefined } : a,
				),
			})),
	};
}

/** Prepare launch inputs, await durable registration and projection, then
 * recheck identity before publishing transient activity or acknowledging. */
export function createAgentRegistrationActions(
	set: SliceSet,
	get: () => AgentRegistryHostState,
	commitRegistration: (agent: Agent, project: Project) => Promise<Agent>,
): AgentRegistrationActions {
	const register = async (agent: Agent, project: Project): Promise<Agent> => {
		const registered = await commitRegistration(agent, project);
		const current = get();
		if (
			!sameAgentOperationalIdentity(
				current.agents.find((value) => value.id === registered.id),
				registered,
			) ||
			!sameProjectOperationalIdentity(
				current.projects.find((value) => value.id === project.id),
				project,
			)
		)
			throw new Error("Agent registration changed before launch");
		set((state) => ({
			agentActivity: {
				...state.agentActivity,
				[registered.id]: state.agentActivity[registered.id] ?? "connecting",
			},
		}));
		return registered;
	};
	return {
		addAgent: async ({
			id,
			projectId,
			name,
			provider,
			useWorktree,
			accountId,
			terminalEnv,
			worktreePlan,
			provisionedWorktree,
			skipPermissions,
		}) => {
			const state = get();
			const project = state.projects.find((p) => p.id === projectId);
			if (!project) throw new Error(t("common.projectNotFound"));
			const launchCredential = resolveAgentLaunchCredential({
				provider,
				requestedAccountId: accountId,
				activeAccountId: state.activeAccounts[provider],
				accounts: state.accounts,
			});

			// 워크트리 확보(로컬/SSH × 계획/레거시)는 lib로 추출 —
			// src/lib/agentWorktreeProvision.ts
			const { path: wtPath, branch } = await provisionAgentWorktree({
				project,
				name,
				useWorktree,
				worktreePlan,
				provisionedWorktree,
				sshHosts: state.sshHosts,
			});

			const agent = buildInitialAgentRegistration({
				id: id ?? `agent-${nanoid(8)}`,
				name,
				provider,
				project,
				worktreePath: wtPath,
				branch,
				terminalEnv,
				credential: launchCredential,
				skipPermissions,
			});
			return register(agent, project);
		},

		adoptAgent: async ({
			projectId,
			provider,
			worktreePath,
			branch,
			resume,
		}) => {
			const project = get().projects.find((p) => p.id === projectId);
			if (!project) throw new Error(t("common.projectNotFound"));

			const id = `agent-${nanoid(8)}`;
			const name = worktreePath.split("/").filter(Boolean).pop() ?? provider;

			// 세션은 에이전트 패널이 실측 크기로 만든다 (addAgent와 동일).
			// started: true → 첫 스폰이 resumeCmd로 실행되어 외부 세션을 이어받는다.
			// resume: false → 새 대화(cmd)로 시작 (세션이 없는 프로바이더 선택 시).
			const agent: Agent = {
				id,
				name,
				provider,
				projectId,
				worktreePath,
				branch,
				sessionId: id,
				sessionKind: project.kind === "local" ? "pty" : "ssh",
				runtimeBinding: initialAgentRuntimeBinding({
					project,
					sessionId: id,
					credentialId: PROVIDERS[provider].configEnv
						? get().activeAccounts[provider]
						: undefined,
				}),
				started: resume !== false,
				credentialId: PROVIDERS[provider].configEnv
					? get().activeAccounts[provider]
					: undefined,
			};
			return register(agent, project);
		},
	};
}
