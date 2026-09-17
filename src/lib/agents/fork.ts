import { nanoid } from "nanoid";
import { conversationHistoryCredentialProfile } from "@/lib/agents/agentConversationHistory";
import {
	agentCredentialReferenceId,
	initialAgentRuntimeBinding,
} from "@/lib/agents/agentLaunchCredential";
import { registerAgentDurably } from "@/lib/agents/durableAgentRegistration";
import { providerForkInheritsConversation } from "@/lib/agents/providerForkCapability";
import {
	ProviderCredentialUnsupportedError,
	providerConversationForkStrategy,
	providerRunCmd,
	providerSupportsAccountProfiles,
} from "@/lib/agents/providers";
import { preflightRemoteAccountLaunch } from "@/lib/agents/remoteAccountOverlay";
import { t } from "@/lib/i18n";
import {
	type Conversation,
	copyClaudeSession,
	copyClaudeSessionCommand,
	createWorktree,
	hostToOpts,
	listConversations,
	sshExecOnce,
	sshListConversations,
	worktreeCommand,
} from "@/lib/ipc";
import { useStore } from "@/store";
import type { Agent, Provider } from "@/types";

/** 에이전트 포크: 소스 브랜치(커밋된 상태)에서 새 워크트리를 만들고,
 *  같은 프로바이더에 검증된 대화 분기 adapter가 있으면 선택한 pane의
 *  정확한 대화도 분기한다. 다른 경우에는 같은 코드 상태에서 새 대화로 시작한다.
 *  claude 세션 로그는 cwd별 저장이라 새 워크트리 경로로 복사해줘야
 *  --resume이 찾을 수 있다. exact resume만 있는 provider는 두 pane이 한
 *  mutable conversation identity를 공유하지 않도록 새 대화로 시작한다. */
export async function forkAgent(
	sourceId: string,
	provider: Provider,
): Promise<Agent> {
	const st = useStore.getState();
	const src = st.agents.find((a) => a.id === sourceId);
	if (!src) throw new Error(t("common.agentNotFound"));
	const project = st.projects.find((p) => p.id === src.projectId);
	if (!project) throw new Error(t("common.projectNotFound"));
	if (!project.isRepo) throw new Error(t("agents.worktree.notGitRepo"));
	const host =
		project.kind === "ssh"
			? st.sshHosts.find((h) => h.id === project.sshHostId)
			: undefined;
	if (project.kind === "ssh" && !host)
		throw new Error(t("common.sshHostNotFound"));
	const inheritedCredentialId =
		provider === src.provider ? agentCredentialReferenceId(src) : undefined;
	if (inheritedCredentialId && !providerSupportsAccountProfiles(provider)) {
		throw new ProviderCredentialUnsupportedError(provider);
	}
	const inheritedAccount = inheritedCredentialId
		? st.accounts.find(
				(account) =>
					account.id === inheritedCredentialId && account.provider === provider,
			)
		: undefined;
	if (inheritedCredentialId && !inheritedAccount) {
		throw new Error(
			`credential reference is unavailable: ${inheritedCredentialId}`,
		);
	}
	// The target provider and credential overlay must be ready before the first
	// remote worktree mutation. A failed remote preflight leaves no fork behind.
	if (project.kind === "ssh") {
		await preflightRemoteAccountLaunch(
			host!,
			provider,
			src.worktreePath,
			inheritedAccount,
			{ requireCredential: Boolean(inheritedAccount) },
		);
	}
	const conversationFork = providerForkInheritsConversation(
		src.provider,
		provider,
	)
		? providerConversationForkStrategy(provider)
		: undefined;
	const forkConversationId =
		provider === src.provider && conversationFork === "native_fork"
			? globalThis.crypto?.randomUUID?.()
			: undefined;
	if (
		provider === src.provider &&
		conversationFork === "native_fork" &&
		!forkConversationId
	) {
		throw new Error("secure_random_uuid_unavailable");
	}

	// A managed pane already has a Host-projected identity. Re-scanning the cwd
	// and choosing its newest record can select a sibling pane's conversation.
	// Compatibility records written before readiness existed may carry only the
	// exact id; an explicit pending/unavailable or mismatched projection blocks.
	let sourceConversationId: string | undefined;
	if (conversationFork) {
		const managed = src.runtimeBinding?.runtime === "hmux_managed_v1";
		const structured = src.interactionProfile?.kind === "structured_protocol";
		if (managed || structured) {
			sourceConversationId = src.conversationId?.trim() || undefined;
			const readiness = src.conversationIdentity;
			if (
				!sourceConversationId ||
				(managed &&
					readiness !== undefined &&
					(readiness.state !== "ready" ||
						readiness.conversationId !== sourceConversationId))
			) {
				throw new Error("fork_source_conversation_identity_required");
			}
		} else {
			let conversations: Conversation[] = [];
			try {
				const credentialProfile = conversationHistoryCredentialProfile({
					agent: src,
					accounts: st.accounts,
					remote: project.kind === "ssh",
				});
				conversations =
					project.kind === "local"
						? await listConversations(
								src.worktreePath,
								provider,
								credentialProfile,
							)
						: await sshListConversations({
								connectOpts: hostToOpts(host!),
								cwd: src.worktreePath,
								provider,
								credentialProfile,
							});
			} catch {
				// A same-provider fork must never silently degrade to a fresh session.
			}
			sourceConversationId = conversations[0]?.id.trim() || undefined;
			if (!sourceConversationId) {
				throw new Error("fork_source_conversation_identity_required");
			}
		}
	}

	// 이름 중복 회피: claude-1-fork, claude-1-fork-2, …
	const base = `${src.name}-fork`;
	let name = base;
	for (
		let n = 2;
		st.agents.some((a) => a.projectId === project.id && a.name === name);
		n++
	)
		name = `${base}-${n}`;

	// 1) 소스 브랜치에서 새 워크트리 생성 (미커밋 변경은 넘어가지 않는다)
	const from =
		src.branch && src.branch !== "(detached)" ? src.branch : undefined;
	let wtPath: string;
	let branch: string;
	if (project.kind === "local") {
		const wt = await createWorktree(project.path, name, from);
		wtPath = wt.path;
		branch = wt.branch;
	} else {
		const [cmd, p, b] = await worktreeCommand(project.path, name, from);
		const r = await sshExecOnce(hostToOpts(host!), cmd);
		if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim());
		wtPath = p;
		branch = b;
	}

	// 2) 같은 프로바이더면 위에서 고정한 소스 대화를 분기해서 첫 스폰 명령으로 지정
	let pendingCmd: string | undefined;
	let conversationId: string | undefined;
	let started = false;
	if (conversationFork && sourceConversationId) {
		if (conversationFork === "copy_and_flag") {
			if (project.kind === "local") {
				await copyClaudeSession(src.worktreePath, wtPath, sourceConversationId);
			} else {
				const cmd = await copyClaudeSessionCommand(
					src.worktreePath,
					wtPath,
					sourceConversationId,
				);
				const r = await sshExecOnce(hostToOpts(host!), cmd);
				if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim());
			}
		}
		pendingCmd =
			project.kind === "local"
				? providerRunCmd(provider, {
						convId: sourceConversationId,
						fork: true,
						forkConversationId,
					})
				: providerRunCmd(provider, {
						convId: sourceConversationId,
						fork: true,
						forkConversationId,
						account: inheritedAccount,
					});
		// Only adapters that accept our new identity may seed it at launch.
		// Codex/Claude generate the child identity themselves; persisting the
		// source ID here would alias two managed panes until the first hook.
		conversationId = forkConversationId;
		started = true;
	}

	const id = `agent-${nanoid(8)}`;
	const agent: Agent = {
		id,
		name,
		provider,
		projectId: project.id,
		worktreePath: wtPath,
		branch,
		sessionId: id,
		sessionKind: project.kind === "local" ? "pty" : "ssh",
		runtimeBinding: initialAgentRuntimeBinding({
			project,
			sessionId: id,
			credentialId: inheritedCredentialId,
		}),
		started,
		pendingCmd,
		terminalEnv: src.terminalEnv,
		accountId:
			provider === src.provider ? (inheritedCredentialId ?? null) : undefined,
		credentialId: inheritedCredentialId,
		conversationId,
	};
	const registered = await registerAgentDurably(agent, project);
	useStore.setState((state) => ({
		agentActivity: {
			...state.agentActivity,
			[registered.id]: state.agentActivity[registered.id] ?? "connecting",
		},
	}));
	return registered;
}
