import type { ProvisionedAgentWorktree } from "@/lib/agents/agentWorktreeProvision";
import type { WorktreePlan } from "@/lib/scm/worktrees/worktreePlan";
import type { Provider, TerminalEnvironment } from "@/types";

export interface AgentRegistrationOptions {
	projectId: string;
	name: string;
	provider: Provider;
	useWorktree: boolean;
	/** Saga resume authority: reuse a journaled agent id instead of minting. */
	id?: string;
	/** Initial provider account. null pins the provider default; undefined snapshots active. */
	accountId?: string | null;
	terminalEnv?: TerminalEnvironment;
	/** Dialog-selected plan. Omitted callers use the legacy agent/<name> plan. */
	worktreePlan?: WorktreePlan;
	/** Durable saga result. Its presence bypasses worktree provisioning. */
	provisionedWorktree?: ProvisionedAgentWorktree;
	/** 권한 확인 건너뛰기 — undefined면 전역 설정을 따른다. */
	skipPermissions?: boolean;
}
